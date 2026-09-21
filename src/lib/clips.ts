/**
 * Clips — one recording, several meetings (Phase 3a,
 * docs/recordings-phase3-clips-spec.md).
 *
 * THE WIRE CONTRACT. The routes under `/api/transcripts/:id/clips*`, the
 * transcript page's split dialog and the windowed player all speak the types
 * below, and every piece of arithmetic a split needs — window validation,
 * timestamp parsing, the hole maths, the edit re-keying both ways, the
 * deterministic proposal candidates — is a pure function here so it can be
 * unit-tested without a database and reused on the client.
 *
 * Vocabulary (design §7): a **meeting** is the document; a **recording** is
 * one capture with ONE transcription and ONE diarization space; a **clip** is
 * a `[from_ms, to_ms)` window of a recording that a meeting uses. Splitting
 * cuts no file and re-transcribes nothing (DEC-2) — it only chooses windows.
 *
 * Two rules the whole file leans on:
 *
 *  - **A split meeting's text is MATERIALISED onto its row.** The meeting row
 *    stays what every reader reads (Phase 1), so edits stay keyed by the plain
 *    array index into that materialised list — which is why splitting has to
 *    re-key them, and why `rekeyEditMap` / `mergeEditMaps` below are the two
 *    functions that must never be wrong.
 *  - **The source keeps its own timeline.** Shrinking meeting M leaves a HOLE
 *    where the window was rather than closing the gap, so every `t:<ms>` and
 *    `frame:<ms>` already written into M's notes still points at the right
 *    moment. The new meeting N starts at 0.
 *
 * Pure on purpose: no `server-only`, no db, no fs, no Node built-ins. Safe to
 * import from a client component.
 */

import type { TranscriptEditMap } from '@/lib/format';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * One clip: a window of a recording placed on a meeting's timeline.
 *
 * Mirrors a `meeting_clips` row (migration 044) and is also what the meeting
 * row carries in `gmeet_context.clips` — see `StoredClips`.
 */
export interface ClipWindow {
  /** The clip's identity within the meeting (`meeting_clips.ord`), NOT its
   * position: the timeline order is `offsetMs`, then `ord` (spec §5a). */
  ord: number;
  recordingId: string;
  fromMs: number;
  /** null = to the end of the recording. */
  toMs: number | null;
  /** Where `fromMs` lands on the MEETING timeline. */
  offsetMs: number;
}

/**
 * `transcripts.gmeet_context.clips` — the meeting row's mirror of its clip
 * rows.
 *
 * It exists because the desired recording graph is derived FROM THE ROW
 * (`lib/recording-graph.ts`): without a mirror, the next dual-write would
 * "heal" a split meeting back to one full-recording clip and silently undo the
 * split. With it, the row still says everything, `deriveRecordingGraph` honours
 * it, and `scripts/recordings-verify.ts` compares against the same thing.
 *
 * Absent (the normal case, and every row on prod today) = one clip over the
 * whole recording, which is what `desiredClipFor` has always produced.
 */
export type StoredClips = ClipWindow[];

/** `gmeet_context.splitFrom` on a meeting that was split off another one. */
export interface SplitProvenance {
  /** The SOURCE meeting's public id. NEVER served to a caller who cannot
   * open that meeting — its existence is itself a leak (spec §API). */
  meetingId: string;
  /** The window of the recording this meeting took, in recording ms. */
  fromMs: number;
  toMs: number;
  at: string;
  by?: { email: string | null; name: string | null } | null;
}

/** A gap on a meeting's timeline: a part of the recording that is now a
 * meeting of its own. The player skips it; the transcript shows a divider. */
