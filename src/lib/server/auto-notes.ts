import 'server-only';
import { getTranscript } from '@/lib/server/assemblyai';
import { runClaudeWithMeta } from '@/lib/server/claude-agent';
import { recordAiRun, getLatestSessionId } from '@/db-ops/ai-runs';
import { findPeopleByEmails, type Person } from '@/db-ops/people';
import {
  getForUser,
  setAutoNotesForUser,
  setAutoSegmentsForUser,
  setCachedContentForUser,
  updateMetaForUser,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import {
  getForUser as getMappingsForUser,
  setSuggestionsForUser,
} from '@/db-ops/speaker-mappings';
import { listByTranscript as listAttachments } from '@/db-ops/transcript-attachments';
import type {
  SpeakerLabel,
  SpeakerSuggestionMap,
  TranscriptResponse,
  TranscriptSegment,
} from '@/lib/format';

/**
 * Auto-generated meeting notes via headless Claude Code (see claude-cli.ts).
 *
 * Generation is fire-and-forget with a DB status machine
 * (auto_notes_status: null -> running -> completed | error) that the detail
 * page polls. A module-level in-flight set guards against double-spawns from
 * concurrent requests — fine for the single-process pm2 deployment.
 */

const inFlight = new Set<string>();

const PROMPT_HEADER = `You are generating meeting notes from a diarized transcript.

The FIRST line of your output must be exactly:
TITLE: <a short, specific meeting title, max 60 characters, no quotes>

The SECOND line must be exactly:
SPEAKERS: <single-line JSON object, or {} if none>
Identify unnamed speakers ONLY from clear textual evidence in the transcript (self-introductions, being addressed by name, signing off). Keys are the raw speaker letters; values are {"name": "...", "evidence": "<short quote or reason>"}. Do not repeat speakers already identified in the context below, and never invent a name.

The THIRD line must be exactly:
SEGMENTS: <single-line JSON array>
Divide the meeting into 3-8 topical segments — natural stop points where the conversation shifts subject. Each entry is {"t": "<m:ss timestamp of the utterance where the segment starts, copied from the transcript>", "title": "<3-6 word section heading>"}. The first segment starts at 0:00. Prefer meaningful shifts (agenda item changes, decisions, demos) over even spacing.

Then a blank line, then the notes.

Write concise, well-structured meeting notes in Markdown with these sections (omit a section if the meeting genuinely has nothing for it):

## Summary
2-4 sentences on what the meeting was about and what was concluded.

## Key Points
Bulleted list of the substantive discussion points, grouped by topic. Attribute positions to speakers by name where it matters.

## Decisions
Bulleted list of decisions actually made (not proposals).

## Action Items
Bulleted list as "**Owner** — action (deadline if mentioned)". Use the speaker names given; if an owner is unclear, write "Unassigned".

## Open Questions
Anything explicitly left unresolved.

Rules: do not invent facts, names, or dates not present in the transcript. For speakers identified in the context below (confirmed names, strong voice matches, or your own text-evidence identifications), use their real names in the notes. Refer to any remaining unidentified speaker as "Speaker A" etc. Keep the notes under 600 words. Output ONLY the TITLE line, the SPEAKERS line, the SEGMENTS line, and the markdown notes — no preamble.

`;

/**
 * Speaker-identity context injected between the header and the transcript:
 * confirmed labels plus voiceprint matches with confidence. Lets the notes
 * use real names and gives Claude a base for its own context guesses.
 */
function buildSpeakerContext(
  labels: SpeakerLabel[],
  suggestions: SpeakerSuggestionMap
): string {
  const lines: string[] = [];
  for (const l of labels) {
    if (l.customName.trim()) {
      lines.push(
        `- Speaker ${l.originalSpeaker}: ${l.customName.trim()} (confirmed by a human${l.description.trim() ? `; context: ${l.description.trim()}` : ''})`
      );
    }
  }
  const named = new Set(labels.filter((l) => l.customName.trim()).map((l) => l.originalSpeaker));
  for (const [sp, s] of Object.entries(suggestions)) {
    if (named.has(sp)) continue;
    if (s.source === 'voice') {
      lines.push(
        `- Speaker ${sp}: very likely ${s.name} (${Math.round(s.confidence * 100)}% voice-fingerprint match) — treat as their identity unless the transcript contradicts it`
      );
    } else if (s.confidence > 0) {
      // Meet↔AAI timeline-alignment vote (source 'context' with a real
      // confidence — Claude's own prior text guesses carry confidence 0 and
      // are deliberately NOT fed back, to avoid self-reinforcement).
      lines.push(
        `- Speaker ${sp}: likely ${s.name} (${s.evidence ?? `${Math.round(s.confidence * 100)}% timeline overlap with Google Meet's transcript`}) — strong hint; verify against the transcript`
      );
    }
  }
  if (lines.length === 0) return 'Speaker identities: none known yet.\n\nTranscript follows:\n\n';
  return `Speaker identities established so far:\n${lines.join('\n')}\n\nTranscript follows:\n\n`;
}

/**
 * "Attached context" block: files/text the team attached to this transcript.
 * Grounds names, projects, and agenda items; the prompt makes clear the
 * transcript stays the source of truth. Total context capped so a big deck
 * can't crowd out the transcript itself.
 */
const MAX_CONTEXT_CHARS = 30_000;

async function buildAttachmentContext(transcriptRowId: number): Promise<string> {
  let attachments;
  try {
    attachments = await listAttachments(transcriptRowId);
  } catch (err) {
    console.warn('[auto-notes] attachment load failed (continuing without):', err);
    return '';
  }
  if (attachments.length === 0) return '';

  const parts: string[] = [];
  let budget = MAX_CONTEXT_CHARS;
  for (const a of attachments) {
    const label =
      a.kind === 'file'
        ? `${a.title}${a.original_filename && a.original_filename !== a.title ? ` (${a.original_filename})` : ''}`
        : a.title;
    const who = a.added_by_email ? ` — added by ${a.added_by_email}` : '';
    const text = (a.text_content ?? '').trim();
    if (!text) {
      parts.push(`--- ${label}${who} — content could not be extracted ---`);
      continue;
    }
    if (budget <= 0) break;
    const take = text.slice(0, budget);
    budget -= take.length;
    parts.push(`--- ${label}${who} ---\n${take}`);
  }

  return (
    `Additional context attached by the team (agendas, decks, docs). Use it to ground names, projects, terminology, and agenda items in the notes — but the TRANSCRIPT remains the sole source of truth for what was actually said and decided; never present context material as something said in the meeting.\n\n` +
    parts.join('\n\n') +
    '\n\n'
  );
}

/**
 * Cross-reference block: the Google Meet transcript of the SAME meeting,
 * kept as a sidecar on 'both'-mode imports. Two independent ASR engines make
 * different mistakes — this lets the notes pass resolve garbled words,
 * names, and terminology. Skipped when the row IS the Meet transcript.
 */
const MAX_CROSSREF_CHARS = 20_000;

function buildMeetCrossReference(row: TranscriptRow): string {
  if (row.assemblyai_id.startsWith('gmeet-')) return '';
  const meetUtterances = row.gmeet_context?.meetTranscript?.utterances;
  if (!meetUtterances || meetUtterances.length === 0) return '';

  let text = '';
  for (const u of meetUtterances) {
    const line = `${u.speaker}: ${u.text}\n`;
    if (text.length + line.length > MAX_CROSSREF_CHARS) break;
    text += line;
  }
  if (!text) return '';
  return (
    `For cross-checking only — an INDEPENDENT transcript of this same meeting generated by Google Meet. Its speaker names are real but device-level (people sharing one meeting-room mic appear as one name), and its wording differs where one engine mis-heard. Use it to resolve garbled words, names, and company/project terms in the primary transcript. The primary transcript below remains the source of truth for structure, timing, and attribution:\n\n` +
    text +
    '\n'
  );
}

/**
 * Team-directory block: who was invited / actually joined, enriched with
 * team + role from the Trames directory. Helps the notes attribute
 * positions correctly, spell names right, and understand reporting
 * relationships ("X's team", "the ops side") without inventing them.
 */
const MAX_PEOPLE_CHARS = 4_000;

async function buildPeopleContext(row: TranscriptRow): Promise<string> {
  const ctx = row.gmeet_context;
  if (!ctx) return '';

  // Invitees + actual joiners, deduped by email (fall back to name-only
  // for anonymous/room participants).
  const emails: string[] = [];
  const nameOnly: string[] = [];
  for (const a of ctx.attendees ?? []) {
    if (a.email) emails.push(a.email);
  }
  for (const p of ctx.actuals?.participants ?? []) {
    if (p.email) emails.push(p.email);
    else if (p.displayName) nameOnly.push(p.displayName);
  }
  if (emails.length === 0 && nameOnly.length === 0) return '';

  let directory = new Map<string, Person>();
  try {
    directory = await findPeopleByEmails(emails);
  } catch (err) {
    console.warn('[auto-notes] people lookup failed (continuing):', err);
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const email of emails) {
    const key = email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const p = directory.get(key);
    if (p) {
      const bits = [p.team && `team: ${p.team}`, p.role && `role: ${p.role}`]
        .filter(Boolean)
        .join(', ');
      lines.push(`- ${p.name} <${key}>${bits ? ` (${bits})` : ''}`);
    } else {
      lines.push(`- <${key}>`);
    }
  }
  for (const n of nameOnly) {
    lines.push(`- ${n} (joined without a signed-in account)`);
  }
  if (lines.length === 0) return '';

  let block = lines.join('\n');
  if (block.length > MAX_PEOPLE_CHARS) block = block.slice(0, MAX_PEOPLE_CHARS);
  return (
    `People on the calendar invite / who joined this meeting, with their team and role from the company directory. Use this to spell names correctly, resolve who "X" refers to, and understand team relationships — but only people evidenced in the transcript actually spoke:\n\n` +
    block +
    '\n\n'
  );
}

function buildTranscriptText(
  content: TranscriptResponse,
  labels: SpeakerLabel[]
): string {
  const nameFor = new Map(
    labels
      .filter((l) => l.customName.trim())
      .map((l) => [l.originalSpeaker, l.customName.trim()])
  );
  const lines = (content.utterances ?? []).map((u) => {
    const who = nameFor.get(u.speaker) ?? `Speaker ${u.speaker}`;
    const t = Math.floor(u.start / 1000);
    const stamp = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    return `[${stamp}] ${who}: ${u.text}`;
  });
  return lines.join('\n');
}

/** Fetch content from cache or AAI (caching it for future reads). */
export async function getContentCached(
  ownerUserId: string,
  row: TranscriptRow
): Promise<TranscriptResponse | null> {
  if (row.imported_content?.utterances?.length) return row.imported_content;
  try {
    const content = await getTranscript(row.assemblyai_id);
    if (content.status === 'completed') {
      void setCachedContentForUser(ownerUserId, row.assemblyai_id, content).catch(
        () => {}
      );
      return content;
    }
  } catch (err) {
    console.warn('[auto-notes] content fetch failed:', err);
  }
  return null;
}

/**
 * Generate notes for one transcript. Runs the full pipeline; errors land in
 * auto_notes_error. `force` regenerates even if notes already exist.
 */
export async function generateAutoNotes(
  ownerUserId: string,
  assemblyaiId: string,
  opts: {
    force?: boolean;
    /** Who clicked the button — recorded on the ai_runs stats row. */
    triggeredBy?: { userId: string; email: string };
  } = {}
): Promise<void> {
  const key = `${ownerUserId}:${assemblyaiId}`;
  if (inFlight.has(key)) return;

  const row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || row.status !== 'completed') return;
  if (!opts.force && (row.auto_notes_status === 'completed' || row.auto_notes_status === 'running')) {
    return;
  }

  inFlight.add(key);
  try {
    await setAutoNotesForUser(ownerUserId, assemblyaiId, { status: 'running' });

    const content = await getContentCached(ownerUserId, row);
    if (!content?.utterances?.length) {
      throw new Error('no utterances available for this transcript');
    }

    const mappings = await getMappingsForUser(ownerUserId, assemblyaiId);
    const labels = mappings?.speaker_labels ?? [];
    const existingSuggestions = mappings?.suggestions ?? {};
    const transcriptText = buildTranscriptText(content, labels);
    const speakerContext = buildSpeakerContext(labels, existingSuggestions);
    const attachmentContext = await buildAttachmentContext(row.id);
    const meetCrossRef = buildMeetCrossReference(row);
    const peopleContext = await buildPeopleContext(row);

    const prompt =
      PROMPT_HEADER + attachmentContext + meetCrossRef + peopleContext + speakerContext + transcriptText;

    // Incremental top-up: a forced regeneration (speaker renamed, context
    // file attached, …) resumes the prior session instead of resending the
    // whole transcript — the session already holds it, so the bulk of the
    // prompt is a cache read. Falls back to a fresh full run if the resume
    // fails (session file gone, expired, whatever). NOTE: assumes the
    // transcript text itself is unchanged; heavy transcript edits still get
    // fresh full runs because the top-up re-supplies context, not content.
    const priorSessionId = opts.force ? await getLatestSessionId(row.id) : null;
    const topUpPrompt =
      `The meeting data has been updated since you generated these notes (speaker identifications, attached context files, or the team directory may have changed). Regenerate the notes now, following EXACTLY the same output format as before: the TITLE line, the SPEAKERS line, the SEGMENTS line, a blank line, then the markdown notes.\n\n` +
      `Current context (supersedes earlier versions; the transcript itself is unchanged):\n\n` +
      attachmentContext +
      peopleContext +
      speakerContext.replace(/Transcript follows:\n\n$/, '');

    const started = Date.now();
    let raw: string;
    try {
      let run: Awaited<ReturnType<typeof runClaudeWithMeta>> | null = null;
      if (priorSessionId) {
        try {
          run = await runClaudeWithMeta(topUpPrompt, { resumeSessionId: priorSessionId });
          console.log(
            `[auto-notes] ${assemblyaiId}: top-up resume of session ${priorSessionId.slice(0, 8)}…`
          );
        } catch (resumeErr) {
          console.warn(
            `[auto-notes] ${assemblyaiId}: resume failed, falling back to full run:`,
            resumeErr
          );
        }
      }
      if (!run) run = await runClaudeWithMeta(prompt);
      raw = run.text;
      console.log(
        `[auto-notes] ${assemblyaiId}: generated ${raw.length} chars in ${Math.round((Date.now() - started) / 1000)}s` +
          (run.meta.costUsd != null ? ` ($${run.meta.costUsd.toFixed(4)}, ${run.meta.model ?? 'model?'})` : '')
      );
      void recordAiRun({
        transcriptId: row.id,
        assemblyaiId,
        kind: 'auto_notes',
        triggeredBy: opts.triggeredBy ?? null,
        status: 'completed',
        meta: run.meta,
        promptChars: prompt.length,
        resultChars: raw.length,
      });
    } catch (runErr) {
      void recordAiRun({
        transcriptId: row.id,
        assemblyaiId,
        kind: 'auto_notes',
        triggeredBy: opts.triggeredBy ?? null,
        status: 'error',
        error: String(runErr).slice(0, 1000),
        promptChars: prompt.length,
      });
      throw runErr;
    }

    // Header lines: "TITLE: ..." then "SPEAKERS: {...}" — split off both.
    let notes = raw;
    let generatedTitle: string | null = null;
    const titleMatch = raw.match(/^TITLE:\s*(.+)\s*\n+/);
    if (titleMatch) {
      generatedTitle = titleMatch[1]!.trim().slice(0, 120);
      notes = raw.slice(titleMatch[0].length).trim();
    }
    const speakersMatch = notes.match(/^SPEAKERS:\s*(\{.*\})\s*\n*/);
    if (speakersMatch) {
      notes = notes.slice(speakersMatch[0].length).trim();
      try {
        const guessed = JSON.parse(speakersMatch[1]!) as Record<
          string,
          { name?: string; evidence?: string }
        >;
        const named = new Set(
          labels.filter((l) => l.customName.trim()).map((l) => l.originalSpeaker)
        );
        // Re-read: the voice pass may have written fresh suggestions while
        // Claude was generating — merge on top of current state, not the
        // snapshot from before the run.
        const current =
          (await getMappingsForUser(ownerUserId, assemblyaiId))?.suggestions ??
          existingSuggestions;
        const merged: SpeakerSuggestionMap = { ...current };
        let added = 0;
        for (const [sp, g] of Object.entries(guessed)) {
          const name = typeof g?.name === 'string' ? g.name.trim().slice(0, 80) : '';
          // Context guesses never override a confirmed label or a voice match.
          if (!name || named.has(sp) || merged[sp]?.source === 'voice') continue;
          merged[sp] = {
            name,
            confidence: 0,
            source: 'context',
            evidence: typeof g?.evidence === 'string' ? g.evidence.slice(0, 300) : undefined,
          };
          added++;
        }
        if (added > 0) {
          await setSuggestionsForUser(ownerUserId, assemblyaiId, merged);
          console.log(
            `[auto-notes] ${assemblyaiId}: Claude identified ${added} speaker(s) from context`
          );
        }
      } catch (err) {
        console.warn(`[auto-notes] ${assemblyaiId}: bad SPEAKERS json:`, err);
      }
    }
    const segmentsMatch = notes.match(/^SEGMENTS:\s*(\[.*\])\s*\n*/);
    if (segmentsMatch) {
      notes = notes.slice(segmentsMatch[0].length).trim();
      try {
        const rawSegments = JSON.parse(segmentsMatch[1]!) as Array<{
          t?: string;
          title?: string;
        }>;
        const segments: TranscriptSegment[] = [];
        for (const s of rawSegments) {
          const title = typeof s?.title === 'string' ? s.title.trim().slice(0, 80) : '';
          const tm = typeof s?.t === 'string' ? s.t.trim().match(/^(?:(\d+):)?(\d+):(\d{2})$/) : null;
          if (!title || !tm) continue;
          const [, h, m, sec] = tm;
          const startMs =
            ((h ? parseInt(h, 10) * 3600 : 0) + parseInt(m!, 10) * 60 + parseInt(sec!, 10)) * 1000;
          segments.push({ title, start_ms: startMs });
        }
        segments.sort((a, b) => a.start_ms - b.start_ms);
        if (segments.length > 0) {
          await setAutoSegmentsForUser(ownerUserId, assemblyaiId, segments);
          console.log(`[auto-notes] ${assemblyaiId}: ${segments.length} segments`);
        }
      } catch (err) {
        console.warn(`[auto-notes] ${assemblyaiId}: bad SEGMENTS json:`, err);
      }
    }

    await setAutoNotesForUser(ownerUserId, assemblyaiId, {
      status: 'completed',
      notes,
      error: null,
    });

    // Auto-title only when the user hasn't set one — never clobber a
    // hand-written title (regenerations included: once set, it stays).
    if (generatedTitle && !row.title?.trim()) {
      await updateMetaForUser(ownerUserId, assemblyaiId, { title: generatedTitle });
      console.log(`[auto-notes] ${assemblyaiId}: auto-titled "${generatedTitle}"`);
    }
  } catch (err) {
    console.error(`[auto-notes] ${assemblyaiId}: failed:`, err);
    await setAutoNotesForUser(ownerUserId, assemblyaiId, {
      status: 'error',
      error: String(err).slice(0, 1000),
    }).catch(() => {});
  } finally {
    inFlight.delete(key);
  }
}
