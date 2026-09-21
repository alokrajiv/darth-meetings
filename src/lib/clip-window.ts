/**
 * The windowed player, as arithmetic (Phase 3a,
 * docs/recordings-phase3-clips-spec.md "Media and the window").
 *
 * A meeting split off a longer recording plays the SAME file as the meeting
 * it came from — nothing is cut (DEC-2). What makes it a different meeting is
 * that its player is clamped to a window: displayed time is file time minus
 * `fromMs`, seeking maps back, playback starts at `fromMs` and stops at
 * `toMs`, and the scrubber spans the window and nothing else.
 *
 * Every place that turns one of those numbers into the other goes through
 * this module — the `<audio>` element, the scrubber, the `t:` chips in the
 * notes, `seekMeetingTime` from an utterance click and the playhead
 * highlight. One function, so the transcript and the player can never
 * quietly disagree about what "12:40" means (the same reasoning that put the
 * part offsets in `lib/part-offsets.ts`).
 *
 * The other half is the SOURCE meeting: it keeps its whole file and its own
 * timeline, with a HOLE where the split-off window was. The hole is not its
 * content any more, so the player skips it and the transcript shows a quiet
 * divider — `holeAt` and `holesBeforeUtterance` below.
 *
 * Pure: no React, no DOM, no server. Times are milliseconds on the MEETING
 * timeline unless a name says `file`.
 */

import {
  holesOf,
  storedClipsInContext,
  windowBoundsFor,
  type ClipHole,
  type ClipWindow,
} from '@/lib/clips';
import { compareClipsOnTimeline } from '@/lib/recording-clips';

/** What the player clamps to. `toMs: null` = to the end of the file. */
export interface PlaybackWindow {
  fromMs: number;
  toMs: number | null;
}

/**
 * The window the meeting ROW declares, or null for "the whole file".
 *
 * Read from `gmeet_context.clips` — the mirror the split writes — so the page
 * is clamped from its first render, before `GET …/clips` answers, and stays
 * clamped when that route says `enabled: false` (`MW_CLIPS` switched off on a
 * server where a meeting was already split). This is exactly what the
 * server-side resolver does for the same row (`mediaFromRow`), so the client
 * and the `/audio` route agree by construction.
 */
export function windowFromContext(gmeetContext: { clips?: unknown } | null | undefined): PlaybackWindow | null {
  const stored = storedClipsInContext(gmeetContext);
  if (!stored) return null;
  // The clip that lands FIRST on the meeting's timeline is the one that
  // places the file; `ord` is identity, not position (spec §5a).
  const first = [...stored].sort(compareClipsOnTimeline)[0]!;
  const bounds = windowBoundsFor(stored, first.recordingId);
  if (bounds.fromMs === null && bounds.toMs === null) return null;
  return { fromMs: bounds.fromMs ?? 0, toMs: bounds.toMs };
}

/** Same, from the clips `GET …/clips` returned (which may cover several). */
export function windowOfClips(clips: ClipWindow[]): PlaybackWindow | null {
  if (clips.length === 0) return null;
  const first = [...clips].sort(compareClipsOnTimeline)[0]!;
  const bounds = windowBoundsFor(clips, first.recordingId);
  if (bounds.fromMs === null && bounds.toMs === null) return null;
  return { fromMs: bounds.fromMs ?? 0, toMs: bounds.toMs };
}

/**
 * The holes the meeting ROW declares, for the same reason `windowFromContext`
 * exists: the page renders its transcript from the row long before (and
 * sometimes instead of) `GET …/clips`.
 *
 * `spanMs` is how long the meeting runs on its own timeline — its `duration`,
 * which a shrunk source keeps at the full length of the recording precisely so
 * that the hole stays where its notes say it is.
 */
export function holesFromContext(
  gmeetContext: { clips?: unknown } | null | undefined,
  spanMs: number | null
): ClipHole[] {
  const stored = storedClipsInContext(gmeetContext);
  if (!stored || !spanMs) return [];
  return holesOf(stored, spanMs);
}