export interface ClipHole {
  fromMs: number;
  toMs: number;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * `mm:ss`, `h:mm:ss`, or a plain number of milliseconds — what
 * `darth-cli meetings split --from 12:40 --to 41:05` accepts and what the
 * split dialog parses from a typed field.
 *
 * A bare number is ALWAYS milliseconds (never seconds): the API speaks ms
 * everywhere else and guessing a unit from magnitude would be a trap.
 * Returns null for anything it cannot read — callers refuse rather than
 * default.
 */
export function parseTimestampMs(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  }
  const text = raw.trim();
  if (!text) return null;
  if (/^[0-9]+$/.test(text)) return Number.parseInt(text, 10);
  const clock = /^([0-9]{1,3}):([0-5]?[0-9])(?::([0-5]?[0-9]))?(?:\.([0-9]{1,3}))?$/.exec(text);
  if (!clock) return null;
  const [, a, b, c, frac] = clock;
  // Two groups = m:ss; three = h:mm:ss.
  const hours = c !== undefined ? Number.parseInt(a!, 10) : 0;
  const minutes = c !== undefined ? Number.parseInt(b!, 10) : Number.parseInt(a!, 10);
  const seconds = c !== undefined ? Number.parseInt(c, 10) : Number.parseInt(b!, 10);
  const millis = frac ? Number.parseInt(frac.padEnd(3, '0'), 10) : 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** `m:ss`, or `h:mm:ss` past the hour — the form the UI and the CLI print. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "28m 25s" / "1h 04m" — the duration the split dialog shows live. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Window validation
// ---------------------------------------------------------------------------

/** A window shorter than this is a mis-drag, not a meeting. */
export const MIN_CLIP_MS = 10_000;
/** Shrinking may not leave the source with less than this outside the window
 * — "split off everything" is a rename, not a split. */
export const MIN_REMAINDER_MS = 10_000;

export type SplitRefusalCode =
  | 'window-too-short'
  | 'window-covers-everything'
  | 'window-outside'
  | 'window-crosses-hole'
  | 'window-invalid'
  | 'not-completed'
  | 'transcribing'
  | 'multi-recording'
  | 'shared-job'
  | 'no-clip'
  | 'disabled';

export interface SplitRefusal {
  code: SplitRefusalCode;
  /** Shown to the user verbatim. */
  message: string;
}

const REFUSAL_TEXT: Record<SplitRefusalCode, string> = {
  'window-too-short': `A part has to be at least ${MIN_CLIP_MS / 1000} seconds long.`,
  'window-covers-everything':
    'That covers (almost) the whole meeting — there would be nothing left here. Rename this meeting instead, or tick “keep it in this meeting too”.',
  'window-outside': 'That range is outside this meeting’s recording.',
  'window-crosses-hole':
    'That range runs across a part that is already its own meeting. Pick a range inside one stretch.',
  'window-invalid': 'The start has to come before the end.',
  'not-completed': 'This meeting is still being transcribed.',
  transcribing: 'A new transcription is running — wait for it to land before splitting.',
  'multi-recording': 'This meeting is made of more than one recording, which cannot be split yet.',
  'shared-job':
    'This meeting shares its transcription with another person’s copy of the same call, so it cannot be split.',
  'no-clip': 'This meeting has no recording to take a part of.',
  disabled: 'Splitting is not available on this server.',
};

export function splitRefusal(code: SplitRefusalCode, message?: string): SplitRefusal {
  return { code, message: message ?? REFUSAL_TEXT[code] };
}

/**
 * Is `[fromMs, toMs)` a window this meeting can give away?
 *
 * `clips` are the meeting's current clips; `spanMs` is how long the meeting
 * runs on its own timeline. Pure, so the dialog can grey out "Split" for
 * exactly the reasons the server will refuse for.
 */
export function validateSplitWindow(input: {
  clips: ClipWindow[];
  fromMs: number;
  toMs: number;
  spanMs: number;
  keepInBoth?: boolean;
}): SplitRefusal | null {
  const { clips, fromMs, toMs, spanMs } = input;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0) {
    return splitRefusal('window-invalid');
  }
  if (toMs <= fromMs) return splitRefusal('window-invalid');
  if (toMs - fromMs < MIN_CLIP_MS) return splitRefusal('window-too-short');
  if (clips.length === 0) return splitRefusal('no-clip');
  if (new Set(clips.map((c) => c.recordingId)).size > 1) return splitRefusal('multi-recording');

  // The window is expressed on the MEETING timeline (what the player shows);
  // it has to sit inside ONE clip, or it would span a hole that belongs to
  // somebody else's meeting.
  const host = hostClipFor(clips, fromMs, toMs, spanMs);
  if (host === 'outside') return splitRefusal('window-outside');
  if (host === 'crosses') return splitRefusal('window-crosses-hole');

  if (!input.keepInBoth && spanMs - (toMs - fromMs) < MIN_REMAINDER_MS) {
    return splitRefusal('window-covers-everything');
  }
  return null;
}

/** Meeting-timeline extent of one clip. `toMs: null` runs to `spanMs`. */
export function clipExtentMs(clip: ClipWindow, spanMs: number): [number, number] {
  const start = clip.offsetMs;
  const end = clip.toMs === null ? Math.max(start, spanMs) : clip.offsetMs + (clip.toMs - clip.fromMs);
  return [start, end];
}

/**
 * Which clip holds the whole window, or why none does. Exported for the
 * dialog's live validation; `validateSplitWindow` is the usual entry point.
 */
