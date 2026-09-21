import 'server-only';
import {
  MAX_PROPOSALS,
  MIN_CLIP_MS,
  adoptProposals,
  candidateWindows,
  clipCandidates,
  formatDuration,
  formatTimestamp,
  type CandidateEvent,
  type CandidateUtterance,
  type ClipBoundaryCandidate,
  type ProposeClipsOk,
} from '@/lib/clips';
import { runClaudeWithMeta, parseJsonFromClaude } from '@/lib/server/claude-agent';
import { recordAiRun } from '@/db-ops/ai-runs';
import { listOccurrencesOverlapping } from '@/db-ops/calendar-event-cache';
import { getForUser as getMappingsForUser } from '@/db-ops/speaker-mappings';
import type { ResolvedAccess } from '@/db-ops/transcript-access';
import type { MeetingClipState } from '@/lib/server/clip-split';

/**
 * "Suggest where to cut this" — `POST /api/transcripts/:id/clips/propose`.
 *
 * PROPOSALS ONLY: nothing is written, no file is touched, no transcription
 * is run. The shape is deliberate (spec §API):
 *
 *   1. DETERMINISTIC candidates first — speaker entry/exit, silences of 45 s
 *      or more, and the owner's calendar occurrences overlapping the
 *      recording's wall-clock span. All pure, all in `lib/clips.ts`, all unit
 *      tested without a database.
 *   2. Then ONE agent call, on the same runner, model and cost accounting as
 *      auto-notes (`ai_runs` kind `clip_proposal`), whose only job is to PICK
 *      from those windows and name them. It never invents a boundary, which
 *      is what makes "no strong boundary ⇒ an empty list" an honest answer
 *      instead of a made-up one.
 *
 * No candidates ⇒ no agent call ⇒ nothing charged, whatever the instruction.
 */

/**
 * What to call an unnamed diarized speaker in the prompt — the bare letter,
 * never the `<recordingId>:A` form a two-recording meeting would carry (a
 * uuid tells the model nothing). Its own copy on purpose: importing the one
 * in `auto-notes.ts` would drag the agent SDK and every AI pass into this
 * module's graph, and `mock.module` is process-wide in `bun test`.
 */
function speakerDisplayLabel(speaker: string): string {
  const colon = speaker.lastIndexOf(':');
  return colon >= 0 ? speaker.slice(colon + 1) : speaker;
}

const MAX_WINDOWS_IN_PROMPT = 24;
/** Utterances quoted per window: enough to name it, not enough to cost. */
const SAMPLE_LINES = 4;

export interface ProposeInput {
  access: ResolvedAccess;
  state: MeetingClipState;
  by: { userId: string; email: string };
  instruction?: string | null;
}

// ---------------------------------------------------------------------------
// The deterministic half
// ---------------------------------------------------------------------------

/** The meeting's utterances in the shape the candidate extractors want. */
export function candidateUtterancesOf(
  utterances: Array<{ start: number; end: number; speaker: string }>
): CandidateUtterance[] {
  return utterances.map((u) => ({ startMs: u.start, endMs: u.end, speaker: u.speaker }));
}

/**
 * The owner's calendar occurrences that overlap the recording's wall clock.
 *
 * Cache-only and the OWNER's own rows (the calendar cache is per-user by
 * design) — the proposer never reaches a calendar API, and a collaborator
 * asking for suggestions never sees anybody else's calendar.
 */
