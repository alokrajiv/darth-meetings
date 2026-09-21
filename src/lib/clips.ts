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
import { isClipTextPolicy, type ClipTextPolicy } from '@/lib/recording-clips';

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
  /**
   * What this clip contributes to the merged TEXT (Phase 3b,
   * docs/recordings-phase3b-combine-spec.md; the policies themselves are
   * `lib/recording-clips.ts`). Absent = `include`, which is what every clip
   * of a single-recording meeting is and what every row on prod carries.
   *
   * It lives on the mirror as well as on the row because `desiredClipsFor`
   * derives the desired graph FROM THE ROW: a mirror without the policy would
   * let the next dual-write heal a `gap_fill` clip back to `include` and
   * quietly double up the SI-BL text.
   */
  textPolicy?: ClipTextPolicy;
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

/** A uuid — the only shape a recording id ever has. */
const RECORDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `gmeet_context.clips`, validated.
 *
 * Lives HERE, in the pure contract, because three very different callers need
 * the same answer: the recording graph (`lib/recording-graph.ts`, which
 * re-exports it), the resolver's fallback path (`mediaFromRow` — with
 * `MW_RECORDINGS` off a split meeting's window has to come from the row), and
 * the CLIENT (`lib/clip-window.ts`): the transcript page clamps its player
 * from the row it already has, so a split-off meeting never plays the whole
 * hour while `GET …/clips` is still in flight — or when `MW_CLIPS` is off and
 * that route answers `enabled: false` for a meeting that was split anyway.
 *
 * A malformed mirror reads as ABSENT rather than as an error — a meeting must
 * never become invisible to the resolver because somebody wrote junk into its
 * context.
 */
export function storedClipsInContext(g: { clips?: unknown } | null | undefined): StoredClips | null {
  const raw = g?.clips;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: StoredClips = [];
  const ords = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const c = entry as Record<string, unknown>;
    const ord = c.ord;
    const recordingId = c.recordingId;
    const fromMs = c.fromMs;
    const toMs = c.toMs ?? null;
    const offsetMs = c.offsetMs;
    if (typeof ord !== 'number' || !Number.isInteger(ord) || ord < 0 || ords.has(ord)) return null;
    if (typeof recordingId !== 'string' || !RECORDING_ID_RE.test(recordingId)) return null;
    if (typeof fromMs !== 'number' || !Number.isFinite(fromMs) || fromMs < 0) return null;
    if (toMs !== null && (typeof toMs !== 'number' || !Number.isFinite(toMs) || toMs <= fromMs)) {
      return null;
    }
    if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || offsetMs < 0) return null;
    // An unreadable policy reads as the default rather than as a malformed
    // mirror: `include` is what the clip would have been without Phase 3b,
    // and a meeting must never go invisible to the resolver over one bad
    // string (same rule as the rest of this function).
    const textPolicy = isClipTextPolicy(c.textPolicy) ? c.textPolicy : 'include';
    ords.add(ord);
    out.push({
      ord,
      recordingId,
      fromMs,
      toMs: toMs as number | null,
      offsetMs,
      ...(textPolicy === 'include' ? {} : { textPolicy }),
    });
  }
  return out;
}

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
 * What the split route checks about the MEETING — before any window is even
 * named.
 *
 * It exists so the ⋯ menu stops guessing. `GET …/clips` answers
 * `splittable` / `splitBlockedReason` from this function and `POST …/split`
 * refuses from the same one, so an item the menu offers is an item the server
 * will accept, and a greyed item carries the route's own sentence as its
 * tooltip instead of a client-side approximation that drifts.
 *
 * Access is deliberately NOT one of these: `canEdit` sits beside `splittable`
 * on the same response, and a reader is shown no split item at all rather
 * than a greyed one explaining a permission they were never offered.
 *
 * Order matters: the first true thing is the thing the reader is told, and
 * "still being transcribed" beats "shares its transcription" because it is
 * the one that will stop being true on its own.
 */
export interface SplitPreconditionInput {
  /** `MW_CLIPS` on and migrations 044–046 present. */
  enabled: boolean;
  /** The meeting is in the trash. */
  trashed: boolean;
  /** `transcripts.status`. */
  status: string;
  /** A re-transcription is in flight (`gmeet_context.retranscribing`). */
  retranscribing: boolean;
  /** The legacy pair: two meeting rows over ONE AssemblyAI job. */
  sharedJob: boolean;
  /** Playable videos beyond the first (a stop/restart Meet meeting). */
  videoParts: number;
  /** The meeting holds at least one clip on a recording. */
  hasClip: boolean;
  /** How long the meeting runs on its own timeline. */
  spanMs: number;
}