export function hostClipFor(
  clips: ClipWindow[],
  fromMs: number,
  toMs: number,
  spanMs: number
): ClipWindow | 'outside' | 'crosses' {
  let touched = 0;
  let host: ClipWindow | null = null;
  for (const clip of clips) {
    const [lo, hi] = clipExtentMs(clip, spanMs);
    if (fromMs < hi && lo < toMs) touched += 1;
    if (fromMs >= lo && toMs <= hi) host = clip;
  }
  if (host) return host;
  return touched > 1 ? 'crosses' : 'outside';
}

/** How long the meeting runs on its own timeline, given its clips. */
export function meetingSpanMs(clips: ClipWindow[], recordingDurationMs: number | null): number {
  let span = 0;
  for (const clip of clips) {
    const length =
      clip.toMs === null
        ? Math.max(0, (recordingDurationMs ?? clip.fromMs) - clip.fromMs)
        : Math.max(0, clip.toMs - clip.fromMs);
    span = Math.max(span, clip.offsetMs + length);
  }
  return span;
}

/**
 * The gaps between a meeting's clips on its own timeline — the parts that were
 * split off. `[]` for every meeting that has never been split.
 */
export function holesOf(clips: ClipWindow[], spanMs: number): ClipHole[] {
  const extents = clips
    .map((c) => clipExtentMs(c, spanMs))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const holes: ClipHole[] = [];
  let cursor = 0;
  for (const [lo, hi] of extents) {
    if (lo > cursor) holes.push({ fromMs: cursor, toMs: lo });
    cursor = Math.max(cursor, hi);
  }
  return holes;
}

/**
 * The bounds a PLAYER must clamp to for one recording — what the server puts
 * on `ResolvedMedia.windowFromMs` / `windowToMs`.
 *
 * `null` for both = the whole file, which is what a source meeting keeps after
 * a shrink (it still plays every second of the file; the hole is described
 * separately). A split-off meeting gets its real window.
 */
export function windowBoundsFor(
  clips: ClipWindow[],
  recordingId: string
): { fromMs: number | null; toMs: number | null } {
  const mine = clips.filter((c) => c.recordingId === recordingId);
  if (mine.length === 0) return { fromMs: null, toMs: null };
  const from = Math.min(...mine.map((c) => c.fromMs));
  const to = mine.some((c) => c.toMs === null) ? null : Math.max(...mine.map((c) => c.toMs!));
  if (from === 0 && to === null) return { fromMs: null, toMs: null };
  return { fromMs: from, toMs: to };
}

// ---------------------------------------------------------------------------
// The split itself
// ---------------------------------------------------------------------------

export interface SplitPlan {
  /** What the SOURCE meeting's clips become. Unchanged with `keepInBoth`. */
  source: ClipWindow[];
  /** The new meeting's clips — always exactly one, starting at 0. */
  created: ClipWindow[];
  /** The window in RECORDING ms (what `splitFrom` records). */
  recordingFromMs: number;
  recordingToMs: number;
  /** True = the source now has a gap where the window was. */
  leavesHole: boolean;
}

/**
 * Turn "[from, to) of this meeting becomes its own meeting" into the two clip
 * sets, in recording terms.
 *
 * The source SHRINKS by default (D-D): its host clip becomes two clips whose
 * `offset_ms` keep the source's original timeline, so nothing in its notes
 * moves. With `keepInBoth` the source is untouched and the window simply
 * exists in two meetings — legal in the model either way.
 *
 * The window arrives on the MEETING timeline (what the player shows) and comes
 * back translated into the RECORDING's, which is what a clip row stores.
 */
