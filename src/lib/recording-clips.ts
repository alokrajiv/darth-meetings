/**
 * Clip resolution — the pure half of the recordings resolver
 * (docs/recordings-phase1-spec.md §3).
 *
 * A MEETING's text is its ordered CLIPS over RECORDINGS: each clip selects
 * `[from_ms, to_ms)` of one recording's transcription and lands it at
 * `offset_ms` on the meeting's timeline. Nothing here touches the database,
 * the filesystem or `server-only` — `src/lib/server/recordings.ts` loads the
 * rows and calls in, and the tests drive this module directly.
 *
 * The contract that matters is COMPAT MODE: exactly one clip with defaults
 * returns the stored payload **verbatim** — same object, no map, no re-tag,
 * no re-join, plain `"<index>"` edit keys. Every live row is that case after
 * the backfill, so `/content`, `/edits`, `/speakers`, darth-cli and every
 * offline pin stay byte-identical. The non-compat branch below is written
 * and tested now so Phase 3 has nothing left to invent, but no prod row
 * reaches it yet.
 *
 * Two rulings from spec §5a are load-bearing here:
 *  - **The clip alone decides compat.** Whether the transcription covered
 *    the recording's canonical media does NOT enter into it: prefixing the
 *    speakers of a single-recording meeting helps nobody, and only
 *    `media[].transcribed` should say "this file was not heard".
 *  - **The meeting timeline orders clips by `offset_ms`, then `ord`.** `ord`
 *    is the clip's identity (its primary key with the meeting, what an edit
 *    key survives a re-window by), not its position.
 */

import type { TranscriptResponse } from '@/lib/format';

export const CLIP_TEXT_POLICIES = ['include', 'gap_fill', 'exclude'] as const;
export type ClipTextPolicy = (typeof CLIP_TEXT_POLICIES)[number];

export function isClipTextPolicy(v: unknown): v is ClipTextPolicy {
  return typeof v === 'string' && (CLIP_TEXT_POLICIES as readonly string[]).includes(v);
}

/**
 * How far a `gap_fill` clip must stay clear of an `include` clip's speech
 * before it is allowed to contribute (design §2.4 — the SI-BL case: a phone
 * clip filling a Teams video's dead-audio hole must not double up on the
 * edges where both mics caught the same words).
 */
export const GAP_FILL_TOLERANCE_MS = 1500;

/** One `meeting_clips` row plus the payload it reads. */
export interface ResolvableClip {
  ord: number;
  recordingId: string;
  fromMs: number;
  /** NULL = to the end of the recording. */
  toMs: number | null;
  offsetMs: number;
  textPolicy: ClipTextPolicy;
  /** The clip's transcription payload; null = the recording has none yet. */
  payload: TranscriptResponse | null;
}

/** Meeting-level facts the derived payload needs but clips can't know. */
export interface ClipMeetingFacts {
  /** The document's public id (`transcripts.assemblyai_id`). */
  id: string;
  createdAt: string;
  completedAt?: string | null;
}

export interface ResolvedClipContent {
  /** null = no clip has a payload (nothing to serve). */
  content: TranscriptResponse | null;
  /**
   * The edit-map key of each utterance in `content.utterances`, same order.
   * Compat: `"<index>"` — exactly what `transcript_edits.edits` is keyed by
   * today. Non-compat: `"<recordingId>:<index in that transcription>"`, so a
   * re-ordered or re-windowed meeting never re-points an existing edit
   * (design §2.2).
   */
  utteranceKeys: string[];
  compat: boolean;
}

type Utterance = NonNullable<TranscriptResponse['utterances']>[number];
type Word = NonNullable<TranscriptResponse['words']>[number];

/**
 * Compat = exactly one clip, no window, no shift, contributing text. That is
 * the WHOLE test (§5a): nothing about the recording's files, its media rows
 * or what the transcription happened to hear can take a 1:1 meeting out of
 * compat mode.
 */
export function isCompatClipSet(clips: ResolvableClip[]): boolean {
  if (clips.length !== 1) return false;
  const c = clips[0]!;
  return c.fromMs === 0 && c.toMs === null && c.offsetMs === 0 && c.textPolicy === 'include';
}

