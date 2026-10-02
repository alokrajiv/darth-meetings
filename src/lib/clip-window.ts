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
  keptSegmentsFor,
  storedClipsInContext,
  windowBoundsFor,
  type ClipHole,
  type ClipWindow,
  type FileSegment,
} from '@/lib/clips';
import { compareClipsOnTimeline } from '@/lib/recording-clips';

/** What the player clamps to. `toMs: null` = to the end of the file. */
export interface PlaybackWindow {
  fromMs: number;
  toMs: number | null;
  /**
   * Stretches of the MEETING timeline that are NOT in the served file — a
   * hole in the middle that the server cut out (2026-10-02 M1, lib/clip-cut.ts
   * `cutPlanOf`). Meeting ms, half-open, in order. The served file is
   * contiguous; the meeting keeps its own timeline (the hole stays where its
   * notes say it is), so every mapping below steps across these. Absent on
   * every window that is not a cut with a hole.
   */
  gaps?: ClipHole[];
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

/**
 * Where a meeting position sits in the FILE. Null window = they are equal.
 *
 * A position inside one of the window's `gaps` (a stretch cut out of the
 * served file) lands where the gap was cut — which is the first second AFTER
 * it, exactly where the old player's hole skip would have jumped to.
 */
export function fileMsOf(meetingMs: number, window: PlaybackWindow | null): number {
  const m = Math.max(0, meetingMs);
  let removed = 0;
  for (const g of window?.gaps ?? []) {
    removed += Math.min(Math.max(0, m - g.fromMs), g.toMs - g.fromMs);
  }
  return m - removed + (window?.fromMs ?? 0);
}

/**
 * Where a file position sits on the MEETING timeline (never negative). Steps
 * over the window's `gaps`: the served second right after a cut is the
 * meeting second the gap ENDS at (half-open, like a clip).
 */
export function meetingMsOf(fileMs: number, window: PlaybackWindow | null): number {
  let m = Math.max(0, fileMs - (window?.fromMs ?? 0));
  for (const g of window?.gaps ?? []) {
    if (m >= g.fromMs) m += g.toMs - g.fromMs;
  }
  return m;
}

/**
 * How long the window runs, in ms — what the scrubber spans.
 *
 * `fileDurationMs` is whatever the media element (or the row) knows about the
 * whole file; null while metadata is still loading. An open-ended window
 * (`toMs: null`) is "to the end of the file", so it needs that number. The
 * span is on the MEETING timeline, so a window's `gaps` are inside it.
 */
export function windowDurationMs(
  window: PlaybackWindow | null,
  fileDurationMs: number | null
): number | null {
  if (!window) return fileDurationMs;
  const end = window.toMs ?? fileDurationMs;
  if (end === null) return null;
  return meetingMsOf(end, window);
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
 * file after all — a copy the browser's HTTP cache kept (`max-age=3600`) from
 * before the cut, or a server one deploy behind during a blue/green switch —
 * which `servedIsWholeFile` recognises from the media's own duration.
 *
 * A `fromMs` BELOW ZERO is legal here and means "the served file starts this
 * many ms INTO the meeting": a source meeting whose split took its opening
 * minutes keeps its own timeline (the notes still cite the old times), so its
 * cut's 0 is meeting ms `to`. `fileMsOf` / `meetingMsOf` / `windowDurationMs`
 * are plain additions and handle it unchanged.
 *
 * A source with a hole in the MIDDLE (M1, same day) is served the
 * concatenation of what it kept: its window carries the hole as a `gap`, so
 * meeting time on either side of it maps onto the contiguous served file and
 * captions, `t:` chips, seeks and the scrubber keep lining up.
 */
export interface ServedPlayback {
  window: PlaybackWindow | null;
  wholeFileWindow: PlaybackWindow | null;
  /** How long the cut should be, ms; null = unknown (no stale-copy check). */
  cutSpanMs: number | null;
}

/**
 * The segments the server cuts a file to (lib/clip-cut.ts `cutPlanOf` — the
 * same `keptSegmentsFor`), or null when it serves the file whole: one
 * segment from 0 to the end and nothing removed.
 */
function servedCutOf(kept: FileSegment[]): FileSegment[] | null {
  if (kept.length === 0) return null;
  if (kept.length === 1 && kept[0]!.fromMs <= 0 && kept[0]!.toMs === null) return null;
  return kept;
}

/**
 * Where a FILE position lands in the served cut — the concatenation of
 * `segments`. A position in a removed stretch (or before the first segment)
 * lands where the next kept segment starts.
 */
export function servedMsOfFile(fileMs: number, segments: readonly FileSegment[]): number {
  let acc = 0;
  for (const s of segments) {
    if (fileMs <= s.fromMs) return acc;
    if (s.toMs === null || fileMs < s.toMs) return acc + (fileMs - s.fromMs);
    acc += s.toMs - s.fromMs;
  }
  return acc;
}

/**
 * A window (file ms) re-expressed inside a cut of the same file — one window,
 * or the kept segments of a file with a hole in the middle. Null when the
 * window IS the cut — the player then needs no clamping at all and keeps its
 * native controls.
 */
export function windowInCut(
  window: PlaybackWindow | null,
  cut: PlaybackWindow | readonly FileSegment[]
): PlaybackWindow | null {
  if (!window) return null;
  const segments: readonly FileSegment[] = 'fromMs' in cut ? [cut] : cut;
  const from = servedMsOfFile(window.fromMs, segments);
  const to = window.toMs === null ? null : servedMsOfFile(window.toMs, segments);
  const cutEnd = servedEndOf(segments);
  const atEnd = to === null || (cutEnd !== null && to >= cutEnd);
  if (from <= 0 && atEnd) return null;
  return { fromMs: Math.max(0, from), toMs: atEnd ? null : to };
}

/** The served cut's length when every segment is closed; null when the last runs to the end. */
function servedEndOf(segments: readonly FileSegment[]): number | null {
  let total = 0;
  for (const s of segments) {
    if (s.toMs === null) return null;
    total += s.toMs - s.fromMs;
  }
  return total;
}

/**
 * The MAIN player of a meeting (its first recording), from the row's clip
 * mirror — the same clips `windowFromContext` reads and the server cuts by.
 *
 * `durationSec` is the row's `duration` (the meeting's own span, a hole
 * included); it is only used to know how long an open-ended cut should be.
 */
export function servedPlaybackFromContext(
  gmeetContext: { clips?: unknown } | null | undefined,
  durationSec: number | null | undefined
): ServedPlayback {
  const stored = storedClipsInContext(gmeetContext);
  if (!stored) return { window: null, wholeFileWindow: null, cutSpanMs: null };
  const first = [...stored].sort(compareClipsOnTimeline)[0]!;
  const cut = servedCutOf(keptSegmentsFor(stored, first.recordingId));
  // Served whole: never split, or split with `keepInBoth`.
  if (!cut) return { window: null, wholeFileWindow: null, cutSpanMs: null };
  const bounds = windowBoundsFor(stored, first.recordingId);

  // Meeting ms of the file's first byte (`offset − from` of the clip that
  // places it); the kept segments sit on the meeting timeline at file + base.
  const base = first.offsetMs - first.fromMs;
  // Meeting ms at the cut's first byte. 0 for a split-off meeting; `to` for a
  // source whose split took its opening minutes.
  const leadMs = Math.max(0, cut[0]!.fromMs + base);
  // What was cut out BETWEEN the kept segments, on the meeting's timeline.
  const gaps: ClipHole[] = [];
  for (let i = 1; i < cut.length; i++) {
    gaps.push({ fromMs: cut[i - 1]!.toMs! + base, toMs: cut[i]!.fromMs + base });
  }
  const removedMs = gaps.reduce((n, g) => n + (g.toMs - g.fromMs), 0);
  const closed = servedEndOf(cut);
  const spanMs = durationSec != null ? durationSec * 1000 - leadMs - removedMs : null;

  const window: PlaybackWindow | null =
    leadMs > 0 || gaps.length > 0
      ? { fromMs: leadMs > 0 ? -leadMs : 0, toMs: null, ...(gaps.length > 0 ? { gaps } : {}) }
      : null;
  return {
    window,
    // The whole file in file coordinates, as before the cut: the bounds (a
    // hole in the middle is skipped by the player's `holes`, as it was).
    wholeFileWindow:
      bounds.fromMs === null && bounds.toMs === null
        ? null
        : { fromMs: bounds.fromMs ?? 0, toMs: bounds.toMs },
    cutSpanMs: closed ?? (spanMs !== null && spanMs > 0 ? spanMs : null),
  };
}

/**
 * One clip PART of a combined meeting (`playerParts` in lib/combine-ui.ts):
 * its own window, inside the cut the server made of its recording — every
 * clip this meeting holds on that recording, holes between them cut out.
 */
export function servedPlaybackForPart(
  part: Pick<ClipWindow, 'recordingId' | 'fromMs' | 'toMs'>,
  clips: ReadonlyArray<Pick<ClipWindow, 'ord' | 'recordingId' | 'fromMs' | 'toMs' | 'offsetMs'>>
): ServedPlayback {
  const own: PlaybackWindow | null =
    part.fromMs > 0 || part.toMs !== null ? { fromMs: part.fromMs, toMs: part.toMs } : null;
  const cut = servedCutOf(keptSegmentsFor(clips, part.recordingId));
  if (!cut) {
    return { window: own, wholeFileWindow: own, cutSpanMs: null };
  }
  return {
    window: windowInCut(own ?? { fromMs: 0, toMs: null }, cut),
    wholeFileWindow: own,
    cutSpanMs: servedEndOf(cut),
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