export async function calendarCandidatesFor(
  ownerUserId: string,
  recordingStartedAt: string | null,
  spanMs: number
): Promise<CandidateEvent[]> {
  if (!recordingStartedAt) return [];
  const startMs = Date.parse(recordingStartedAt);
  if (Number.isNaN(startMs)) return [];
  const rows = await listOccurrencesOverlapping(
    ownerUserId,
    new Date(startMs).toISOString(),
    new Date(startMs + Math.max(spanMs, 0)).toISOString()
  ).catch(() => []);
  return rows.map((r) => ({
    eventRef: r.event_key,
    title: r.title,
    startMs: Date.parse(r.event_start),
    endMs: r.event_end ? Date.parse(r.event_end) : null,
  }));
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export function buildProposalPrompt(input: {
  title: string | null;
  spanMs: number;
  windows: Array<{ fromMs: number; toMs: number; startedBy: ClipBoundaryCandidate | null; endedBy: ClipBoundaryCandidate | null }>;
  utterances: Array<{ start: number; speaker: string; text: string }>;
  nameFor: Map<string, string>;
  instruction?: string | null;
}): string {
  const who = (speaker: string) =>
    input.nameFor.get(speaker) ?? `Speaker ${speakerDisplayLabel(speaker)}`;
  const blocks = input.windows.slice(0, MAX_WINDOWS_IN_PROMPT).map((w, i) => {
    const inside = input.utterances.filter((u) => u.start >= w.fromMs && u.start < w.toMs);
    const voices = [...new Set(inside.map((u) => who(u.speaker)))];
    const sample = [
      ...inside.slice(0, SAMPLE_LINES),
      ...(inside.length > SAMPLE_LINES * 2 ? inside.slice(-SAMPLE_LINES) : []),
    ]
      .map((u) => `    [${formatTimestamp(u.start)}] ${who(u.speaker)}: ${u.text.slice(0, 220)}`)
      .join('\n');
    return [
      `WINDOW ${i + 1}  fromMs=${w.fromMs} toMs=${w.toMs}  (${formatTimestamp(w.fromMs)}–${formatTimestamp(w.toMs)}, ${formatDuration(w.toMs - w.fromMs)})`,
      `  starts because: ${w.startedBy?.label ?? 'the recording starts'}`,
      `  ends because: ${w.endedBy?.label ?? 'the recording ends'}`,
      w.startedBy?.eventRef ? `  calendar event: ${w.startedBy.eventRef}` : null,
      `  voices: ${voices.join(', ') || 'none'}`,
      sample ? `  what is said:\n${sample}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    'You are helping split one long recording into the separate MEETINGS it actually contains.',
    '',
    `The recording runs ${formatDuration(input.spanMs)}${input.title ? ` and is currently filed as "${input.title}"` : ''}.`,
    'Below are the only places it can be cut — they were found from speaker entries and exits,',
    'long silences and the owner\'s calendar. You may ONLY use the exact fromMs/toMs numbers shown,',
    'and you may join CONSECUTIVE windows by taking the first one\'s fromMs and the last one\'s toMs.',
    '',
    ...blocks,
    '',
    input.instruction
      ? `WHAT THE PERSON ASKED FOR (follow it; if it cannot be satisfied with these windows, answer []):\n${input.instruction.slice(0, 500)}`
      : 'Nobody gave an instruction. Propose a split ONLY where the recording clearly holds more than one meeting.',
    '',
    'Answer with a JSON array and nothing else:',
    '[{"fromMs": <number>, "toMs": <number>, "title": "<a real meeting title, max 8 words>",',
    '  "reason": "<one line a person would recognise>", "confidence": <0-1>,',
    '  "eventRef": "<only if the window shows one>"}]',
    '',
    'An empty array [] is the right answer when the recording is one meeting. Never invent a',
    `timestamp, never return more than ${MAX_PROPOSALS} proposals, and never propose the whole recording.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

export async function proposeClips(input: ProposeInput): Promise<ProposeClipsOk> {
  const { access, state } = input;
  const utterances = access.row.imported_content?.utterances ?? [];
  const empty: ProposeClipsOk = { ok: true, proposals: [], candidates: 0, ranAgent: false };
  if (utterances.length === 0 || state.spanMs <= MIN_CLIP_MS) return empty;

  const mappings = await getMappingsForUser(access.ownerUserId, access.row.assemblyai_id);
  const nameFor = new Map(
    (mappings?.speaker_labels ?? [])
      .filter((l) => l.customName?.trim())
      .map((l) => [l.originalSpeaker, l.customName.trim()])
  );

  const events = await calendarCandidatesFor(
    access.ownerUserId,
    state.recordingStartedAt,
    state.spanMs
  );
  const candidates = clipCandidates({
    utterances: candidateUtterancesOf(utterances),
    nameFor: (s) => nameFor.get(s) ?? `Speaker ${speakerDisplayLabel(s)}`,
    events,
    recordingStartMs: state.recordingStartedAt ? Date.parse(state.recordingStartedAt) : null,
    spanMs: state.spanMs,
  });
  if (candidates.length === 0) return empty;

  const windows = candidateWindows(candidates, state.spanMs);
  if (windows.length < 2) {
    // One window = the whole recording: there is nothing to choose between.
    return { ok: true, proposals: [], candidates: candidates.length, ranAgent: false };
  }

  const prompt = buildProposalPrompt({
    title: access.row.title,
    spanMs: state.spanMs,
    windows,
    utterances,
    nameFor,
    instruction: input.instruction ?? null,
  });

  try {
    const run = await runClaudeWithMeta(prompt, { effort: 'medium' });
    void recordAiRun({
      transcriptId: access.row.id,
      assemblyaiId: access.row.assemblyai_id,
      kind: 'clip_proposal',
      triggeredBy: { userId: input.by.userId, email: input.by.email },
      status: 'completed',
      meta: run.meta,
      promptChars: prompt.length,
      resultChars: run.text.length,
    });
    const proposals = adoptProposals(parseJsonFromClaude<unknown>(run.text), {
      windows,
      clips: state.clips,
      spanMs: state.spanMs,
    });
    return { ok: true, proposals, candidates: candidates.length, ranAgent: true };
  } catch (err) {
    void recordAiRun({
      transcriptId: access.row.id,
      assemblyaiId: access.row.assemblyai_id,
      kind: 'clip_proposal',
      triggeredBy: { userId: input.by.userId, email: input.by.email },
      status: 'error',
      error: String(err).slice(0, 1000),
      promptChars: prompt.length,
    });
    console.warn(`[clips] propose ${access.row.assemblyai_id} failed:`, err);
    // A failed suggestion is not a failed request: the dialog still works by
    // hand, and the deterministic boundaries were already free.
    return { ok: true, proposals: [], candidates: candidates.length, ranAgent: true };
  }
}