export function planSplit(input: {
  clips: ClipWindow[];
  fromMs: number;
  toMs: number;
  spanMs: number;
  keepInBoth?: boolean;
}): SplitPlan | SplitRefusal {
  const refusal = validateSplitWindow(input);
  if (refusal) return refusal;
  const host = hostClipFor(input.clips, input.fromMs, input.toMs, input.spanMs) as ClipWindow;

  // Meeting ms → recording ms inside the host clip.
  const toRecording = (meetingMs: number) => meetingMs - host.offsetMs + host.fromMs;
  const recordingFromMs = toRecording(input.fromMs);
  const recordingToMs = toRecording(input.toMs);

  const created: ClipWindow[] = [
    {
      ord: 0,
      recordingId: host.recordingId,
      fromMs: recordingFromMs,
      toMs: recordingToMs,
      offsetMs: 0,
    },
  ];

  if (input.keepInBoth) {
    return {
      source: [...input.clips],
      created,
      recordingFromMs,
      recordingToMs,
      leavesHole: false,
    };
  }

  const nextOrd = Math.max(-1, ...input.clips.map((c) => c.ord)) + 1;
  const head: ClipWindow = { ...host, toMs: recordingFromMs };
  const tail: ClipWindow = {
    ord: nextOrd,
    recordingId: host.recordingId,
    fromMs: recordingToMs,
    toMs: host.toMs,
    offsetMs: input.toMs,
  };

  // A window flush against an edge of its host leaves no hole, just a shorter
  // clip — do not write an empty one. An open-ended host (`toMs: null`, "to
  // the end") is empty when the window ran to the end of the meeting, which
  // the clip row alone cannot say: `spanMs` is what knows.
  const [, hostEndMs] = clipExtentMs(host, input.spanMs);
  const source = input.clips.flatMap((c) => {
    if (c.ord !== host.ord) return [c];
    const keep: ClipWindow[] = [];
    if (head.toMs! > head.fromMs) keep.push(head);
    const tailIsEmpty = tail.toMs === null ? input.toMs >= hostEndMs : tail.toMs <= tail.fromMs;
    if (!tailIsEmpty) keep.push(tail);
    return keep;
  });

  return {
    source: renumberIfEmptied(source),
    created,
    recordingFromMs,
    recordingToMs,
    leavesHole: source.length > input.clips.length,
  };
}

/**
 * A source left with exactly one clip after a flush-to-the-edge split gets
 * `ord 0` back, so it is indistinguishable from a meeting that was clipped
 * that way from the start (and `recordings-verify` has one shape to check).
 */
function renumberIfEmptied(clips: ClipWindow[]): ClipWindow[] {
  if (clips.length !== 1) return clips;
  return [{ ...clips[0]!, ord: 0 }];
}

/**
 * "Put it back": the source's clips with the new meeting's window merged in
 * again. Returns null when the two do not fit — the hole has moved, the source
 * was re-clipped, or they are not on the same recording — in which case the
 * caller refuses rather than guessing.
 */
export function planUnsplit(input: {
  sourceClips: ClipWindow[];
  clip: ClipWindow;
}): ClipWindow[] | null {
  const { clip } = input;
  if (clip.toMs === null) return null;
  const mine = input.sourceClips.filter((c) => c.recordingId === clip.recordingId);
  if (mine.length !== input.sourceClips.length) return null;

  const head = mine.find((c) => c.toMs === clip.fromMs);
  const tail = mine.find((c) => c.fromMs === clip.toMs);
  if (!head && !tail) return null;

  const merged: ClipWindow = {
    ord: head?.ord ?? tail?.ord ?? 0,
    recordingId: clip.recordingId,
    fromMs: head?.fromMs ?? clip.fromMs,
    toMs: tail ? tail.toMs : clip.toMs,
    // Where the merged clip sits on the SOURCE's timeline. With a head it is
    // the head's own place. With only a tail (the window was flush against
    // the start of its host clip) it is the tail's place walked back by the
    // recording ms the window gives back — NOT `clip.offsetMs`, which is the
    // split-off meeting's own zero and would drop the merged clip on top of
    // whatever the source still has at the front.
    offsetMs: head ? head.offsetMs : tail!.offsetMs - (tail!.fromMs - clip.fromMs),
  };
  const rest = mine.filter((c) => c.ord !== head?.ord && c.ord !== tail?.ord);
  return renumberIfEmptied([merged, ...rest].sort((a, b) => a.offsetMs - b.offsetMs || a.ord - b.ord));
}

// ---------------------------------------------------------------------------
// Utterance selection and edit re-keying (landmine #2)
// ---------------------------------------------------------------------------

/**
 * Which utterances of a meeting fall inside `[fromMs, toMs)` on its timeline,
 * by index. Lower bound inclusive, upper exclusive — the same rule
 * `resolveClips` windows a recording by, so the split and the resolver can
 * never disagree about an utterance that starts exactly on a boundary.
 */
export function selectWindow(
  startsMs: number[],
  fromMs: number,
  toMs: number
): { inside: number[]; outside: number[] } {
  const inside: number[] = [];
  const outside: number[] = [];
  startsMs.forEach((start, index) => {
    if (start >= fromMs && start < toMs) inside.push(index);
    else outside.push(index);
  });
  return { inside, outside };
}

/**
 * Re-key an edit map onto a new utterance list. `pick[j]` is the OLD index
 * that becomes index `j`; every other edit is dropped, because the utterance
 * it described is not in this meeting any more.
 *
 * This is the whole of landmine #2 in five lines, and it runs in both
 * directions: the new meeting picks the window's indices, the source picks
 * everything else.
 */
