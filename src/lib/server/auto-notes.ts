import 'server-only';
import { promises as fsp } from 'node:fs';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { logPayloadMissing } from '@/lib/server/aai-retention';
import { runClaudeWithMeta, parseJsonFromClaude } from '@/lib/server/claude-agent';
import { extractFrame, frameSourceFor, hasVideoStream, HIRES_FRAME_WIDTH } from '@/lib/server/video-frames';
import { localMsIn, resolveMeetingContent, type ResolvedMedia } from '@/lib/server/recordings';
import { recordAiRun, getLatestSessionId } from '@/db-ops/ai-runs';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { fetchRecordingFromDrive, fetchRecordingFromTeams } from '@/lib/server/recording-fetch';
import { findPeopleByEmails, searchPeople, type Person } from '@/db-ops/people';
import { recentVoiceVerdicts } from '@/lib/server/voiceprint';
import { recordingCallContext, recordingContextBlock } from '@/lib/server/recording-call-context';
import { combineFlagOn } from '@/db-ops/clips';
import { mergeIdPassGuesses } from '@/lib/speaker-id-merge';
import { onRoster, personNameKey } from '@/lib/person-identity';
import { rosterIsInformative, WEAK_VOICE_SCORE } from '@/lib/voiceprint-math';
import { clockOf, speakingMoments } from '@/lib/speaker-moments';
import { splitSpeakerLabel } from '@/lib/recording-clips';
import {
  getForUser,
  setAutoNotesForUser,
  setAutoReportForUser,
  setAutoSegmentsForUser,
  setSpeakerIdForUser,
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

Source hierarchy: the main transcript below is AssemblyAI voice-level diarization — the most accurate speaker separation and timing available, but with anonymous labels (A, B, C…). Identity comes from the speaker context (confirmed names, voiceprint matches, calendar participants). When a Google Meet/Teams transcript rides along as a cross-reference, it has real names but device-level attribution (a shared room mic looks like one person) — trust AssemblyAI for who-spoke-when and use the sidecar only to repair garbled words, names, and terminology.

Rules: do not invent facts, names, or dates not present in the transcript. For speakers identified in the context below (confirmed names, strong voice matches, or your own text-evidence identifications), use their real names in the notes. Refer to any remaining unidentified speaker as "Speaker A" etc. Keep the notes under 600 words. These notes are the QUICK summary — a fast, clean read. No images. No timestamps in headings and no play-by-play structure; organise by topic. You may attach a timestamp link to at most ~6 pivotal moments (a decision being made, an action item assigned) using EXACTLY this markdown form: [m:ss](t:<millisecond offset>) — e.g. [6:59](t:419000) — the UI turns these into click-to-jump chips. Output ONLY the TITLE line, the SPEAKERS line, the SEGMENTS line, and the markdown notes — no preamble.

`;

const REPORT_PROMPT = `You are writing a DETAILED REPORT of a meeting from its diarized transcript — the deep-dive companion to a short summary that already exists. Think of the output as a well-edited internal wiki article someone reads INSTEAD of watching the 1-hour recording: complete, skimmable, and visual.

Structure:
- Start with a one-paragraph lede: what the meeting was, who drove it, what came out of it. No heading above the lede.
- Then ## sections organised by TOPIC (never chronology for its own sake). Use ### subsections where a topic is dense.
- Use GFM tables for anything naturally tabular (per-item rules, options compared, figures discussed).
- End with an ## Action Items section (owner — action — deadline) and, if warranted, ## Open Questions.

Evidence and navigation (the UI renders these specially — use the EXACT forms):
- People: on a person's FIRST mention in each major section, tag them as [Full Name](person:) — the UI renders a person chip linked to the speakers panel. Later mentions in the same section stay plain text.
- Timestamp citations: after any specific claim, decision, or number worth verifying, append [m:ss](t:<millisecond offset>) — e.g. [12:30](t:750000). These become click-to-jump player chips. Cite generously, like footnotes in a good article.
- Attached files: when you draw on an attached document listed in the context, link it inline as [<file title>](attachment:<id>) using the ids given.
- Video frames (when a grab_frames tool is available): the recording contains the participants' screen shares. Find the moments where something was SHOWN (demos, "as you can see", walkthroughs of documents/dashboards), grab frames in batches, and study them — then use what you actually SEE to make the report concrete: real figures, labels, column names, error text. Embed the genuinely informative frames (typically 4-10) as figures near the text they support, each on its own line: ![<one-line caption>](frame:<ms>). Never describe a visual you did not verify in a frame, and never embed a frame that adds nothing (webcam tiles).

Source hierarchy: the main transcript below is AssemblyAI voice-level diarization — the most accurate speaker separation and timing available, but its speaker labels are anonymous (A, B, C…). Identity comes from the speaker context: confirmed names, voiceprint matches (with confidence), and calendar/Meet participants — use those to name speakers, and reason about weak matches yourself. When a Google Meet/Teams transcript rides along as a cross-reference, it has real names but device-level attribution (a shared room mic looks like one person) — trust AssemblyAI for who-spoke-when, and use the sidecar to repair garbled words, product names, and spellings.

Rules: do not invent facts, names, or dates not in the transcript/frames/attachments. Use the real speaker names from the context. Scale length to the meeting's density — typically 800-1500 words of prose (plus tables/figures); a thin meeting deserves a short report. Output ONLY the markdown report, no preamble, no TITLE/SPEAKERS/SEGMENTS envelope.

`;

/**
 * Summary distilled FROM the detailed-report session: the report run already
 * verified frames, attachments, and cross-references — resuming that session
 * gives the quick tier all of it for the price of a cache read. The envelope
 * spec is restated in full because the report session never saw it.
 */
const SUMMARY_FROM_REPORT_PROMPT = `You recently wrote the DETAILED REPORT for this meeting in this session — the transcript, the attached context, and any video frames you examined are all in your context. Now distill the QUICK SUMMARY tier from everything you verified while writing it. The summary is the fast, clean read; deep detail stays in the report.

The FIRST line of your output must be exactly:
TITLE: <a short, specific meeting title, max 60 characters, no quotes>

The SECOND line must be exactly:
SPEAKERS: <single-line JSON object, or {} if none>
Identify unnamed speakers ONLY from clear evidence already in your context (transcript text, frames you actually saw). Keys are the raw speaker letters; values are {"name": "...", "evidence": "<short quote or reason>"}. Do not repeat speakers already identified in the context below, and never invent a name.

The THIRD line must be exactly:
SEGMENTS: <single-line JSON array>
Divide the meeting into 3-8 topical segments. Each entry is {"t": "<m:ss timestamp of the utterance where the segment starts>", "title": "<3-6 word section heading>"}. The first segment starts at 0:00.

Then a blank line, then the notes.

Write concise meeting notes in Markdown with these sections (omit a section if the meeting genuinely has nothing for it): ## Summary (2-4 sentences), ## Key Points (grouped by topic, positions attributed by name), ## Decisions, ## Action Items ("**Owner** — action (deadline if mentioned)"), ## Open Questions.

Rules: the same facts discipline as the report — nothing that isn't in the transcript/frames/attachments. Use the real speaker names from the context. Keep the notes under 600 words. NO images and NO embedded frames — this is the text-only quick tier. You may attach a timestamp link to at most ~6 pivotal moments using EXACTLY this markdown form: [m:ss](t:<millisecond offset>) — e.g. [6:59](t:419000). Output ONLY the TITLE line, the SPEAKERS line, the SEGMENTS line, and the markdown notes — no preamble.

`;

const VIDEO_CONTEXT = `
THIS MEETING HAS VIDEO and you have the grab_frames tool (batch several timestamps per call). Use the workflow described above: locate screen-share moments from the transcript, look at real frames, embed the informative ones as ![caption](frame:<ms>).

`;

/**
 * Speaker-identity context injected between the header and the transcript:
 * confirmed labels plus voiceprint matches with confidence. Lets the notes
 * use real names and gives Claude a base for its own context guesses.
 */
function buildSpeakerContext(
  labels: SpeakerLabel[],
  suggestions: SpeakerSuggestionMap,
  naming?: SpeakerNaming
): string {
  const say = (label: string) => (naming ? naming.of(label) : speakerDisplayLabel(label));
  const lines: string[] = [];
  for (const l of labels) {
    if (l.customName.trim()) {
      lines.push(
        `- Speaker ${say(l.originalSpeaker)}: ${l.customName.trim()} (confirmed by a human${l.description.trim() ? `; context: ${l.description.trim()}` : ''})`
      );
    }
  }
  const named = new Set(labels.filter((l) => l.customName.trim()).map((l) => l.originalSpeaker));
  for (const [sp, s] of Object.entries(suggestions)) {
    if (named.has(sp)) continue;
    if (s.source === 'voice') {
      lines.push(
        `- Speaker ${say(sp)}: very likely ${s.name} (${Math.round(s.confidence * 100)}% voice-fingerprint match) — treat as their identity unless the transcript contradicts it`
      );
    } else if (s.confidence > 0) {
      // Meet↔AAI timeline-alignment vote (source 'context' with a real
      // confidence — Claude's own prior text guesses carry confidence 0 and
      // are deliberately NOT fed back, to avoid self-reinforcement).
      lines.push(
        `- Speaker ${say(sp)}: likely ${s.name} (${s.evidence ?? `${Math.round(s.confidence * 100)}% timeline overlap with Google Meet's transcript`}) — strong hint; verify against the transcript`
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
  // Rows that ARE the provider transcript (quick imports) must not feed their
  // own content back to themselves as a "cross-reference".
  if (row.assemblyai_id.startsWith('gmeet-') || row.assemblyai_id.startsWith('teams-')) return '';
  const meetUtterances = row.gmeet_context?.meetTranscript?.utterances;
  if (!meetUtterances || meetUtterances.length === 0) return '';
  const providerName =
    row.gmeet_context?.provider === 'teams' ? 'Microsoft Teams' : 'Google Meet';

  let text = '';
  for (const u of meetUtterances) {
    const line = `${u.speaker}: ${u.text}\n`;
    if (text.length + line.length > MAX_CROSSREF_CHARS) break;
    text += line;
  }
  if (!text) return '';
  return (
    `For cross-checking only — an INDEPENDENT transcript of this same meeting, generated by ${providerName} and imported alongside. The primary transcript below is a FRESH voice-level machine transcription of the meeting audio (AssemblyAI) made because ${providerName}'s speaker attribution is device-level (people sharing one meeting-room mic appear as one name). ${providerName}'s speaker names are real, and its wording differs where one engine mis-heard. Use it to resolve garbled words, names, and company/project terms in the primary transcript. The primary transcript below remains the source of truth for structure, timing, and attribution:\n\n` +
    text +
    '\n'
  );
}

/**
 * Stitched-media block: the row's audio is a server-side concatenation of
 * several files the user uploaded as ONE meeting (gmeet_context.uploadedParts
 * — order, per-file spans, and the user's per-file comments). Tells the
 * model where the stitch points are and what each source file was, so it
 * can reason about overlaps, restarts, and device differences instead of
 * being confused by them.
 */
/**
 * The SOURCES block: what a COMBINED meeting is made of — one line per clip,
 * saying which recording it is, where it sits on the meeting timeline, what
 * its text contributes, and (the fact the model most needs) that each
 * recording was diarized on its own, so a letter means different people in
 * different recordings.
 *
 * It REPLACES the stitched-parts block for a meeting over several recordings
 * (docs/recordings-phase3b-combine-spec.md §"Reader and writer changes") and
 * falls back to it for everything else — a concatenated upload is still one
 * recording with joins in it, and that block is the right description of it.
 *
 * Lazy and best-effort, like every other context builder here: a failure
 * costs the prompt one paragraph, never the run.
 */
async function buildSourcesContext(row: TranscriptRow): Promise<string> {
  if (!combineFlagOn()) return buildUploadedPartsContext(row);
  try {
    const { combineState } = await import('@/lib/server/clip-combine');
    const { buildSourcesBlock } = await import('@/lib/server/clip-combine');
    const state = await combineState(
      { row, access: 'owner', ownerUserId: row.user_id },
      { userId: row.user_id }
    );
    const block = buildSourcesBlock(state.entries);
    if (block) return block;
  } catch (err) {
    console.warn('[auto-notes] sources block failed (continuing without):', err);
  }
  return buildUploadedPartsContext(row);
}

function buildUploadedPartsContext(row: TranscriptRow): string {
  const parts = row.gmeet_context?.uploadedParts;
  if (!parts || parts.length < 2) return '';
  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const lines = parts.map((p) => {
    const span =
      p.offsetSec != null && p.durationSec != null
        ? ` [${fmt(p.offsetSec)}–${fmt(p.offsetSec + p.durationSec)}]`
        : '';
    const name = p.originalFilename ? ` "${p.originalFilename}"` : '';
    const note = p.comment ? ` — user's note: ${p.comment}` : '';
    return `- File ${p.index}${name}${span}${note}`;
  });
  return (
    `STITCHED RECORDING: this meeting's audio is ${parts.length} separate files the user uploaded as one meeting, concatenated in this order (timestamps in the transcript run continuously across the joins):\n` +
    lines.join('\n') +
    `\nMind the join points: content may overlap or repeat there (a restarted recording, or the same meeting captured from different devices/mics), and audio character can change between files. The user's per-file notes above are authoritative context — use them to interpret each span correctly, and don't treat an overlap as the discussion happening twice.\n\n`
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

/**
 * What to call an unnamed diarized speaker in the prompt. A compat meeting's
 * label is AssemblyAI's bare letter ("A"); a multi-clip meeting's is
 * `<recordingId>:A`, and pasting a uuid into the prompt tells the model
 * nothing — the recording is already described in the Sources block.
 */
function speakerDisplayLabel(speaker: string): string {
  const colon = speaker.lastIndexOf(':');
  return colon >= 0 ? speaker.slice(colon + 1) : speaker;
}

/**
 * Short prompt names for a COMBINED meeting's speakers, and the way back
 * (Phase 3b, docs/recordings-phase3b-combine-spec.md).
 *
 * A meeting over two recordings labels its speakers `<recordingId>:A`, and the
 * two recordings each have an "A" who is a different person. Stripping the
 * prefix would merge them; printing the uuid tells the model nothing AND makes
 * the answer unusable, because the ID pass matches the model's keys back
 * against the real labels.
 *
 * So: number the recordings in first-appearance order and call them `1A`,
 * `1B`, `2A`. `of()` is what the prompt prints, `resolve()` takes whatever the
 * model answered with — the alias, or the full label if it copied that — and
 * gives back the label `speaker_mappings` is keyed by. A single-recording
 * meeting gets the identity map, so every prompt on prod is byte-identical.
 */
export interface SpeakerNaming {
  of(label: string): string;
  resolve(key: string): string | null;
  /** True = this meeting really holds more than one diarization space. */
  namespaced: boolean;
}

export function speakerNaming(speakers: string[]): SpeakerNaming {
  const parts = speakers.map((label) => ({ label, ...splitSpeakerLabel(label) }));
  const recordings: string[] = [];
  for (const p of parts) {
    if (p.recordingId && !recordings.includes(p.recordingId)) recordings.push(p.recordingId);
  }
  const namespaced = recordings.length > 1;
  const toAlias = new Map<string, string>();
  const fromAlias = new Map<string, string>();
  for (const p of parts) {
    const alias = namespaced
      ? `${recordings.indexOf(p.recordingId!) + 1}${p.speaker}`
      : p.speaker;
    toAlias.set(p.label, alias);
    // Last writer wins only if two labels really collide, which `namespaced`
    // rules out; a single-recording meeting maps a label to itself.
    fromAlias.set(alias, p.label);
  }
  return {
    namespaced,
    of: (label) => toAlias.get(label) ?? speakerDisplayLabel(label),
    resolve: (key) => fromAlias.get(key.trim()) ?? (toAlias.has(key) ? key : null),
  };
}

function buildTranscriptText(
  content: TranscriptResponse,
  labels: SpeakerLabel[],
  naming?: SpeakerNaming
): string {
  const nameFor = new Map(
    labels
      .filter((l) => l.customName.trim())
      .map((l) => [l.originalSpeaker, l.customName.trim()])
  );
  const lines = (content.utterances ?? []).map((u) => {
    const who =
      nameFor.get(u.speaker) ?? `Speaker ${naming ? naming.of(u.speaker) : speakerDisplayLabel(u.speaker)}`;
    const t = Math.floor(u.start / 1000);
    const stamp = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    return `[${stamp}] ${who}: ${u.text}`;
  });
  return lines.join('\n');
}

/**
 * The meeting's payload, or null. DB-only since DEC-4
 * (docs/recordings-first-class-design.md §7): whoever observed completion
 * wrote the payload in the same statement, and AssemblyAI's copy is deleted
 * right after — so there is no fallback to fall back to. A finished row with
 * nothing stored is logged loudly rather than silently re-fetched; callers
 * already treat null as "can't run this pass".
 *
 * It goes through `resolveMeetingContent`, so a meeting that is more than
 * one clip over one recording reads as the merged text everything else sees.
 * In compat that is `imported_content` itself, by reference.
 *
 * `ownerUserId` is kept in the signature: every caller has it and it is what
 * a future re-read would need.
 */
export async function getContentCached(
  ownerUserId: string,
  row: TranscriptRow
): Promise<TranscriptResponse | null> {
  const content = (await resolveMeetingContent(row)).content;
  if (content?.utterances?.length) return content;
  if (row.status === 'completed' || row.status === 'error') {
    logPayloadMissing(row.assemblyai_id, `auto-notes (owner ${ownerUserId})`);
  }
  return null;
}

/**
 * The file an AI run may grab frames from — the meeting's canonical one, per
 * `frameSourceFor`. Null when nothing playable is stored.
 */
async function frameSourceForRow(row: TranscriptRow): Promise<ResolvedMedia | null> {
  return frameSourceFor((await resolveMeetingContent(row)).media);
}

/**
 * In-process MCP server exposing grab_frames over the stored recording.
 * A closure counter caps total frames per run — vision tokens are the cost
 * driver here, not ffmpeg.
 *
 * `purpose: 'speakers'` is the speaker-ID pass: the description talks about
 * name tiles and the active-speaker highlight, the run cap is the caller's
 * (scaled to the number of unnamed voices), and a `hires` flag returns
 * 1600-px frames so tile names are legible (a 2560-px Teams window scaled to
 * 960 px leaves ~9-px text).
 */
function buildVideoTools(
  assemblyaiId: string,
  source: ResolvedMedia,
  durationMs: number | null,
  opts: { purpose?: 'report' | 'speakers'; maxPerRun?: number; stats?: { grabbed: number } } = {}
) {
  const audioFilename = source.filename;
  const speakers = opts.purpose === 'speakers';
  const stats = opts.stats ?? { grabbed: 0 };
  const MAX_PER_CALL = 8;
  const MAX_PER_RUN = opts.maxPerRun ?? 24;
  const description = speakers
    ? 'Return video frames from the meeting recording at the given millisecond timestamps (batch several at once). Use to SEE who is on the call and WHO IS TALKING: call apps highlight the active speaker\'s tile (Teams: a coloured border around the tile; Meet: a blue outline / sound bars) and label tiles with names; a screen share shows "<name> is presenting". Set hires=true to read small tile names.'
    : 'Return video frames from the meeting recording at the given millisecond timestamps (batch several at once). Use to SEE what was on screen — slides, dashboards, documents — at moments the transcript suggests something was being shown.';
  const shape = {
    timestamps_ms: z
      .array(z.number().int().min(0))
      .min(1)
      .max(MAX_PER_CALL)
      .describe(`Millisecond offsets into the recording, up to ${MAX_PER_CALL} per call`),
    ...(speakers
      ? {
          hires: z
            .boolean()
            .optional()
            .describe(`true = ${HIRES_FRAME_WIDTH}px wide frames (legible tile names, ~3x the tokens); default 960px`),
        }
      : {}),
  };
  return createSdkMcpServer({
    name: 'video',
    tools: [
      tool('grab_frames', description, shape, async (args: { timestamps_ms: number[]; hires?: boolean }) => {
        const { timestamps_ms } = args;
        const width = speakers && args.hires ? HIRES_FRAME_WIDTH : undefined;
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = [];
        for (const rawMs of timestamps_ms) {
          if (stats.grabbed >= MAX_PER_RUN) {
            content.push({
              type: 'text',
              text: `(frame budget reached — ${MAX_PER_RUN} frames max per run; work with what you have)`,
            });
            break;
          }
          const ms = durationMs ? Math.min(rawMs, Math.max(0, durationMs - 1000)) : rawMs;
          const m = Math.floor(ms / 60000);
          const s = Math.floor((ms % 60000) / 1000);
          try {
            // The model asks in MEETING ms (what the transcript it is
            // reading shows). For a meeting split off a longer recording,
            // the file is shared and the seek is `localMsIn` — the same
            // mapping the `frame:<ms>` it writes will be served through.
            const abs = await extractFrame(assemblyaiId, audioFilename, localMsIn(source, ms), ms, width);
            const data = await fsp.readFile(abs);
            stats.grabbed++;
            content.push({ type: 'text', text: `Frame at ${m}:${String(s).padStart(2, '0')} (${ms} ms):` });
            content.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' });
          } catch (err) {
            content.push({ type: 'text', text: `Frame at ${ms} ms unavailable: ${String(err).slice(0, 120)}` });
          }
        }
        return { content };
      }),
    ],
  });
}

/** Rewrite the agent's frame:<ms> refs to real serving URLs and pre-warm the
 * extraction cache so first render is instant. */
function rewriteFrameRefs(notes: string, assemblyaiId: string, source: ResolvedMedia | null): string {
  return notes.replace(/\(frame:(\d+)\)/g, (_m, msStr: string) => {
    const ms = Number.parseInt(msStr, 10);
    if (source) {
      void extractFrame(assemblyaiId, source.filename, localMsIn(source, ms), ms).catch(() => {});
    }
    return `(/api/transcripts/${assemblyaiId}/frames/${ms}.jpg)`;
  });
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
    /** Free-form user steering for THIS run ("be very detailed", "focus on
     * action items", …). Appended to the prompt; not persisted. */
    instructions?: string;
    /** Distill the summary by resuming the latest completed DETAILED-REPORT
     * session (frames and all) instead of a plain notes run. Falls back to a
     * fresh full run if no report session is available. Implies force. */
    fromReport?: boolean;
    /** Known report session id (the in-process handoff right after a report
     * run) — skips the ai_runs lookup, which may not have committed yet. */
    reportSessionId?: string;
  } = {}
): Promise<void> {
  const key = `${ownerUserId}:${assemblyaiId}`;
  if (inFlight.has(key)) return;

  const force = opts.force || opts.fromReport;
  const row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || row.status !== 'completed') return;
  if (!force && (row.auto_notes_status === 'completed' || row.auto_notes_status === 'running')) {
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
    // Phase 3b: a combined meeting's labels are `<recordingId>:A`, so the
    // prompt gets short per-recording aliases (1A / 2A) instead. A
    // single-recording meeting's naming is the identity and every prompt on
    // prod is unchanged.
    const naming = speakerNaming([...new Set((content.utterances ?? []).map((u) => u.speaker))]);
    const transcriptText = buildTranscriptText(content, labels, naming);
    const speakerContext = buildSpeakerContext(labels, existingSuggestions, naming);
    const attachmentContext = await buildAttachmentContext(row.id);
    const meetCrossRef = buildMeetCrossReference(row);
    const peopleContext = await buildPeopleContext(row);

    const instructions = opts.instructions?.trim().slice(0, 2000);
    const styleContext = instructions
      ? `\nUSER INSTRUCTIONS for this run — follow them (they may adjust tone, depth, focus, or language, but the TITLE/SPEAKERS/SEGMENTS envelope format is non-negotiable):\n${instructions}\n\n`
      : '';

    const prompt =
      PROMPT_HEADER + styleContext + attachmentContext + (await buildSourcesContext(row)) +
      meetCrossRef + peopleContext + speakerContext + transcriptText;

    // Incremental top-up: a forced regeneration (speaker renamed, context
    // file attached, …) resumes the prior session instead of resending the
    // whole transcript — the session already holds it, so the bulk of the
    // prompt is a cache read. Falls back to a fresh full run if the resume
    // fails (session file gone, expired, whatever). NOTE: assumes the
    // transcript text itself is unchanged; heavy transcript edits still get
    // fresh full runs because the top-up re-supplies context, not content.
    // Prompt regime change (quick summary went back to clean/no-frames):
    // don't resume sessions whose notes still carry embedded frames.
    const staleFormat = (row.auto_notes ?? '').includes('/frames/');
    const priorSessionId = opts.fromReport
      ? (opts.reportSessionId ?? (await getLatestSessionId(row.id, 'auto_report')))
      : force && !staleFormat
        ? await getLatestSessionId(row.id, 'auto_notes')
        : null;
    // Context refresher appended to either resume prompt: for an older
    // report session, speakers/attachments may have moved on since.
    const currentContext =
      `Current context (supersedes earlier versions; the transcript itself is unchanged):\n\n` +
      styleContext +
      attachmentContext +
      peopleContext +
      speakerContext.replace(/Transcript follows:\n\n$/, '');
    const topUpPrompt = opts.fromReport
      ? SUMMARY_FROM_REPORT_PROMPT + currentContext
      : `The meeting data has been updated since you generated these notes (speaker identifications, attached context files, or the team directory may have changed). Regenerate the notes now, following EXACTLY the same output format as before: the TITLE line, the SPEAKERS line, the SEGMENTS line, a blank line, then the markdown notes.\n\n` +
        currentContext;

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

    // Harmless when no frame refs; keeps any legacy embeds rendering.
    notes = rewriteFrameRefs(notes, assemblyaiId, await frameSourceForRow(row));

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

const SPEAKER_ID_PROMPT = `You are identifying the diarized speakers of a meeting transcript BEFORE any summary is written. The anonymous labels (Speaker A, B, …) come from voice-level diarization; your only job is to work out who each unnamed speaker actually is, so a human can confirm your guesses and summary generation can then use real names. The human will only glance at your answer — do the work so they do not have to.

Evidence, strongest first:
- Transcript text — READ ALL OF IT, not just the opening: self-introductions, being addressed by name right before/after a turn ("thanks, Priya" / "Priya, can you…" / "go on, Joey"), hand-overs, sign-offs, first-person claims that match a role ("I'm from IT", "our import team"). Names in the transcript are often garbled by speech recognition ("Pau Gun" / "Bagong" for "Pak Agung") — match them to the invite list and the directory.
- Video frames (when a grab_frames tool is available — see the VIDEO block below for exact moments to look at): call apps highlight the ACTIVE speaker's tile — Teams draws a coloured border around the tile and names every tile; Meet outlines the tile / shows sound bars. A frame a few seconds into one voice's long utterance shows whose tile is lit while that voice talks. Two or more such frames, at different times, that agree on one highlighted name bind the voice to that person — that is strong evidence (confidence 0.8-0.95). Also read "<name> is presenting" banners during screen shares against who narrates the share. Caveats: a meeting-room device shares one mic and one tile among several people; the recording owner's own tile may be missing or small; if no tile is highlighted or tiles are hidden behind a full-screen share, say the frames were inconclusive rather than guessing from them.
- The invite list / participant directory below: the true roster and spellings — speakers are almost always on it.
- The search_people tool: the full company directory. Verify each name you intend to propose — propose the CANONICAL directory person, written as their DISPLAY name ("Karnica Katiyar"), never an email local-part or login handle ("karnica.katiyar"). Where the tool prints a "display name", copy that. Invitees from other companies (external guests) will not be in the directory — the invite spelling is then the reference; write it as a person would ("Agung Prihatmoko", not "PRIHATMOKO Agung").
- Voiceprint hints below: weak signals to corroborate or reject, NOT ground truth — sub-70% matches are frequently wrong. CROSS-CHECK EVERY VOICE HINT AGAINST THE INVITE: a voice match to someone who is NOT on the invite of a meeting that has one is very likely a false match (a similar-sounding colleague) — reject it unless the transcript or the frames independently confirm that person was on the call. A "margin" verdict lists two close candidates: if the recording context or the transcript rules one out, the other is very likely right; "off-roster" means the voice pass already discarded an uninvited match.
- RECORDING CONTEXT (when present): the recorder's own record of the call — who owns the Mac that recorded it and, for a one-to-one call, the contact the call window was titled after. That is strong roster evidence; the two voices of a WhatsApp/FaceTime call are the owner and that contact unless the transcript plainly says otherwise.

Method: read the whole transcript and note every name-bearing line; when you have video, grab frames at the moments given for EVERY unnamed speaker (hires=true when tile names are small) before you decide; check each candidate against the invite; then answer. Two voices can be the same person only if diarization split them — say so in the evidence if you think so.

Output a single JSON object and NOTHING else:
{"A": {"name": "Full Name", "confidence": 0.85, "evidence": "short concrete justification (quote, highlighted tile at 12:46 and 31:10, hint corroboration)"}}
- Keys are raw speaker letters — only ones NOT already confirmed by a human.
- "name" is a display name: capitalised words separated by spaces, as a person would write it — never a login/handle with dots or underscores.
- confidence is your own honest 0-1 estimate; include shaky guesses with low confidence rather than omitting them, but NEVER invent a name that appears nowhere in the evidence.
- Omit speakers you have nothing for; output {} if none.

`;

/**
 * The display form of a directory name that is really a login handle —
 * "karnica.​katiyar" (the directory keeps some with a zero-width space) ->
 * "Karnica Katiyar". Null when the name already looks like a display name
 * (has a space, or no dot/underscore). The speaker-ID pass must propose the
 * display form: a login spelling confirmed in the review dialog enrolls a
 * second voiceprint for the same person.
 */
function loginDisplayName(name: string): string | null {
  const bare = name.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  if (/\s/.test(bare) || !/[._]/.test(bare)) return null;
  const key = personNameKey(bare);
  if (!key) return null;
  return key.replace(/(^| )(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

/**
 * In-process MCP server exposing the company people directory to the
 * speaker-ID pass — lets it canonicalize garbled transcript names against
 * real directory entries instead of proposing misspellings.
 */
function buildPeopleTools() {
  return createSdkMcpServer({
    name: 'people',
    tools: [
      tool(
        'search_people',
        'Search the company people directory by name fragment or email. Returns name, email, team, and role for up to 8 matches — and, when the directory only holds a login handle ("karnica.katiyar"), the display name to propose instead. Use it to verify a name you intend to propose and to get its exact spelling.',
        {
          query: z.string().min(1).describe('Name fragment or email to look up'),
        },
        async ({ query }) => {
          try {
            const people = await searchPeople(query, 8);
            const text =
              people.length === 0
                ? `No directory matches for "${query}".`
                : people
                    .map((p) => {
                      const display = loginDisplayName(p.name);
                      return `- ${p.name}${display ? ` (display name: ${display})` : ''}${p.email ? ` <${p.email}>` : ''}${p.team ? ` — team: ${p.team}` : ''}${p.role ? `, role: ${p.role}` : ''}`;
                    })
                    .join('\n');
            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            return {
              content: [
                { type: 'text' as const, text: `Directory lookup failed: ${String(err).slice(0, 120)}` },
              ],
            };
          }
        }
      ),
    ],
  });
}

/**
 * Speaker-hint block for the ID pass. Unlike buildSpeakerContext (which
 * presents voice matches as near-identities for the notes run), hints here
 * are framed as inputs to evaluate. Excludes the pass's own prior output
 * (via 'id') so re-runs never self-reinforce.
 */
function buildIdPassHints(
  labels: SpeakerLabel[],
  suggestions: SpeakerSuggestionMap,
  naming?: SpeakerNaming,
  voiceVerdicts: string[] = [],
  /** Who was invited (recording-call-context roster); [] = no invite known. */
  roster: string[] = []
): string {
  const say = (label: string) => (naming ? naming.of(label) : speakerDisplayLabel(label));
  const lines: string[] = [];
  const named = new Set<string>();
  for (const l of labels) {
    if (!l.customName.trim()) continue;
    named.add(l.originalSpeaker);
    lines.push(`- Speaker ${say(l.originalSpeaker)}: ${l.customName.trim()} (CONFIRMED by a human — exclude from your output)`);
  }
  for (const [sp, s] of Object.entries(suggestions)) {
    if (named.has(sp) || s.via === 'id') continue;
    if (s.source === 'voice') {
      const pct = Math.round(s.confidence * 100);
      const invited = rosterIsInformative(roster) ? onRoster(s.name, roster) : null;
      const notes = [
        s.confidence < WEAK_VOICE_SCORE ? 'WEAK' : null,
        invited === false || s.offRoster
          ? 'NOT on the invite — reject unless the transcript or frames confirm this person was on the call'
          : invited
            ? 'on the invite'
            : null,
      ].filter(Boolean);
      lines.push(
        `- Speaker ${say(sp)}: voiceprint matched "${s.name}" at ${pct}% similarity (hint only${notes.length ? `; ${notes.join('; ')}` : ''})`
      );
    } else if (s.confidence > 0) {
      lines.push(`- Speaker ${say(sp)}: possibly "${s.name}" (${s.evidence ?? 'timeline overlap with the Meet transcript'})`);
    }
  }
  // The voice pass's full verdict list, rejections included. "A=margin(Yadu
  // N M 0.77 vs Pratiksha Mali 0.72)" is a near-answer the roster or the
  // transcript can settle; "below-threshold" says the voice is nobody we have
  // enrolled. Only the accepted matches used to reach this prompt.
  if (voiceVerdicts.length > 0) {
    lines.push(
      `- Voiceprint pass, every verdict (cosine similarity to enrolled voices; "margin" = two prints too close to call, "below-threshold" = no enrolled voice is close): ` +
        voiceVerdicts.join(' · ')
    );
  }
  if (lines.length === 0) return 'Speaker hints: none yet — work from the transcript, directory, and frames.\n\nTranscript follows:\n\n';
  return `Speaker hints gathered so far:\n${lines.join('\n')}\n\nTranscript follows:\n\n`;
}

/** Frames per unnamed speaker the ID pass is told to look at. */
const ID_MOMENTS_PER_SPEAKER = 4;
/** Hard cap on frames in one ID pass (≈ $0.5 of vision at most). */
const ID_MAX_FRAMES = 36;

/**
 * The VIDEO block of the ID prompt: for each unnamed speaker, the moments it
 * is talking (lib/speaker-moments.ts), so the model grabs frames where the
 * active-speaker highlight answers the question instead of sampling blind.
 */
function buildSpeakerMomentsBlock(
  content: TranscriptResponse,
  unnamed: string[],
  naming: SpeakerNaming,
  frameBudget: number
): string {
  const utterances = content.utterances ?? [];
  const lines: string[] = [];
  for (const sp of [...unnamed].sort()) {
    const m = speakingMoments(utterances, sp, ID_MOMENTS_PER_SPEAKER);
    if (m.moments.length === 0) continue;
    const talk = clockOf(m.talkMs);
    lines.push(
      `- Speaker ${naming.of(sp)} (${m.lines} line${m.lines === 1 ? '' : 's'}, ${talk} of speech) is talking at: ` +
        m.moments.map((ms) => `${clockOf(ms)} (${ms} ms)`).join(', ')
    );
  }
  if (lines.length === 0) return '';
  return (
    `VIDEO: this meeting has video and you have grab_frames (budget ${frameBudget} frames for the run). ` +
    `Look before you answer: grab the frames below (batch them, up to 8 per call), find the highlighted / speaking tile in each and read its name; ` +
    `use hires=true if the tile names are too small to read. Use any remaining budget for the start of the call (who joined) and screen-share moments.\n` +
    lines.join('\n') +
    '\n\n'
  );
}

/**
 * The dedicated speaker-identification pass: runs once at completion,
 * BEFORE any summary. Writes its guesses into speaker_mappings.suggestions
 * (via 'id') for the human review dialog; notes generation is gated on that
 * review, so good names exist before the first summary is written.
 */
export async function identifySpeakers(
  ownerUserId: string,
  assemblyaiId: string,
  opts: {
    /** re-run even if a prior pass completed/stuck — sweeper recovery + manual retrigger */
    force?: boolean;
    /**
     * The caller (post-completion) already flipped speaker_id_status
     * NULL -> 'running' with `claimSpeakerId` and owns this run, so a
     * 'running' row is expected here rather than a reason to skip.
     */
    claimed?: boolean;
    triggeredBy?: { userId: string; email: string };
  } = {}
): Promise<void> {
  const key = `spkid:${ownerUserId}:${assemblyaiId}`;
  if (inFlight.has(key)) return;

  const row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || row.status !== 'completed') return;
  // Only a caller that owns the run gets through: post-completion after
  // winning `claimSpeakerId` (claimed — the row already reads 'running'), or
  // an explicit force (sweeper recovery, "Guess names", link-event re-guess).
  // Errored passes wait for a human (the "Guess names" button forces a
  // retry) so a persistent failure can't burn tokens on every page view.
  if (!opts.force && !opts.claimed) return;

  inFlight.add(key);
  try {
    // Meet-transcript-only imports carry real names from Meet's own
    // attribution — nothing to identify.
    if (assemblyaiId.startsWith('gmeet-')) {
      await setSpeakerIdForUser(ownerUserId, assemblyaiId, { status: 'completed' });
      return;
    }

    const content = await getContentCached(ownerUserId, row);
    if (!content?.utterances?.length) {
      throw new Error('no utterances available for this transcript');
    }

    const mappings = await getMappingsForUser(ownerUserId, assemblyaiId);
    const labels = mappings?.speaker_labels ?? [];
    const suggestions = mappings?.suggestions ?? {};
    const named = new Set(labels.filter((l) => l.customName.trim()).map((l) => l.originalSpeaker));
    const allSpeakers = new Set(content.utterances.map((u) => u.speaker));
    const unnamed = [...allSpeakers].filter((sp) => !named.has(sp));
    if (unnamed.length === 0) {
      await setSpeakerIdForUser(ownerUserId, assemblyaiId, { status: 'completed' });
      return;
    }

    await setSpeakerIdForUser(ownerUserId, assemblyaiId, { status: 'running' });

    // The prompt names speakers `1A` / `2A` for a combined meeting and `A` for
    // every other; `naming.resolve` takes the model's key back to the label
    // `speaker_mappings` is keyed by (Phase 3b).
    const naming = speakerNaming([...allSpeakers]);

    const frameSource = await frameSourceForRow(row);
    const videoOk = frameSource ? await hasVideoStream(frameSource.filename) : false;
    const durationMs = (row.duration ?? content.audio_duration ?? 0) * 1000 || null;
    // Frames: the per-speaker moments plus a few to look around — capped, as
    // vision tokens are the cost (~700 per 960-px frame, ~2k hires).
    const frameBudget = Math.min(ID_MAX_FRAMES, ID_MOMENTS_PER_SPEAKER * unnamed.length + 6);
    const frameStats = { grabbed: 0 };
    const agentOpts = {
      mcpServers: {
        people: buildPeopleTools(),
        ...(videoOk
          ? {
              video: buildVideoTools(assemblyaiId, frameSource!, durationMs, {
                purpose: 'speakers',
                maxPerRun: frameBudget,
                stats: frameStats,
              }),
            }
          : {}),
      },
      allowedTools: [
        'mcp__people__search_people',
        ...(videoOk ? ['mcp__video__grab_frames'] : []),
      ],
    };

    // Whose call this was, from the recorder's own record (a WhatsApp/FaceTime
    // title names the other party) — best-effort, '' when not a tray recording.
    let recordingBlock = '';
    let roster: string[] = [];
    try {
      const callCtx = await recordingCallContext(row);
      roster = callCtx.roster;
      recordingBlock = recordingContextBlock(callCtx, row.title ?? null);
    } catch (err) {
      console.warn(`[speaker-id] ${assemblyaiId}: recording context failed (continuing without):`, err);
    }

    const prompt =
      SPEAKER_ID_PROMPT +
      (videoOk ? buildSpeakerMomentsBlock(content, unnamed, naming, frameBudget) : '') +
      recordingBlock +
      (await buildSourcesContext(row)) +
      buildMeetCrossReference(row) +
      (await buildPeopleContext(row)) +
      buildIdPassHints(labels, suggestions, naming, recentVoiceVerdicts(assemblyaiId), roster) +
      buildTranscriptText(content, labels, naming);

    const started = Date.now();
    let run;
    try {
      run = await runClaudeWithMeta(prompt, agentOpts);
      void recordAiRun({
        transcriptId: row.id,
        assemblyaiId,
        kind: 'speaker_id',
        triggeredBy: opts.triggeredBy ?? null,
        status: 'completed',
        meta: run.meta,
        promptChars: prompt.length,
        resultChars: run.text.length,
      });
    } catch (runErr) {
      void recordAiRun({
        transcriptId: row.id,
        assemblyaiId,
        kind: 'speaker_id',
        triggeredBy: opts.triggeredBy ?? null,
        status: 'error',
        error: String(runErr).slice(0, 1000),
        promptChars: prompt.length,
      });
      throw runErr;
    }

    const guessed = parseJsonFromClaude<
      Record<string, { name?: string; confidence?: number; evidence?: string }>
    >(run.text);

    // Merge on top of CURRENT state (the voice pass may have written fresh
    // suggestions while we ran). The ID pass saw the voice hints and more,
    // so a confident disagreement may override a weak voice match — but a
    // human-confirmed label is never touched.
    const current = (await getMappingsForUser(ownerUserId, assemblyaiId))?.suggestions ?? suggestions;
    const { merged, added, changed } = mergeIdPassGuesses(current, guessed ?? {}, {
      resolve: (k) => naming.resolve(k),
      named,
      allSpeakers,
    });
    if (changed) await setSuggestionsForUser(ownerUserId, assemblyaiId, merged);

    console.log(
      `[speaker-id] ${assemblyaiId}: identified ${added}/${unnamed.length} unnamed speaker(s) in ${Math.round((Date.now() - started) / 1000)}s` +
        (run.meta.costUsd != null
          ? ` ($${run.meta.costUsd.toFixed(4)}, ${run.meta.model ?? 'model?'}${videoOk ? `, video, ${frameStats.grabbed}/${frameBudget} frames` : ''})`
          : '')
    );
    await setSpeakerIdForUser(ownerUserId, assemblyaiId, { status: 'completed', error: null });
  } catch (err) {
    console.error(`[speaker-id] ${assemblyaiId}: failed:`, err);
    await setSpeakerIdForUser(ownerUserId, assemblyaiId, {
      status: 'error',
      error: String(err).slice(0, 1000),
    }).catch(() => {});
  } finally {
    inFlight.delete(key);
  }
}

/** Attachments the report can link to inline via [title](attachment:<id>). */
async function buildAttachmentLinkIndex(transcriptRowId: number): Promise<string> {
  try {
    const attachments = await listAttachments(transcriptRowId);
    const files = attachments.filter((a) => a.kind === 'file');
    if (files.length === 0) return '';
    return (
      'Attached files — link them inline as [<title>](attachment:<id>) where you draw on their content:\n' +
      files.map((a) => `- id=${a.id} "${a.title}"`).join('\n') +
      '\n\n'
    );
  } catch {
    return '';
  }
}

/**
 * Generate the DETAILED REPORT tier. Same status-machine shape as the quick
 * summary (auto_report_status: running -> completed | error), but always a
 * fresh full pass at HIGH reasoning effort, with the frame-grabbing tool
 * when the recording has video. User-triggered only — never swept.
 */
export async function generateAutoReport(
  ownerUserId: string,
  assemblyaiId: string,
  opts: {
    triggeredBy?: { userId: string; email: string };
    instructions?: string;
    /** false = text-only report even when the recording has video. */
    useVideo?: boolean;
  } = {}
): Promise<void> {
  const key = `report:${ownerUserId}:${assemblyaiId}`;
  if (inFlight.has(key)) return;

  let row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || row.status !== 'completed') return;
  if (row.auto_report_status === 'running') return;

  inFlight.add(key);
  try {
    await setAutoReportForUser(ownerUserId, assemblyaiId, { status: 'running' });

    // A video report on a row whose recording is still only on Drive: pull it
    // first (joining any fetch already in flight — e.g. the page's auto-fetch)
    // so the run actually gets the frames instead of silently going text-only.
    // Own-token rule: the trigger's Google connection does the pull. Any
    // failure degrades to a text-only report rather than failing the run.
    const pendingFileId =
      row.gmeet_context?.videoFileId ?? row.gmeet_context?.actuals?.recordings?.[0]?.fileId;
    const teamsCtx = row.gmeet_context?.provider === 'teams' ? row.gmeet_context.teams : null;
    if (opts.useVideo !== false && !row.local_audio_path && pendingFileId) {
      const requesterId = opts.triggeredBy?.userId ?? ownerUserId;
      try {
        const minted = await getServerAccessToken(requesterId);
        if (!minted) throw new Error('Google not connected for the triggering user');
        await fetchRecordingFromDrive({
          ownerUserId,
          assemblyaiId,
          fileId: pendingFileId,
          accessToken: minted.token,
        });
        row = (await getForUser(ownerUserId, assemblyaiId)) ?? row;
      } catch (err) {
        console.warn(
          `[auto-report] ${assemblyaiId}: recording fetch failed, continuing text-only:`,
          err
        );
      }
    } else if (opts.useVideo !== false && !row.local_audio_path && teamsCtx?.recordingId) {
      // Teams twin: the recording is fetched app-only from Graph — no user
      // token involved. Same degrade-to-text-only stance on failure.
      try {
        await fetchRecordingFromTeams({
          ownerUserId,
          assemblyaiId,
          organizerOid: teamsCtx.organizerOid,
          graphMeetingId: teamsCtx.graphMeetingId,
          recordingId: teamsCtx.recordingId,
        });
        row = (await getForUser(ownerUserId, assemblyaiId)) ?? row;
      } catch (err) {
        console.warn(
          `[auto-report] ${assemblyaiId}: Teams recording fetch failed, continuing text-only:`,
          err
        );
      }
    }

    const content = await getContentCached(ownerUserId, row);
    if (!content?.utterances?.length) {
      throw new Error('no utterances available for this transcript');
    }

    const mappings = await getMappingsForUser(ownerUserId, assemblyaiId);
    const labels = mappings?.speaker_labels ?? [];
    const existingSuggestions = mappings?.suggestions ?? {};
    // Phase 3b: a combined meeting's labels are `<recordingId>:A`, so the
    // prompt gets short per-recording aliases (1A / 2A) instead. A
    // single-recording meeting's naming is the identity and every prompt on
    // prod is unchanged.
    const naming = speakerNaming([...new Set((content.utterances ?? []).map((u) => u.speaker))]);
    const transcriptText = buildTranscriptText(content, labels, naming);
    const speakerContext = buildSpeakerContext(labels, existingSuggestions, naming);
    const attachmentContext = await buildAttachmentContext(row.id);
    const attachmentLinks = await buildAttachmentLinkIndex(row.id);
    const meetCrossRef = buildMeetCrossReference(row);
    const peopleContext = await buildPeopleContext(row);

    const instructions = opts.instructions?.trim().slice(0, 2000);
    const styleContext = instructions
      ? `\nUSER INSTRUCTIONS for this report — follow them:\n${instructions}\n\n`
      : '';

    const frameSource = opts.useVideo !== false ? await frameSourceForRow(row) : null;
    const videoOk = frameSource ? await hasVideoStream(frameSource.filename) : false;
    const durationMs = (row.duration ?? content.audio_duration ?? 0) * 1000 || null;
    const agentOpts = videoOk
      ? {
          effort: 'high',
          mcpServers: {
            video: buildVideoTools(assemblyaiId, frameSource!, durationMs),
          },
          allowedTools: ['mcp__video__grab_frames'],
        }
      : { effort: 'high' };

    const prompt =
      REPORT_PROMPT +
      styleContext +
      (videoOk ? VIDEO_CONTEXT : '') +
      attachmentLinks +
      attachmentContext +
      (await buildSourcesContext(row)) +
      meetCrossRef +
      peopleContext +
      speakerContext +
      transcriptText;

    const started = Date.now();
    const run = await runClaudeWithMeta(prompt, agentOpts);
    let report = run.text;
    console.log(
      `[auto-report] ${assemblyaiId}: generated ${report.length} chars in ${Math.round((Date.now() - started) / 1000)}s` +
        (run.meta.costUsd != null ? ` ($${run.meta.costUsd.toFixed(4)}, ${run.meta.model ?? 'model?'})` : '')
    );
    void recordAiRun({
      transcriptId: row.id,
      assemblyaiId,
      kind: 'auto_report',
      triggeredBy: opts.triggeredBy ?? null,
      status: 'completed',
      meta: run.meta,
      promptChars: prompt.length,
      resultChars: report.length,
    });

    report = rewriteFrameRefs(report, assemblyaiId, frameSource);

    await setAutoReportForUser(ownerUserId, assemblyaiId, {
      status: 'completed',
      report,
      error: null,
    });

    // The report pass verified far more than the summary tier ever sees
    // (frames, attachments, cross-references). Distill/refresh the quick
    // summary from the same session so both tiers agree — mostly a cache
    // read. Fire-and-forget; a summary failure never fails the report.
    void generateAutoNotes(ownerUserId, assemblyaiId, {
      fromReport: true,
      reportSessionId: run.meta.sessionId ?? undefined,
      triggeredBy: opts.triggeredBy,
    }).catch((err) =>
      console.warn(`[auto-report] ${assemblyaiId}: follow-up summary failed:`, err)
    );
  } catch (err) {
    console.error(`[auto-report] ${assemblyaiId}: failed:`, err);
    void recordAiRun({
      transcriptId: row.id,
      assemblyaiId,
      kind: 'auto_report',
      triggeredBy: opts.triggeredBy ?? null,
      status: 'error',
      error: String(err).slice(0, 1000),
    });
    await setAutoReportForUser(ownerUserId, assemblyaiId, {
      status: 'error',
      error: String(err).slice(0, 1000),
    }).catch(() => {});
  } finally {
    inFlight.delete(key);
  }
}