export function splitPrecondition(input: SplitPreconditionInput): SplitRefusal | null {
  if (!input.enabled) return splitRefusal('disabled');
  if (input.trashed) return splitRefusal('not-completed', 'This meeting is in the trash.');
  if (input.status !== 'completed') return splitRefusal('not-completed');
  if (input.retranscribing) return splitRefusal('transcribing');
  if (input.sharedJob) return splitRefusal('shared-job');
  if (input.videoParts > 0) {
    return splitRefusal(
      'multi-recording',
      'This meeting has more than one video, which cannot be split yet.'
    );
  }
  if (!input.hasClip || !(input.spanMs > 0)) return splitRefusal('no-clip');
  return null;
}

/**
 * When the recording's clock starts, for a client that wants to line the
 * recording up against a calendar.
 *
 * The recording's own `started_at` is the truth. When the graph has none
 * (every row ingested before Phase 2, and every meeting whose recording row
 * was never stamped), the meeting's curated moment is the next best anchor,
 * and the day it landed here is the last resort — a poor anchor still beats
 * `null`, which leaves the split dialog's calendar pre-filter with no day to
 * ask about at all.
 *
 * Returns an ISO string, or null when not one of the three is a real date.
 */
export function recordingAnchorIso(
  startedAt: string | Date | null | undefined,
  recordedAt: string | Date | null | undefined,
  createdAt: string | Date | null | undefined
): string | null {
  for (const candidate of [startedAt, recordedAt, createdAt]) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    const d = candidate instanceof Date ? candidate : new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
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
  return meetingSpanFromDurations(clips, () => recordingDurationMs);
}

/**
 * The same span when the clips sit on SEVERAL recordings (Phase 3b): each
 * open-ended clip runs to the end of ITS OWN recording, not to the end of the
 * longest one.
 *
 * `meetingSpanMs`'s single number is the one-recording case of this and is
 * kept because every existing caller has exactly one duration to give.
 */