/**
 * Meeting-timeline order: where the clip lands (`offset_ms`) first, `ord`
 * only as the tie-break (§5a). Exported so the server resolver numbers its
 * media with the same order the text comes out in.
 */
export function compareClipsOnTimeline(
  a: { offsetMs: number; ord: number },
  b: { offsetMs: number; ord: number }
): number {
  return a.offsetMs - b.offsetMs || a.ord - b.ord;
}

/**
 * Is this a key `resolveClips` could have minted, i.e. something
 * `transcript_edits.edits` may legally be keyed by?
 *
 * Compat meetings key by plain utterance index — that is what every row in
 * prod uses and what the edits route has always validated. A multi-clip
 * meeting keys by `<recordingId>:<index in that recording's transcription>`
 * so a re-window or a re-order never re-points an existing edit (§2.2). The
 * key space is minted and validated in the same module on purpose.
 */
export function isUtteranceKey(key: string): boolean {
  return /^\d+$/.test(key) || /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}:\d+$/.test(key);
}

/** `from_ms <= start < to_ms` — lower bound inclusive, upper exclusive. */
function inWindow(clip: ResolvableClip, startMs: number): boolean {
  if (startMs < clip.fromMs) return false;
  return clip.toMs === null || startMs < clip.toMs;
}

/** Recording ms → meeting ms for this clip. */
function shift(clip: ResolvableClip, ms: number): number {
  return ms - clip.fromMs + clip.offsetMs;
}

function prefixSpeaker(recordingId: string, speaker: string | undefined): string | undefined {
  if (speaker === undefined) return undefined;
  return `${recordingId}:${speaker}`;
}

/** The one distinct value, or undefined when the inputs disagree / are empty. */
function singleValue<T>(values: Array<T | null | undefined>): T | undefined {
  const seen = values.filter((v): v is T => v !== null && v !== undefined);
  if (seen.length === 0) return undefined;
  const first = seen[0]!;
  return seen.every((v) => v === first) ? first : undefined;
}

interface Contribution {
  clip: ResolvableClip;
  /** Meeting-time utterances, paired with their stable key. */
  utterances: Array<{ u: Utterance; key: string }>;
  words: Word[];
  /** Meeting-time extent of the contributed utterances, [start, end]. */
  spanMs: [number, number] | null;
}

function contributionOf(clip: ResolvableClip): Contribution {
  const payload = clip.payload;
  const utterances: Contribution['utterances'] = [];
  const words: Word[] = [];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  (payload?.utterances ?? []).forEach((u, index) => {
    if (!inWindow(clip, u.start)) return;
    const start = shift(clip, u.start);
    const end = shift(clip, u.end);
    if (start < lo) lo = start;
    if (end > hi) hi = end;
    utterances.push({
      u: { ...u, start, end, speaker: prefixSpeaker(clip.recordingId, u.speaker) ?? u.speaker },
      key: `${clip.recordingId}:${index}`,
    });
  });

  // Words ride the same window so a word-level consumer (search highlight,
  // the karaoke line) never points outside its utterance.
  for (const w of payload?.words ?? []) {
    if (!inWindow(clip, w.start)) continue;
    words.push({
      ...w,
      start: shift(clip, w.start),
      end: shift(clip, w.end),
      speaker: prefixSpeaker(clip.recordingId, w.speaker),
    });
  }

  return {
    clip,
    utterances,
    words,
    spanMs: Number.isFinite(lo) ? [lo, hi] : null,
  };
}

/** Does this meeting-time interval sit within ±tolerance of any `include` speech? */
function nearIncludedSpeech(
  includedUtterances: Utterance[],
  start: number,
  end: number
): boolean {
  return includedUtterances.some(
    (v) => v.start - GAP_FILL_TOLERANCE_MS < end && start < v.end + GAP_FILL_TOLERANCE_MS
  );
}

function spansOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * Resolve a meeting's clips into the payload `/content` serves.
 *
 * Compat mode returns `clips[0].payload` by reference — callers may rely on
 * that identity (it is what keeps the JSON byte-identical). There is no
 * caller-supplied override: the clip decides, and nothing else (§5a).
 */