export function rekeyEditMap(edits: TranscriptEditMap | null, pick: number[]): TranscriptEditMap {
  const out: TranscriptEditMap = {};
  if (!edits) return out;
  pick.forEach((oldIndex, newIndex) => {
    const entry = edits[String(oldIndex)];
    if (entry) out[String(newIndex)] = entry;
  });
  return out;
}

/** Where a merged utterance came from when a split is undone. */
export interface MergeSlot {
  from: 'source' | 'clip';
  index: number;
}

/**
 * The merge order for an un-split: the source's remaining utterances and the
 * split-off meeting's, back on ONE timeline, ordered by start.
 *
 * `clipStartsMs` must already be translated onto the source's timeline (clip
 * start + the window's offset) — the caller holds the offset, this function
 * only merges. Ties keep the SOURCE first, which is what makes the operation
 * exactly reversible for a window that was flush against an utterance.
 */
export function mergeOrder(sourceStartsMs: number[], clipStartsMs: number[]): MergeSlot[] {
  const slots: MergeSlot[] = [];
  let i = 0;
  let j = 0;
  while (i < sourceStartsMs.length || j < clipStartsMs.length) {
    const a = i < sourceStartsMs.length ? sourceStartsMs[i]! : Number.POSITIVE_INFINITY;
    const b = j < clipStartsMs.length ? clipStartsMs[j]! : Number.POSITIVE_INFINITY;
    if (a <= b) slots.push({ from: 'source', index: i++ });
    else slots.push({ from: 'clip', index: j++ });
  }
  return slots;
}

/** Both halves' edits back on one map, using the merge order. */
export function mergeEditMaps(
  sourceEdits: TranscriptEditMap | null,
  clipEdits: TranscriptEditMap | null,
  slots: MergeSlot[]
): TranscriptEditMap {
  const out: TranscriptEditMap = {};
  slots.forEach((slot, newIndex) => {
    const from = slot.from === 'source' ? sourceEdits : clipEdits;
    const entry = from?.[String(slot.index)];
    if (entry) out[String(newIndex)] = entry;
  });
  return out;
}

/** How many entries a re-key actually carried — what the API reports as
 * `moved.edits`. */
export function countEdits(edits: TranscriptEditMap | null | undefined): number {
  return edits ? Object.keys(edits).length : 0;
}

// ---------------------------------------------------------------------------
// The proposer's deterministic half
// ---------------------------------------------------------------------------

export type ClipCandidateKind =
  | 'speaker-enter'
  | 'speaker-leave'
  | 'silence'
  | 'calendar-start'
  | 'calendar-end';

/** A moment the recording could reasonably be cut at. */
export interface ClipBoundaryCandidate {
  /** Meeting ms. */
  atMs: number;
  kind: ClipCandidateKind;
  /** One line a human (or the agent) can read: "Paola first speaks". */
  label: string;
  /** Calendar candidates only — the event key a proposal may carry. */
  eventRef?: string;
  /** Calendar candidates only — the event's title. */
  title?: string;
}

/** A silence has to be at least this long to be a boundary (spec §API). */
export const MIN_SILENCE_MS = 45_000;

/** More than a handful of presets is a list, not a suggestion. */
export const MAX_PROPOSALS = 6;

/** The shape the candidate extractors need out of an utterance. */
export interface CandidateUtterance {
  startMs: number;
  endMs: number;
  speaker: string;
}

/**
 * "When did Paola come in / leave" — the first and last time each speaker is
 * heard. A speaker who talks through the whole recording is NOT a boundary
 * (their first word is 0 and their last is the end), so they are dropped.
 */