export function meetingSpanFromDurations(
  clips: ClipWindow[],
  durationOf: (recordingId: string) => number | null | undefined
): number {
  let span = 0;
  for (const clip of clips) {
    const length =
      clip.toMs === null
        ? Math.max(0, (durationOf(clip.recordingId) ?? clip.fromMs) - clip.fromMs)
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
  /**
   * `startedAt` is when the recording's clock starts — the recording's own
   * `started_at`, else the meeting's curated moment, else the day it landed
   * here (`recordingAnchorIso`). The split dialog's calendar pre-filter asks
   * for the meetings of THAT day, so an anchor that is merely approximate is
   * worth much more than none.
   */
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
  /**
   * True = "Split off a part…" may be offered. Decided by `splitPrecondition`
   * — the same function `POST …/split` refuses from — so the menu never
   * offers what the route would turn down, and never hides what it would
   * accept. Access is not part of it: see `canEdit`.
   */
  splittable: boolean;
  /**
   * Why it cannot be split, in the route's own sentence; null when it can
   * (and when clips are off, where there is nothing to explain because
   * nothing about clips is shown).
   */
  splitBlockedReason: string | null;
  /**
   * Phase 3b — the clip list with its sources named, one row per clip
   * (`ClipEntry`). Present whenever clips are enabled, with or without
   * `MW_COMBINE`: a one-recording meeting is a one-entry list, which is what
   * the recording card renders either way.
   *
   * `clips` above stays the bare windows so every 3a caller keeps its shape.
   */
  entries?: ClipEntry[];
  /** Distinct recordings this meeting holds. 1 for every row on prod. */
  recordingCount?: number;
  /** False = `MW_COMBINE` off: the UI shows the clip list but no "Add a
   * recording…" and no align step. */
  combineEnabled?: boolean;
  /** True = "Add a recording…" may be offered. */
  canAddRecording?: boolean;
  /** Why not, in the route's own sentence; null when it can. */
  addBlockedReason?: string | null;
  /**
   * Phase 3b source (c): uploads that named THIS meeting with `attachTo` and
   * have not landed yet — the recording card's "A recording is being added:
   * Upload · transcribing…". Empty for every meeting nobody is uploading to,
   * which is all of them nearly all of the time.
   *
   * Caller-scoped like everything else here: only uploads the caller can
   * already see (their own, or one shared with them) are listed.
   */
  pendingAttach?: PendingAttach[];
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

// ---------------------------------------------------------------------------
// Phase 3b — several recordings, one meeting
// (docs/recordings-phase3b-combine-spec.md; behind MW_COMBINE)
// ---------------------------------------------------------------------------

/**
 * Two DIFFERENT captures of one meeting: the Teams video plus the phone that
 * caught the corridor, the Meet recording that stopped and the tray recording
 * that ran on. The recordings stay what they are — own file, own
 * transcription, own diarization space (DEC-1) — and the MEETING lists more
 * than one clip, each on a different recording, placed on one timeline.
 *
 * Everything below is pure and is the wire contract the sheet, the align step
 * and `darth-cli meetings clips …` all speak.
 */

/** A meeting may hold at most this many clips (spec §API). */
export const MAX_CLIPS_PER_MEETING = 6;

/** `recordings.source_kind` — mirrored here so the contract stays pure. */
export type ClipSourceKind = 'recorder' | 'upload' | 'meet' | 'teams' | 'text' | 'aai-import';

/** What a clip's source line is built from. */
export interface ClipSourceFacts {
  sourceKind: string | null;
  /** True = the CALLER owns the recording. */
  mine: boolean;
  ownerName?: string | null;
  ownerEmail?: string | null;
  /** The recording's original filename, when it had one. */
  originalFilename?: string | null;
}

/** "Atira" from "Atira Wijaya" / "atira@trames.sg". */
function ownerFirstName(f: ClipSourceFacts): string {
  const name = (f.ownerName ?? '').trim();
  if (name) return name.split(/\s+/)[0]!;
  const email = (f.ownerEmail ?? '').trim();
  if (email) return email.split('@')[0]!;
  return 'someone else';
}

/**
 * The recording-strip vocabulary for one clip — "Teams recording", "Recorded
 * on Atira's Mac", "Upload · corridor.m4a".
 *
 * NEVER a bare filename as a title (spec §API): the filename only ever rides
 * behind a word that says what kind of thing it is.
 */
export function clipSourceLabel(f: ClipSourceFacts): string {
  const file = (f.originalFilename ?? '').trim();
  switch (f.sourceKind) {
    case 'teams':
      return f.mine ? 'Teams recording' : `${ownerFirstName(f)}’s Teams recording`;
    case 'meet':
      return f.mine ? 'Meet recording' : `${ownerFirstName(f)}’s Meet recording`;
    case 'recorder':
      return f.mine ? 'Recorded on your Mac' : `Recorded on ${ownerFirstName(f)}’s Mac`;
    case 'text':
      return f.mine ? 'Pasted transcript' : `${ownerFirstName(f)}’s pasted transcript`;
    case 'aai-import':
      return 'Imported transcription';
    case 'upload':
    default: {
      const who = f.mine ? 'Upload' : `${ownerFirstName(f)}’s upload`;
      return file ? `${who} · ${file}` : `${who}`;
    }
  }
}

/** One clip of a meeting, as the sheet and the CLI see it. */
export interface ClipEntry {
  ord: number;
  recordingId: string;
  fromMs: number;
  /** null = to the end of the recording. */
  toMs: number | null;
  offsetMs: number;
  textPolicy: ClipTextPolicy;
  /**
   * Does this clip's recording have text yet? False = it was added while
   * still transcribing (only legal with `exclude`: playable now, text later)
   * — the meeting is materialised again when it completes.
   */
  transcribed: boolean;
  /** How long the clip runs, ms. null = unknown (open-ended, no duration). */
  durationMs: number | null;
  /** "Teams recording" / "Recorded on Atira’s Mac" / "Upload · corridor.m4a". */
  sourceLabel: string;
  /** The recording's owner — a clip is somebody's bytes and the list says so. */
  ownerEmail: string | null;
  ownerName: string | null;
  /** True = the caller owns the recording. */
  mine: boolean;
  /** True = this clip provides the meeting's canonical file (the player's
   * default part, `local_audio_path`). */
  primary: boolean;
  recordingDurationMs: number | null;
  recordingStartedAt: string | null;
}

export type CombineRefusalCode =
  | 'disabled'
  | 'read-only'
  | 'recording-not-found'
  | 'not-owned'
  | 'already-clipped'
  | 'not-transcribed'
  | 'too-many-clips'
  | 'last-clip'
  | 'clip-not-found'
  | 'window-invalid'
  | 'offset-invalid'
  | 'policy-invalid'
  | 'no-clip'
  | 'upload-deferred';

export interface CombineRefusal {
  code: CombineRefusalCode;
  /** Shown to the user verbatim. */
  message: string;
}

const COMBINE_REFUSAL_TEXT: Record<CombineRefusalCode, string> = {
  disabled: 'Adding a second recording is not available on this server.',
  'read-only': 'You have read-only access here.',
  'recording-not-found': 'That recording is not available to you.',
  'not-owned':
    'That recording belongs to someone else. Only its owner can add it to this meeting — ask them to add it themselves.',
  'already-clipped': 'That recording is already part of this meeting.',
  'not-transcribed':
    'That recording has no transcript yet. Add it as “Audio only” for now — its text appears here when it finishes.',
  'too-many-clips': `A meeting can hold ${MAX_CLIPS_PER_MEETING} recordings at most.`,
  'last-clip': 'This is the meeting’s only recording — removing it would leave nothing to play.',
  'clip-not-found': 'That recording is not part of this meeting.',
  'window-invalid': 'The start has to come before the end.',
  'offset-invalid': 'The offset has to be a time from the start of this meeting.',
  'policy-invalid': 'Choose Text, Fill gaps only, or Audio only.',
  'no-clip': 'This meeting has no recording to add to.',
  'upload-deferred':
    'An upload joins a meeting when it STARTS, not afterwards — choose this meeting in the upload dialog, or add the recording here once it has finished.',
};

export function combineRefusal(code: CombineRefusalCode, message?: string): CombineRefusal {
  return { code, message: message ?? COMBINE_REFUSAL_TEXT[code] };
}

/** POST /api/transcripts/:id/clips */
export interface AddClipRequest {
  /** Source (a) another meeting the caller can EDIT, or (b) one of the
   * caller's own unlinked recordings. Both arrive as a recording id from
   * `GET …/clips/candidates`. */
  recordingId?: string;
  /** Source (c), DEFERRED — see `upload-deferred` above. */
  uploadSessionId?: string;
  /** The window of the RECORDING to take. Defaults: the whole thing. */
  fromMs?: number;
  toMs?: number | null;
  /** `mm:ss` / `h:mm:ss` forms for the CLI and a typed field; ms wins. */
  from?: string;
  to?: string;
  /** Where `fromMs` lands on the MEETING timeline. Never guessed by the
   * server — it is the person's click on the align step (spec §"The offset"). */
  offsetMs?: number;
  offset?: string;
  textPolicy?: ClipTextPolicy;
}

/** PATCH /api/transcripts/:id/clips/:ord */
export interface PatchClipRequest {
  offsetMs?: number;
  offset?: string;
  textPolicy?: ClipTextPolicy;
  fromMs?: number;
  toMs?: number | null;
  from?: string;
  to?: string;
}

/** What every clip mutation answers with: the whole list again. */
export interface ClipMutationOk {
  ok: true;
  clips: ClipEntry[];
  /** How long the meeting now runs on its own timeline. */
  spanMs: number;
  /** Distinct recordings the meeting now holds — the listing's "2 recordings". */
  recordingCount: number;
  /** What the meeting's text became when it was re-materialised. */
  materialised: {
    utterances: number;
    durationSec: number | null;
    speakerCount: number | null;
  };
}

export type ClipMutationResponse = ClipMutationOk | { error: string; code?: CombineRefusalCode };

/** One row of `GET /api/transcripts/:id/clips/candidates`. */
export interface ClipCandidate {
  recordingId: string;
  sourceLabel: string;
  startedAt: string | null;
  durationMs: number | null;
  /** The recording has a completed transcription. */
  transcribed: boolean;
  mine: boolean;
  ownerEmail: string | null;
  ownerName: string | null;
  /** The meeting this recording belongs to — ONLY when the caller can open
   * it. null for a recording of the caller's that no meeting claims. */
  meeting: { id: string; url: string; title: string | null } | null;
  /** True = no meeting names it (the Recordings tab's "not linked yet"). */
  unlinked: boolean;
  /** False = the caller may not add it (someone else's bytes — privacy). */
  addable: boolean;
  blockedReason: string | null;
  /**
   * What the offset would be if both `started_at` were trusted, ms. The
   * align step seeds its search window with this; it is NEVER applied on its
   * own (spec §"The offset — never guessed silently").
   */
  nominalOffsetMs: number | null;
}

export interface ClipCandidatesResponse {
  /** False = MW_COMBINE off, clips off, or this meeting has no clip to add to. */
  enabled: boolean;
  canEdit: boolean;
  candidates: ClipCandidate[];
  /** How many more clips this meeting may take. 0 = the cap is reached. */
  slotsLeft: number;
}

// --- The align job ---------------------------------------------------------

/** POST /api/recordings/:id/align */
export interface AlignRequest {
  /** The OTHER recording — the one `:id` is measured against. */
  against: string;
  /** Where to look first, ms. Absent = from the two `started_at`s, else 0. */
  nominalOffsetMs?: number;
  /** Half-width of the search, ms. Absent = ±120 s with a nominal, ±30 min
   * without one (spec §"The offset"). */
  searchWindowMs?: number;
}

/** Below this the answer is "could not line these up — set it by ear". */
export const ALIGN_MIN_CONFIDENCE = 0.4;
/** ±120 s around a nominal we have a reason to believe. */
export const ALIGN_WINDOW_MS = 120_000;
/** ±30 min when there is no nominal at all. */
export const ALIGN_WIDE_WINDOW_MS = 30 * 60_000;

export interface AlignOk {
  ok: true;
  /**
   * How far `:id` starts AFTER `against`, in ms: add it to a position on
   * `against`'s timeline to get the same instant on `:id`'s. Negative = it
   * started first. This is the number that becomes a clip's `offsetMs` when
   * `against` is the meeting's primary recording and sits at offset 0.
   */
  offsetMs: number;
  /**
   * 0–1. The correlation peak's height over the background of the search
   * window (peak ÷ the 99th percentile of everything further than 2 s away),
   * squashed to 0–1. 1.0 = the peak towers over everything else; 0.4 is the
   * floor below which the UI says "set it by ear". It is NOT a probability
   * and it is never a licence to apply the offset automatically.
   */
  confidence: number;
  /** Clock drift between the two devices, parts per million; null when the
   * overlap was too short to measure one. ~50 ppm was the SI-BL pair. */
  driftPpm: number | null;
  method: string;
  nominalOffsetMs: number;
  searchWindowMs: number;
  /** How much audio the two files actually share at the answer, ms. */
  overlapMs: number | null;
  /** Set when the confidence is under the floor — the sentence to show. */
  advice: string | null;
}

export type AlignResponse = AlignOk | { error: string; code?: string };

/** 'good' = show it; 'weak' = show it with the warning; 'none' = by ear. */
export function alignVerdict(confidence: number): 'good' | 'weak' | 'none' {
  if (!Number.isFinite(confidence) || confidence < ALIGN_MIN_CONFIDENCE) return 'none';
  return confidence >= 0.65 ? 'good' : 'weak';
}

/** The sentence that goes with a weak or missing alignment. */
export function alignAdvice(confidence: number): string | null {
  switch (alignVerdict(confidence)) {
    case 'none':
      return 'Could not line these up — set the offset by ear.';
    case 'weak':
      return 'A weak match — check the two waveforms line up before you use it.';
    default:
      return null;
  }
}

/**
 * The offset the two recordings' clocks imply, ms — `b` minus `a`.
 *
 * Every one of these clocks is known to be unreliable (a Teams filename is in
 * the ORGANISER's timezone, an m4a `creation_time` is the END of the clip),
 * which is the whole reason the correlation exists. This only ever seeds the
 * search window.
 */
export function nominalOffsetMsBetween(
  aStartedAt: string | Date | null | undefined,
  bStartedAt: string | Date | null | undefined
): number | null {
  const at = toMs(aStartedAt);
  const bt = toMs(bStartedAt);
  if (at === null || bt === null) return null;
  return bt - at;
}

function toMs(v: string | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// --- Validation ------------------------------------------------------------

/** The clip's extent on the MEETING timeline, given what we know of its
 * recording's length. `null` end = open-ended and the length is unknown. */
export function clipEntryExtent(
  clip: Pick<ClipEntry, 'fromMs' | 'toMs' | 'offsetMs' | 'recordingDurationMs'>
): [number, number | null] {
  const start = clip.offsetMs;
  if (clip.toMs !== null) return [start, start + Math.max(0, clip.toMs - clip.fromMs)];
  if (clip.recordingDurationMs != null) {
    return [start, start + Math.max(0, clip.recordingDurationMs - clip.fromMs)];
  }
  return [start, null];
}

const POLICY_RANK: Record<ClipTextPolicy, number> = { include: 0, gap_fill: 1, exclude: 2 };

/**
 * Which clip a `t:<ms>` chip should play — the part that HAS audio at that
 * moment, preferring the one whose text the reader is looking at.
 *
 * Order (spec §"Reader and writer changes"): `include` first, then
 * `gap_fill`, then `exclude`; ties go to the clip that starts later, which is
 * the one whose own timeline the moment sits further inside. `null` = nothing
 * covers that moment (a hole), and the chip stays on the current part.
 */
export function candidateClipForTime(clips: ClipEntry[], meetingMs: number): ClipEntry | null {
  let best: ClipEntry | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const [lo, hi] = clipEntryExtent(clip);
    if (meetingMs < lo) continue;
    if (hi !== null && meetingMs >= hi) continue;
    const rank = POLICY_RANK[clip.textPolicy] ?? 0;
    if (rank < bestRank || (rank === bestRank && best !== null && clip.offsetMs > best.offsetMs)) {
      best = clip;
      bestRank = rank;
    }
  }
  return best;
}

export interface AddClipCheckInput {
  /** The meeting's clips as they are now. */
  clips: Array<Pick<ClipWindow, 'ord' | 'recordingId'>>;
  recordingId: string;
  /** Does the CALLER own the recording? Only an owner may hand its bytes to
   * a meeting's readers (spec §Privacy). */
  ownedByCaller: boolean;
  /** Has the recording a completed transcription? */
  transcribed: boolean;
  fromMs: number;
  toMs: number | null;
  offsetMs: number;
  textPolicy: ClipTextPolicy;
}

/**
 * Every refusal `POST …/clips` can produce about the CLIP, in the order the
 * spec lists them. Pure so the sheet greys the same rows out for the same
 * reasons the route will turn down.
 */
export function validateAddClip(input: AddClipCheckInput): CombineRefusal | null {
  if (input.clips.length === 0) return combineRefusal('no-clip');
  if (input.clips.length >= MAX_CLIPS_PER_MEETING) return combineRefusal('too-many-clips');
  if (!input.ownedByCaller) return combineRefusal('not-owned');
  if (input.clips.some((c) => c.recordingId === input.recordingId)) {
    return combineRefusal('already-clipped');
  }
  if (!isClipTextPolicy(input.textPolicy)) return combineRefusal('policy-invalid');
  // "Playable now, text later": a recording still being transcribed may join
  // as `exclude` only, and the meeting is materialised again when it lands.
  if (!input.transcribed && input.textPolicy !== 'exclude') return combineRefusal('not-transcribed');
  const window = validateClipWindowShape(input.fromMs, input.toMs, input.offsetMs);
  if (window) return window;
  return null;
}

/** `from < to`, both real, and an offset that lands on the meeting. */
export function validateClipWindowShape(
  fromMs: number,
  toMs: number | null,
  offsetMs: number
): CombineRefusal | null {
  if (!Number.isFinite(fromMs) || fromMs < 0) return combineRefusal('window-invalid');
  if (toMs !== null && (!Number.isFinite(toMs) || toMs <= fromMs)) {
    return combineRefusal('window-invalid');
  }
  if (toMs !== null && toMs - fromMs < MIN_CLIP_MS) return combineRefusal('window-invalid');
  if (!Number.isFinite(offsetMs) || offsetMs < 0) return combineRefusal('offset-invalid');
  return null;
}

export interface PatchClipCheckInput {
  clips: Array<Pick<ClipWindow, 'ord' | 'recordingId'>>;
  ord: number;
  fromMs: number;
  toMs: number | null;
  offsetMs: number;
  textPolicy: ClipTextPolicy;
  transcribed: boolean;
}

export function validatePatchClip(input: PatchClipCheckInput): CombineRefusal | null {
  if (!input.clips.some((c) => c.ord === input.ord)) return combineRefusal('clip-not-found');
  if (!isClipTextPolicy(input.textPolicy)) return combineRefusal('policy-invalid');
  if (!input.transcribed && input.textPolicy !== 'exclude') return combineRefusal('not-transcribed');
  return validateClipWindowShape(input.fromMs, input.toMs, input.offsetMs);
}

/**
 * Un-combine = delete the clip. Never the last one: a meeting with no clip
 * has no text and no bytes, and the permanent-delete rule from 3a
 * (`mayDeleteRecordingFiles`) is what keeps the recording itself alive.
 */
export function validateDeleteClip(
  clips: Array<Pick<ClipWindow, 'ord' | 'recordingId'>>,
  ord: number
): CombineRefusal | null {
  if (!clips.some((c) => c.ord === ord)) return combineRefusal('clip-not-found');
  if (clips.length <= 1) return combineRefusal('last-clip');
  return null;
}

/** The next free `ord` for a meeting's clips — its identity, never its
 * position (§5a), so it only ever grows. */
export function nextClipOrd(clips: Array<Pick<ClipWindow, 'ord'>>): number {
  return clips.reduce((max, c) => Math.max(max, c.ord), -1) + 1;
}

/** Distinct recordings a clip set reads — the listing's "2 recordings". */
export function recordingCountOf(clips: Array<Pick<ClipWindow, 'recordingId'>>): number {
  return new Set(clips.map((c) => c.recordingId)).size;
}

// ---------------------------------------------------------------------------
// Source (c) — an upload that JOINS an existing meeting (`attachTo`)
// ---------------------------------------------------------------------------

/**
 * "These bytes are a second recording OF that meeting."
 *
 * Sources (a) and (b) above add a recording that already exists. Source (c)
 * of the spec (§API) is a fresh upload: it runs as any upload does — its own
 * recording, its own transcription, its own meeting document (DEC-1) — and is
 * added to the NAMED meeting as a clip the moment it finishes transcribing.
 *
 * The request is resolved at OPEN, before a byte moves (`resolveAttachTarget`
 * in lib/server/clip-attach.ts), and what survives is the MARKER below,
 * stamped on the upload's placeholder as `gmeet_context.attachTo`. It has to
 * live on the row rather than only on the upload session because the two
 * byte-delivery routes are different code paths, a chunked upload is resumed
 * hours later, and the completion hook that acts on it runs from a poll it
 * knows nothing about.
 */
export interface AttachToRequest {
  /** The meeting to join — the caller must be able to EDIT it. */
  meetingId: string;
  /** Where the upload's first millisecond lands on that meeting's timeline.
   * Never guessed by the server (spec §"The offset"); absent = 0, i.e. "they
   * start together". `offset` is the CLI's `mm:ss` form; ms wins. */
  offsetMs?: number;
  offset?: string;
  textPolicy?: ClipTextPolicy;
}

/** `gmeet_context.attachTo` — the request, frozen on the placeholder. */
export interface AttachToMarker {
  meetingId: string;
  offsetMs: number;
  textPolicy: ClipTextPolicy;
  /** When the upload was opened, ISO. */
  at: string;
  /**
   * The uploader's email, frozen at open. The completion hook re-checks
   * access AS THE UPLOADER (a share can be withdrawn while a 4 GB file is on
   * its way) and there is no users table to look an id up in.
   */
  by?: string;
  /**
   * The attach was tried and refused: the meeting stays an ordinary
   * standalone one and the card says "could not attach: …". Its presence is
   * also what stops the hook trying again on every re-entry.
   */
  error?: string;
  errorCode?: CombineRefusalCode;
  failedAt?: string;
}

/** A meeting id as the routes accept it: our own prefixes, a minted uuid, or
 * a legacy AssemblyAI job id. Deliberately loose — `resolveAccess` is the
 * real gate; this only keeps junk out of a jsonb column. */
const MEETING_ID_RE = /^[A-Za-z0-9_-]{6,200}$/;

/**
 * `attachTo` off a request body or a query string.
 *
 * `undefined` = absent (an ordinary upload). `null` = junk, and the route
 * answers 400: a client that meant to attach an upload must hear that it
 * will not be, rather than discover a standalone meeting afterwards.
 *
 * A bare string is the one-shot route's `?attachTo=<meeting id>`; the object
 * form is the JSON body's.
 */
export function parseAttachTo(raw: unknown): AttachToRequest | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const id = raw.trim();
    if (!id) return undefined;
    return MEETING_ID_RE.test(id) ? { meetingId: id } : null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { meetingId?: unknown; offsetMs?: unknown; offset?: unknown; textPolicy?: unknown };
  const id = typeof r.meetingId === 'string' ? r.meetingId.trim() : '';
  if (!MEETING_ID_RE.test(id)) return null;
  if (r.offsetMs !== undefined && typeof r.offsetMs !== 'number') return null;
  if (r.offset !== undefined && typeof r.offset !== 'string') return null;
  if (r.textPolicy !== undefined && !isClipTextPolicy(r.textPolicy)) return null;
  return {
    meetingId: id,
    ...(r.offsetMs !== undefined ? { offsetMs: r.offsetMs } : {}),
    ...(r.offset !== undefined ? { offset: r.offset } : {}),
    ...(r.textPolicy !== undefined ? { textPolicy: r.textPolicy } : {}),
  };
}

/**
 * The offset a request asks for, in ms, or `null` when it is unreadable —
 * the route refuses rather than silently attaching at 0, because a wrong
 * offset is a wrong meeting timeline.
 */
export function attachOffsetMs(req: AttachToRequest): number | null {
  if (req.offsetMs === undefined && req.offset === undefined) return 0;
  const ms = req.offsetMs !== undefined ? parseTimestampMs(req.offsetMs) : parseTimestampMs(req.offset);
  return ms;
}

/** The marker to stamp on the placeholder. `offsetMs` has already been read
 * (and refused) by the route — see `attachOffsetMs`. */
export function attachMarker(
  req: AttachToRequest,
  offsetMs: number,
  by?: string | null,
  now: Date = new Date()
): AttachToMarker {
  return {
    meetingId: req.meetingId,
    offsetMs,
    // The default is `include`: a second capture of the same meeting is
    // normally there for its WORDS. The dialog offers gap_fill / exclude.
    textPolicy: isClipTextPolicy(req.textPolicy) ? req.textPolicy : 'include',
    at: now.toISOString(),
    ...(by ? { by } : {}),
  };
}

/** The marker on a row, in any state (pending or refused), or null. */
export function attachMarkerOf(
  ctx: { attachTo?: unknown } | null | undefined
): AttachToMarker | null {
  const raw = ctx?.attachTo;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Partial<AttachToMarker>;
  if (typeof m.meetingId !== 'string' || !MEETING_ID_RE.test(m.meetingId)) return null;
  return {
    meetingId: m.meetingId,
    offsetMs: typeof m.offsetMs === 'number' && Number.isFinite(m.offsetMs) ? m.offsetMs : 0,
    textPolicy: isClipTextPolicy(m.textPolicy) ? m.textPolicy : 'include',
    at: typeof m.at === 'string' ? m.at : '',
    ...(typeof m.by === 'string' ? { by: m.by } : {}),
    ...(typeof m.error === 'string' ? { error: m.error } : {}),
    ...(typeof m.errorCode === 'string' ? { errorCode: m.errorCode as CombineRefusalCode } : {}),
    ...(typeof m.failedAt === 'string' ? { failedAt: m.failedAt } : {}),
  };
}

/** A marker still waiting to be acted on: no attempt has been refused yet.
 * A refused one stays on the row for the UI and is never retried. */
export function pendingAttachOf(
  ctx: { attachTo?: unknown } | null | undefined
): AttachToMarker | null {
  const marker = attachMarkerOf(ctx);
  return marker && !marker.error ? marker : null;
}

/**
 * One line for the TARGET meeting's recording card: "A recording is being
 * added — Upload · transcribing…".
 *
 * Filename-free by construction (`clipSourceLabel` with no filename), because
 * the meeting's readers have not been given these bytes yet — the clip is what
 * consents to that, and it does not exist until the transcription lands.
 */
export interface PendingAttach {
  /** "Upload", "Recorded on your Mac", "Ivan’s upload" — never a filename. */
  sourceLabel: string;
  /** Where it will land on this meeting's timeline. */
  offsetMs: number;
  textPolicy: ClipTextPolicy;
  /** 'uploading' = the bytes are still arriving; 'transcribing' = they are at
   * AssemblyAI; 'failed' = the upload itself failed and nothing will be added. */
  state: 'uploading' | 'transcribing' | 'failed';
  /** True = the CALLER is the one adding it. */
  mine: boolean;
  since: string;
}