export function resolveClips(
  clips: ResolvableClip[],
  meeting: ClipMeetingFacts
): ResolvedClipContent {
  const ordered = [...clips].sort(compareClipsOnTimeline);

  if (isCompatClipSet(ordered)) {
    const payload = ordered[0]!.payload;
    return {
      content: payload,
      utteranceKeys: (payload?.utterances ?? []).map((_, i) => String(i)),
      compat: true,
    };
  }

  const contributions = ordered
    .filter((c) => c.payload && c.textPolicy !== 'exclude')
    .map(contributionOf);

  // `gap_fill` is resolved against every `include` clip's speech, whatever
  // their ord — a filler clip placed first must still yield to a later
  // primary one.
  const includedUtterances = contributions
    .filter((c) => c.clip.textPolicy === 'include')
    .flatMap((c) => c.utterances.map((e) => e.u));

  const kept = contributions.map((c) => {
    if (c.clip.textPolicy !== 'gap_fill') return c;
    const utterances = c.utterances.filter(
      (e) => !nearIncludedSpeech(includedUtterances, e.u.start, e.u.end)
    );
    const windows = utterances.map((e) => e.u);
    const words = c.words.filter((w) => windows.some((u) => w.start >= u.start && w.start < u.end));
    const lo = utterances.length ? Math.min(...utterances.map((e) => e.u.start)) : null;
    const hi = utterances.length ? Math.max(...utterances.map((e) => e.u.end)) : null;
    return {
      ...c,
      utterances,
      words,
      spanMs: lo !== null && hi !== null ? ([lo, hi] as [number, number]) : null,
    };
  });

  // Concatenate in timeline order (`offset_ms`, then `ord`); only sort by
  // utterance time when two clips genuinely overlap on the meeting timeline
  // (back-to-back clips must keep their clip order even when a stray end
  // time bleeds a few ms into the next one).
  const spans = kept.map((c) => c.spanMs).filter((s): s is [number, number] => s !== null);
  const overlapping = spans.some((a, i) => spans.slice(i + 1).some((b) => spansOverlap(a, b)));

  const merged = kept.flatMap((c) => c.utterances);
  if (overlapping) merged.sort((a, b) => a.u.start - b.u.start);
  const mergedWords = kept.flatMap((c) => c.words);
  if (overlapping) mergedWords.sort((a, b) => a.start - b.start);

  const payloads = kept.map((c) => c.clip.payload!);
  if (payloads.length === 0) {
    return { content: null, utteranceKeys: [], compat: false };
  }

  const endMs = merged.reduce((max, e) => Math.max(max, e.u.end), 0);
  const status: TranscriptResponse['status'] = payloads.some((p) => p.status === 'error')
    ? 'error'
    : payloads.every((p) => p.status === 'completed')
      ? 'completed'
      : 'processing';

  const content: TranscriptResponse = {
    id: meeting.id,
    status,
    // AAI's own `text` is the raw join of the utterance texts; a merged
    // meeting's is the join of what it actually shows.
    text: merged.map((e) => e.u.text).join(' '),
    created: meeting.createdAt,
    ...(meeting.completedAt ? { completed: meeting.completedAt } : {}),
    ...(endMs > 0 ? { audio_duration: endMs / 1000 } : {}),
    utterances: merged.map((e) => e.u),
    ...(mergedWords.length ? { words: mergedWords } : {}),
    // Job-level facts only survive when every contributing transcription
    // agrees — two recordings in two languages have no single language_code.
    ...(singleValue(payloads.map((p) => p.language_code)) !== undefined
      ? { language_code: singleValue(payloads.map((p) => p.language_code)) }
      : {}),
    ...(singleValue(payloads.map((p) => p.confidence)) !== undefined
      ? { confidence: singleValue(payloads.map((p) => p.confidence)) }
      : {}),
    ...(singleValue(payloads.map((p) => p.speech_model_used)) !== undefined
      ? { speech_model_used: singleValue(payloads.map((p) => p.speech_model_used)) }
      : {}),
  };

  return { content, utteranceKeys: merged.map((e) => e.key), compat: false };
}