export function speakerBoundaries(
  utterances: CandidateUtterance[],
  nameFor: (speaker: string) => string = (s) => `Speaker ${s}`,
  opts: { edgeToleranceMs?: number } = {}
): ClipBoundaryCandidate[] {
  if (utterances.length === 0) return [];
  const edge = opts.edgeToleranceMs ?? 60_000;
  const firstMs = Math.min(...utterances.map((u) => u.startMs));
  const lastMs = Math.max(...utterances.map((u) => u.endMs));

  const seen = new Map<string, { first: number; last: number }>();
  for (const u of utterances) {
    const cur = seen.get(u.speaker);
    if (!cur) seen.set(u.speaker, { first: u.startMs, last: u.endMs });
    else {
      cur.first = Math.min(cur.first, u.startMs);
      cur.last = Math.max(cur.last, u.endMs);
    }
  }

  const out: ClipBoundaryCandidate[] = [];
  for (const [speaker, span] of seen) {
    const who = nameFor(speaker);
    if (span.first - firstMs > edge) {
      out.push({ atMs: span.first, kind: 'speaker-enter', label: `${who} is first heard` });
    }
    if (lastMs - span.last > edge) {
      out.push({ atMs: span.last, kind: 'speaker-leave', label: `${who} is last heard` });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Gaps of `minMs` or more between one utterance ending and the next starting —
 * the usual seam between "the podcast" and "the 1:1 that came after".
 */
export function silenceBoundaries(
  utterances: CandidateUtterance[],
  minMs: number = MIN_SILENCE_MS
): ClipBoundaryCandidate[] {
  const ordered = [...utterances].sort((a, b) => a.startMs - b.startMs);
  const out: ClipBoundaryCandidate[] = [];
  let previousEnd: number | null = null;
  for (const u of ordered) {
    if (previousEnd !== null && u.startMs - previousEnd >= minMs) {
      out.push({
        atMs: u.startMs,
        kind: 'silence',
        label: `${formatDuration(u.startMs - previousEnd)} of silence ends here`,
      });
    }
    previousEnd = previousEnd === null ? u.endMs : Math.max(previousEnd, u.endMs);
  }
  return out;
}

/** A calendar occurrence the recording overlaps, in wall-clock terms. */
export interface CandidateEvent {
  eventRef: string;
  title: string | null;
  startMs: number;
  endMs: number | null;
}

/**
 * Where the owner's calendar says one thing ended and another began, mapped
 * onto the meeting timeline. Events that start before the recording (or end
 * after it) contribute only the boundary that is actually inside it.
 */
export function calendarBoundaries(
  events: CandidateEvent[],
  recordingStartMs: number | null,
  spanMs: number
): ClipBoundaryCandidate[] {
  if (recordingStartMs === null) return [];
  const out: ClipBoundaryCandidate[] = [];
  for (const e of events) {
    const start = e.startMs - recordingStartMs;
    const end = e.endMs === null ? null : e.endMs - recordingStartMs;
    const name = e.title?.trim() || 'a calendar event';
    if (start > 0 && start < spanMs) {
      out.push({
        atMs: start,
        kind: 'calendar-start',
        label: `“${name}” starts here`,
        eventRef: e.eventRef,
        title: e.title ?? undefined,
      });
    }
    if (end !== null && end > 0 && end < spanMs) {
      out.push({
        atMs: end,
        kind: 'calendar-end',
        label: `“${name}” ends here`,
        eventRef: e.eventRef,
        title: e.title ?? undefined,
      });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Every deterministic boundary, in time order, with near-duplicates collapsed
 * (a speaker arriving at the same moment a calendar event starts is ONE
 * boundary — the calendar one, because it can name the meeting).
 */
export function clipCandidates(input: {
  utterances: CandidateUtterance[];
  nameFor?: (speaker: string) => string;
  events?: CandidateEvent[];
  recordingStartMs?: number | null;
  spanMs: number;
  mergeWithinMs?: number;
}): ClipBoundaryCandidate[] {
  const merge = input.mergeWithinMs ?? 15_000;
  const all = [
    ...calendarBoundaries(input.events ?? [], input.recordingStartMs ?? null, input.spanMs),
    ...silenceBoundaries(input.utterances),
    ...speakerBoundaries(input.utterances, input.nameFor),
  ].sort((a, b) => a.atMs - b.atMs || rank(a.kind) - rank(b.kind));

  const kept: ClipBoundaryCandidate[] = [];
  for (const c of all) {
    if (c.atMs <= 0 || c.atMs >= input.spanMs) continue;
    const near = kept.find((k) => Math.abs(k.atMs - c.atMs) <= merge);
    if (near) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.atMs - b.atMs);
}

/** Calendar beats silence beats a speaker when two land together. */
function rank(kind: ClipCandidateKind): number {
  switch (kind) {
    case 'calendar-start':
    case 'calendar-end':
      return 0;
    case 'silence':
      return 1;
    default:
      return 2;
  }
}

/**
 * The windows the boundaries imply: every consecutive pair, plus the head and
 * the tail, dropped when shorter than `MIN_CLIP_MS`. This is what the single
 * agent call is asked to PICK FROM and name — it never invents a boundary of
 * its own, which is what makes "no strong boundary ⇒ an empty list" possible.
 */
export function candidateWindows(
  candidates: ClipBoundaryCandidate[],
  spanMs: number
): Array<{ fromMs: number; toMs: number; startedBy: ClipBoundaryCandidate | null; endedBy: ClipBoundaryCandidate | null }> {
  const marks = [0, ...candidates.map((c) => c.atMs), spanMs];
  const out: Array<{
    fromMs: number;
    toMs: number;
    startedBy: ClipBoundaryCandidate | null;
    endedBy: ClipBoundaryCandidate | null;
  }> = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const fromMs = marks[i]!;
    const toMs = marks[i + 1]!;
    if (toMs - fromMs < MIN_CLIP_MS) continue;
    out.push({
      fromMs,
      toMs,
      startedBy: i === 0 ? null : (candidates[i - 1] ?? null),
      endedBy: i === marks.length - 2 ? null : (candidates[i] ?? null),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adopting the proposer's answer
// ---------------------------------------------------------------------------

interface RawProposal {
  fromMs?: unknown;
  toMs?: unknown;
  title?: unknown;
  reason?: unknown;
  eventRef?: unknown;
  confidence?: unknown;
}

/**
 * Turn whatever the proposer's single agent call said into proposals this
 * server would actually accept — pure, so it is tested without a model.
 *
 * Every proposal must SNAP to one of the deterministic windows (or a run of
 * consecutive ones): the model picks and names, it does not choose new
 * timestamps. Anything that does not land on a real boundary, or that
 * `validateSplitWindow` would refuse, is dropped rather than shown to
 * somebody as a one-click preset that then fails.
 */
export function adoptProposals(
  raw: unknown,
  input: {
    windows: Array<{ fromMs: number; toMs: number; startedBy: ClipBoundaryCandidate | null; endedBy: ClipBoundaryCandidate | null }>;
    clips: ClipWindow[];
    spanMs: number;
  }
): ClipProposal[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { proposals?: unknown })?.proposals)
      ? (raw as { proposals: unknown[] }).proposals
      : [];
  // The moments the model may name: every boundary either side of a window.
  const marks = new Set<number>();
  for (const w of input.windows) {
    marks.add(w.fromMs);
    marks.add(w.toMs);
  }
  const snap = (value: number): number | null => {
    let best: number | null = null;
    for (const m of marks) {
      if (best === null || Math.abs(m - value) < Math.abs(best - value)) best = m;
    }
    // 2 s: a model that read "12:40" off the prompt may re-emit 760000 rather
    // than 760117. Further than that and it made the number up.
    return best !== null && Math.abs(best - value) <= 2000 ? best : null;
  };

  const out: ClipProposal[] = [];
  const seen = new Set<string>();
  for (const entry of list as RawProposal[]) {
    if (!entry || typeof entry !== 'object') continue;
    const from = snap(Number(entry.fromMs));
    const to = snap(Number(entry.toMs));
    if (from === null || to === null || to - from < MIN_CLIP_MS) continue;
    if (validateSplitWindow({ clips: input.clips, fromMs: from, toMs: to, spanMs: input.spanMs })) {
      continue;
    }
    const key = `${from}-${to}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const started = input.windows.find((w) => w.fromMs === from)?.startedBy ?? null;
    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 120) : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 200) : '';
    const confidence = Number(entry.confidence);
    out.push({
      fromMs: from,
      toMs: to,
      title: title || `${formatTimestamp(from)} – ${formatTimestamp(to)}`,
      reason: reason || started?.label || 'A distinct stretch of this recording',
      // Only an eventRef the deterministic pass actually found is carried —
      // the model must not be able to name an arbitrary calendar event.
      ...(typeof entry.eventRef === 'string' && entry.eventRef === started?.eventRef
        ? { eventRef: started.eventRef }
        : {}),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      ...(started ? { basis: started.kind } : {}),
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out.sort((a, b) => a.fromMs - b.fromMs);
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** One "also from this recording" row. Only meetings the CALLER can open are
 * ever listed (spec §API — a sibling's id, title, count or timing is a leak). */
export interface ClipSibling {
  id: string;
  url: string;
  title: string | null;
  /** The sibling's own window, in RECORDING ms. */
  fromMs: number;
  toMs: number | null;
  durationMs: number | null;
  /** True = this meeting was split off that one. */
  isSource: boolean;
  /** True = that one was split off this meeting. */
  isSplitOff: boolean;
  /** In the trash — still holds its clip, still keeps the bytes alive. */
  trashed: boolean;
}

/** GET /api/transcripts/:id/clips */
export interface ClipsResponse {
  /** False = `MW_CLIPS` off, migrations missing, or this meeting has no clip:
   * the UI hides everything about clips and nothing else changes. */
  enabled: boolean;
  canEdit: boolean;
  recording: { id: string; durationMs: number | null; startedAt: string | null } | null;
  clips: ClipWindow[];
  /** How long this meeting runs on its own timeline. */
  spanMs: number;
  /** What the player clamps to; null = the whole file. */
  window: { fromMs: number; toMs: number | null } | null;
  holes: ClipHole[];
  siblings: ClipSibling[];
  /** Present ONLY when the caller can open the source meeting. */
  splitFrom: (SplitProvenance & { title: string | null; url: string }) | null;
  /** True = "put it back" is offered. */
  canUnsplit: boolean;
  /** Why not, in words that never name a meeting the caller cannot open. */
  unsplitBlockedReason: string | null;
}

/** POST /api/transcripts/:id/split */
export interface SplitRequest {
  /** Meeting ms. `from`/`to` are the CLI's `mm:ss` form and are parsed with
   * `parseTimestampMs`; the ms fields win when both are sent. */
  fromMs?: number;
  toMs?: number;
  from?: string;
  to?: string;
  title?: string;
  /** A calendar reference — `<eventId>|<startIso>` or a meeting code, exactly
   * what `link-event` accepts. Links the new meeting and auto-shares to the
   * invitees, as an upload linked to that event would. */
  eventRef?: string;
  /** Leave the source untouched and let both meetings use the window (D-D). */
  keepInBoth?: boolean;
}

export interface SplitOk {
  ok: true;
  meeting: {
    id: string;
    url: string;
    title: string | null;
    /** The window, in RECORDING ms. */
    fromMs: number;
    toMs: number;
    durationMs: number;
  };
  moved: { edits: number; speakerNames: number };
  source: {
    clips: ClipWindow[];
    /** True = the source now carries the "part of this was split off" marker. */
    notesStale: boolean;
  };
  /** Set when `eventRef` was given and resolved. */
  linkedEvent?: { title: string | null; startTime: string | null; attendees: number };
}

export type SplitResponse = SplitOk | { error: string; code?: SplitRefusalCode };

/** POST /api/transcripts/:id/unsplit — sent from the SPLIT-OFF meeting. */
export interface UnsplitOk {
  ok: true;
  /** Where to go now: the source meeting. */
  meeting: { id: string; url: string; title: string | null };
  restored: { edits: number };
}

export type UnsplitResponse = UnsplitOk | { error: string };

/** POST /api/transcripts/:id/clips/propose */
export interface ProposeClipsRequest {
  /** Free text — "split when Paola joined", "the customer call at the end". */
  instruction?: string;
}

export interface ClipProposal {
  /** Meeting ms. */
  fromMs: number;
  toMs: number;
  title: string;
  /** Why this window, in one line, shown under the preset. */
  reason: string;
  eventRef?: string;
  /** 0–1, the proposer's own estimate. */
  confidence: number;
  /** Which deterministic boundary the window starts on, when it starts on one. */
  basis?: ClipCandidateKind;
}

export interface ProposeClipsOk {
  ok: true;
  /** May be empty — with no instruction and no strong boundary, an empty list
   * is the right answer and no window is invented (spec §API). */
  proposals: ClipProposal[];
  /** How many deterministic boundaries were found before the agent ran. */
  candidates: number;
  /** False = the deterministic pass found nothing, so no agent call was made
   * (and nothing was charged). */
  ranAgent: boolean;
}

export type ProposeClipsResponse = ProposeClipsOk | { error: string };

// ---------------------------------------------------------------------------
// Permanent delete
// ---------------------------------------------------------------------------

/**
 * May a permanent delete remove the recording's FILES?
 *
 * Phase 1 walked the row: a meeting's `local_audio_path` was its own file, so
 * deleting the meeting deleted the bytes. A clip meeting borrows the source's
 * canonical filename so it can play, which makes that walk destructive — it
 * would take the bytes out from under every other meeting on the recording.
 *
 * The rule from here on: the files go only when the recording itself was
 * removed, i.e. NO other meeting (live OR trashed — restoring one must find
 * its bytes) still holds a clip on it. A server with the graph switched off
 * keeps the old behaviour, because there is nothing else that could be true.
 */
export function mayDeleteRecordingFiles(input: {
  /** Did the graph cleanup actually run (flag on, tables there)? */
  graphApplied: boolean;
  /** Recordings kept because another meeting still clips them. */
  recordingsKept: string[];
}): boolean {
  if (!input.graphApplied) return true;
  return input.recordingsKept.length === 0;
}
