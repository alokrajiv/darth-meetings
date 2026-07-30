import 'server-only';
import { spawn } from 'node:child_process';
import { getTranscript } from '@/lib/server/assemblyai';
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
 * Auto-generated meeting notes via headless Claude Code on this machine.
 *
 * We deliberately shell out to `claude -p` instead of using an API key:
 * the deploy VM has an authenticated Claude Code install, so summaries ride
 * on the existing subscription with zero key management. The transcript is
 * piped over stdin (no shell-arg length limits, nothing written to disk).
 *
 * Generation is fire-and-forget with a DB status machine
 * (auto_notes_status: null -> running -> completed | error) that the detail
 * page polls. A module-level in-flight set guards against double-spawns from
 * concurrent requests — fine for the single-process pm2 deployment.
 */

const CLAUDE_BIN = process.env.MW_CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.MW_CLAUDE_MODEL || ''; // empty = CLI default
const TIMEOUT_MS = 10 * 60 * 1000;

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

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text'];
    if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);

    const child = spawn(CLAUDE_BIN, args, {
      // Run from the storage dir, not the repo — headless mode denies tool
      // permission requests anyway, but don't even tempt it with a codebase.
      cwd: process.env.MW_STORAGE_DIR || process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`claude -p exited ${code}: ${(stderr || stdout).slice(0, 500)}`)
        );
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
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
  opts: { force?: boolean } = {}
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

    const started = Date.now();
    const raw = await runClaude(
      PROMPT_HEADER + attachmentContext + speakerContext + transcriptText
    );
    console.log(
      `[auto-notes] ${assemblyaiId}: generated ${raw.length} chars in ${Math.round((Date.now() - started) / 1000)}s`
    );

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