// ---------------------------------------------------------------------------
// Meeting time ⇄ file time
// ---------------------------------------------------------------------------

/** Where a meeting position sits in the FILE. Null window = they are equal. */
export function fileMsOf(meetingMs: number, window: PlaybackWindow | null): number {
  return Math.max(0, meetingMs) + (window?.fromMs ?? 0);
}

/** Where a file position sits on the MEETING timeline (never negative). */
export function meetingMsOf(fileMs: number, window: PlaybackWindow | null): number {
  return Math.max(0, fileMs - (window?.fromMs ?? 0));
}

/**
 * How long the window runs, in ms — what the scrubber spans.
 *
 * `fileDurationMs` is whatever the media element (or the row) knows about the
 * whole file; null while metadata is still loading. An open-ended window
 * (`toMs: null`) is "to the end of the file", so it needs that number.
 */
export function windowDurationMs(
  window: PlaybackWindow | null,
  fileDurationMs: number | null
): number | null {
  if (!window) return fileDurationMs;
  if (window.toMs !== null) return Math.max(0, window.toMs - window.fromMs);
  if (fileDurationMs === null) return null;
  return Math.max(0, fileDurationMs - window.fromMs);
}

/** Clamp a MEETING position into the window (or into the file when there is none). */
export function clampMeetingMs(
  meetingMs: number,
  window: PlaybackWindow | null,
  fileDurationMs: number | null
): number {
  const span = windowDurationMs(window, fileDurationMs);
  const capped = span === null ? meetingMs : Math.min(meetingMs, span);
  return Math.max(0, capped);
}

/**
 * Has playback run past the end of the window?
 *
 * A media element's `timeupdate` fires every ~250 ms, so "stop at `to`" means
 * "stop as soon as we are at or past it" — there is no frame-exact event and
 * a tolerance would let a second of the next meeting through.
 */
export function pastWindowEnd(fileMs: number, window: PlaybackWindow | null): boolean {
  return window?.toMs != null && fileMs >= window.toMs;
}

// ---------------------------------------------------------------------------
// Holes — the source meeting's side of a split
// ---------------------------------------------------------------------------

/**
 * The hole containing a MEETING position, if any.
 *
 * Used to skip: a player that wanders into a stretch which is now somebody
 * else's meeting jumps to `toMs`. The bounds are half-open, exactly as a clip
 * is — a position at `toMs` is already out of the hole and back in this
 * meeting.
 */
export function holeAt(holes: ClipHole[], meetingMs: number): ClipHole | null {
  for (const h of holes) {
    if (meetingMs >= h.fromMs && meetingMs < h.toMs) return h;
  }
  return null;
}

/** Does the given stretch of meeting time cross a hole? */
export function crossesHole(holes: ClipHole[], fromMs: number, toMs: number): boolean {
  return holes.some((h) => h.fromMs < toMs && h.toMs > fromMs);
}

/** The minimum an utterance needs for divider placement. */
export interface TimedUtterance {
  start: number;
  end: number;
}

/**
 * Which utterance each hole falls in FRONT of — the index the transcript
 * renders its divider above.
 *
 * A hole sits between two utterances by construction: the split took every
 * utterance inside its window away with it. The divider therefore belongs
 * above the first utterance that starts at or after the hole ends. A hole at
 * the very end of the meeting (nothing after it) has no index and is dropped
 * — there is no row to hang it on and a trailing rule says nothing.
 */
export function holesBeforeUtterance(
  utterances: readonly TimedUtterance[] | null | undefined,
  holes: ClipHole[]
): Map<number, ClipHole> {
  const out = new Map<number, ClipHole>();
  if (!utterances?.length || holes.length === 0) return out;
  for (const hole of holes) {
    const index = utterances.findIndex((u) => u.start >= hole.toMs);
    // `findIndex` is -1 for a hole after the last utterance; and two holes
    // landing on the same index (impossible after one split, cheap to be
    // right about) keep the FIRST, which is the earlier one.
    if (index < 0 || out.has(index)) continue;
    out.set(index, hole);
  }
  return out;
}
