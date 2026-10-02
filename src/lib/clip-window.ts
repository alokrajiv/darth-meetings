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

// ---------------------------------------------------------------------------
// The media the server SERVES (2026-10-02 — cut server-side, lib/clip-cut.ts)
// ---------------------------------------------------------------------------

/**
 * Since 2026-10-02 the meeting media routes no longer hand a windowed meeting
 * its whole file: they serve a CUT of exactly the window (`windowBoundsFor` of
 * that recording on the meeting — the bounds above), starting at 0. So the
 * player's window is no longer "where in the file", it is "where in the CUT",
 * which for a split-off meeting is nothing at all: the bytes ARE the meeting.
 *
 * `window` is what the player maps through when the bytes are the cut.
 * `wholeFileWindow` is what it maps through if they turn out to be the WHOLE
 * file after all — a copy the browser's HTTP cache or an offline pin kept from
 * before the cut, or a server one deploy behind during a blue/green switch —
 * which `servedIsWholeFile` recognises from the media's own duration.
 *
 * A `fromMs` BELOW ZERO is legal here and means "the served file starts this
 * many ms INTO the meeting": a source meeting whose split took its opening
 * minutes keeps its own timeline (the notes still cite the old times), so its
 * cut's 0 is meeting ms `to`. `fileMsOf` / `meetingMsOf` / `windowDurationMs`
 * are plain additions and handle it unchanged.
 */
export interface ServedPlayback {
  window: PlaybackWindow | null;
  wholeFileWindow: PlaybackWindow | null;
  /** How long the cut should be, ms; null = unknown (no stale-copy check). */
  cutSpanMs: number | null;
}

/**
 * A window (file ms) re-expressed inside a cut of the same file. Null when the
 * window IS the cut — the player then needs no clamping at all and keeps its
 * native controls.
 */
export function windowInCut(window: PlaybackWindow | null, cut: PlaybackWindow): PlaybackWindow | null {
  if (!window) return null;
  const from = window.fromMs - cut.fromMs;
  const to = window.toMs === null ? null : window.toMs - cut.fromMs;
  const cutEnd = cut.toMs === null ? null : cut.toMs - cut.fromMs;
  const atEnd = to === null || (cutEnd !== null && to >= cutEnd);
  if (from <= 0 && atEnd) return null;
  return { fromMs: Math.max(0, from), toMs: atEnd ? null : to };
}

function cutSpanOf(cut: PlaybackWindow, fallbackMs: number | null): number | null {
  if (cut.toMs !== null) return cut.toMs - cut.fromMs;
  return fallbackMs !== null && fallbackMs > 0 ? fallbackMs : null;
}

/**
 * The MAIN player of a meeting (its first recording), from the row's clip
 * mirror — the same clips `windowFromContext` reads and the server cuts by.
 *
 * `durationSec` is the row's `duration` (the meeting's own span); it is only
 * used to know how long an open-ended cut should be.
 */
export function servedPlaybackFromContext(
  gmeetContext: { clips?: unknown } | null | undefined,
  durationSec: number | null | undefined
): ServedPlayback {
  const stored = storedClipsInContext(gmeetContext);
  if (!stored) return { window: null, wholeFileWindow: null, cutSpanMs: null };
  const first = [...stored].sort(compareClipsOnTimeline)[0]!;
  const bounds = windowBoundsFor(stored, first.recordingId);
  if (bounds.fromMs === null && bounds.toMs === null) {
    // Served whole (never split, or a source with a hole in the middle).
    return { window: null, wholeFileWindow: null, cutSpanMs: null };
  }
  const cut: PlaybackWindow = { fromMs: bounds.fromMs ?? 0, toMs: bounds.toMs };
  // Meeting ms at the cut's first byte: where the first clip lands, moved back
  // by however far into the cut that clip starts. 0 for a split-off meeting.
  const leadMs = Math.max(0, first.offsetMs + (cut.fromMs - first.fromMs));
  const spanMs = durationSec != null ? durationSec * 1000 - leadMs : null;
  return {
    window: leadMs > 0 ? { fromMs: -leadMs, toMs: null } : null,
    wholeFileWindow: cut,
    cutSpanMs: cutSpanOf(cut, spanMs),
  };
}

/**
 * One clip PART of a combined meeting (`playerParts` in lib/combine-ui.ts):
 * its own window, inside the cut the server made of its recording — the
 * bounds of every clip this meeting holds on that recording.
 */
export function servedPlaybackForPart(
  part: Pick<ClipWindow, 'recordingId' | 'fromMs' | 'toMs'>,
  clips: ReadonlyArray<Pick<ClipWindow, 'ord' | 'recordingId' | 'fromMs' | 'toMs' | 'offsetMs'>>
): ServedPlayback {
  const own: PlaybackWindow | null =
    part.fromMs > 0 || part.toMs !== null ? { fromMs: part.fromMs, toMs: part.toMs } : null;
  const bounds = windowBoundsFor(
    clips.map((c) => ({ ord: c.ord, recordingId: c.recordingId, fromMs: c.fromMs, toMs: c.toMs, offsetMs: c.offsetMs })),
    part.recordingId
  );
  if (bounds.fromMs === null && bounds.toMs === null) {
    return { window: own, wholeFileWindow: own, cutSpanMs: null };
  }
  const cut: PlaybackWindow = { fromMs: bounds.fromMs ?? 0, toMs: bounds.toMs };
  return {
    window: windowInCut(own ?? { fromMs: 0, toMs: null }, cut),
    wholeFileWindow: own,
    cutSpanMs: cutSpanOf(cut, null),
  };
}

/** Slack before a served file counts as "longer than the cut": packet edges, a GOP. */
export const WHOLE_FILE_SLACK_MS = 2_000;

/**
 * Is the media the player just loaded the WHOLE file rather than the cut?
 * Only when it is clearly longer than the cut should be. Unknown span or an
 * unknown duration answer false — the cut is what the server serves today.
 */
export function servedIsWholeFile(mediaDurationMs: number | null, cutSpanMs: number | null): boolean {
  if (cutSpanMs === null || mediaDurationMs === null || !Number.isFinite(mediaDurationMs)) return false;
  return mediaDurationMs > cutSpanMs + Math.max(WHOLE_FILE_SLACK_MS, cutSpanMs * 0.02);
}
