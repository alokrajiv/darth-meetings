/**
 * Cutting a meeting's media to its clip window, SERVER-SIDE (2026-10-02).
 *
 * The owner's rule: "it is not the recording being shared — it's the meeting
 * API that reveals it, as if native, internally stripping to which minute to
 * which minute or the whole recording." Until this module the meeting media
 * routes served each clip's WHOLE underlying file and only the player clamped
 * to the window, so a reader of a split-off (or combined) meeting could fetch
 * every minute of the recording with a plain GET. Now a windowed file is served
 * as a CUT rendition — produced once with ffmpeg, cached on disk — and the
 * bytes outside the window never leave the server through a meeting route.
 * Since M1 (same day) that includes a hole in the MIDDLE: a source meeting
 * whose middle stretch was split off is served the concatenation of what it
 * kept (`cutPlanOf`), so the hole's bytes are not fetchable either.
 *
 * This file is the PURE half: what counts as windowed, the cache key, the
 * ffmpeg argument lists, the keyframe-safety decision, the "is the copy
 * exact?" check and the frame refusal. No fs, no child_process, no server
 * imports — `lib/server/clip-cut.ts` runs what this decides, and the unit
 * tests exercise every decision here without spawning anything.
 *
 * Units: milliseconds of the SOURCE FILE unless a name says otherwise
 * (ffmpeg's own arguments are seconds, formatted by `secs`).
 */

import { createHash } from 'node:crypto';
import { keptSegmentsFor, storedClipsInContext } from '@/lib/clips';

/** The window of ONE stored file a meeting uses (`ResolvedMedia.windowFromMs/ToMs`). */
export interface MediaWindowLike {
  windowFromMs: number | null;
  windowToMs: number | null;
  /**
   * `ResolvedMedia.keptMs`: the stretches of the file the meeting holds when
   * there is MORE than one — a hole in the middle. Absent/null = the bounds
   * above say everything.
   */
  keptMs?: ReadonlyArray<{ fromMs: number; toMs: number | null }> | null;
}

/** A real window, in file ms. `toMs: null` = to the end of the file. */
export interface CutWindow {
  fromMs: number;
  toMs: number | null;
}

/**
 * The single window of this file the meeting's bounds describe, or null when
 * the bounds are the whole file.
 *
 * Windowed = `from > 0` or a `to` — exactly `windowBoundsFor`'s non-null
 * answer. It says nothing about a hole in the MIDDLE (a source meeting keeps
 * `null/null` bounds there): `cutPlanOf` is what the routes ask.
 */
export function cutWindowOf(m: MediaWindowLike): CutWindow | null {
  const from = m.windowFromMs ?? 0;
  const to = m.windowToMs ?? null;
  if (from <= 0 && to === null) return null;
  return { fromMs: Math.max(0, Math.round(from)), toMs: to === null ? null : Math.round(to) };
}

/**
 * What a meeting's media route serves for this file: null = the WHOLE file
 * (no copy — the fast path), else the kept SEGMENTS, in file order, that the
 * served rendition is the concatenation of.
 *
 * One segment = a window (a split-off meeting, a combined clip). Two or more
 * = a hole in the middle (a source meeting that had a stretch split off
 * without `keepInBoth`; cut since M1, 2026-10-02): the stretch between them is
 * somebody else's meeting, and its bytes are cut out — not merely skipped by
 * the player. Fractional ms are rounded so the cache key is stable.
 */
export function cutPlanOf(m: MediaWindowLike): CutWindow[] | null {
  const kept = m.keptMs ?? null;
  if (kept && kept.length >= 2) {
    return kept.map((k) => ({
      fromMs: Math.max(0, Math.round(k.fromMs)),
      toMs: k.toMs === null ? null : Math.round(k.toMs),
    }));
  }
  const w = cutWindowOf(m);
  return w ? [w] : null;
}

/**
 * Does a meeting ROW's clip mirror (`gmeet_context.clips`) make any of its
 * files served cut — a window or a hole on some recording? The media
 * sweeper's pre-cut backstop (lib/server/clip-precut.ts) reads this off the
 * row before it pays for resolving the meeting's media. Absent or malformed
 * mirror = the whole recording, never cut.
 */
export function clipMirrorNeedsCut(gmeetContext: { clips?: unknown } | null | undefined): boolean {
  const stored = storedClipsInContext(gmeetContext);
  if (!stored) return false;
  for (const recordingId of new Set(stored.map((c) => c.recordingId))) {
    const kept = keptSegmentsFor(stored, recordingId);
    if (kept.length > 1) return true;
    if (kept.length === 1 && (kept[0]!.fromMs > 0 || kept[0]!.toMs !== null)) return true;
  }
  return false;
}

/** `1200000-2000000_2400000-end` — a plan as it appears in a cut's name and log line. */
export function segmentsLabel(segments: readonly CutWindow[]): string {
  return segments.map((s) => `${s.fromMs}-${s.toMs ?? 'end'}`).join('_');
}

// ---------------------------------------------------------------------------
// The cache key
// ---------------------------------------------------------------------------

/** `audio` = the soundtrack-only rendition (`?variant=audio` of a VIDEO file). */
export type CutVariant = 'av' | 'audio';

/**
 * `${MW_STORAGE_DIR}/clips/<meeting>/<variant>.<from>-<to|end>[_<from>-<to|end>…].<src8>.<ext>`.
 *
 * Everything that decides the BYTES is in the name — the meeting, EVERY kept
 * segment (one for a window; several, `_`-joined, for a file with a hole in
 * the middle), the source file (an 8-hex hash of its stored name) and the
 * variant — so a cut can never be served for a window, a hole or a file it
 * was not made from, even if a cleanup hook was missed: a re-split simply
 * asks for a different name. A one-segment name is exactly the name a window
 * cut had before holes were cut, so caches made then stay valid.
 * The extension is NOT in the stem because it depends on which attempt
 * succeeded (a stream copy keeps the source container, a re-encode is mp4/m4a);
 * `cutAttempts` lists the candidates in order.
 *
 * `meetingId` is the URL id (`transcripts.assemblyai_id`) — the same key the
 * frame cache uses — and must be a plain token; anything else throws, so a
 * crafted id can never become a path.
 */
export function clipCutStem(input: {
  meetingId: string;
  sourceFilename: string;
  segments: readonly CutWindow[];
  variant: CutVariant;
}): { dir: string; stem: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(input.meetingId)) {
    throw new Error(`Refusing unsafe meeting id for the clip cache: ${input.meetingId}`);
  }
  assertValidSegments(input.segments);
  const src = createHash('md5').update(input.sourceFilename).digest('hex').slice(0, 8);
  return {
    dir: `clips/${input.meetingId}`,
    stem: `${input.variant}.${segmentsLabel(input.segments)}.${src}`,
  };
}

/**
 * Integer ms, in file order, strictly apart (`keptSegmentsFor` merges touching
 * segments, so a plan that touches is not canonical and would name the same
 * bytes two ways), and only the LAST may run to the end. Anything else throws:
 * it is a bug upstream, never something to cut.
 */
function assertValidSegments(segments: readonly CutWindow[]): void {
  if (segments.length === 0) throw new Error('Refusing an empty cut plan');
  let prevTo = -1;
  segments.forEach(({ fromMs, toMs }, i) => {
    const last = i === segments.length - 1;
    const bad =
      !Number.isInteger(fromMs) ||
      fromMs < 0 ||
      fromMs <= prevTo ||
      (toMs === null ? !last : !Number.isInteger(toMs) || toMs <= fromMs);
    if (bad) throw new Error(`Refusing an invalid cut plan ${segmentsLabel(segments)}`);
    prevTo = toMs ?? Number.POSITIVE_INFINITY;
  });
}

// ---------------------------------------------------------------------------
// What to try, in order
// ---------------------------------------------------------------------------

/** Containers we stream-copy into, keyed by stored extension → ffmpeg muxer. */
const COPY_MUXER: Record<string, string> = {
  mp4: 'mp4',
  m4v: 'mp4',
  m4a: 'mp4',
  mov: 'mov',
  webm: 'webm',
  mkv: 'matroska',
  mka: 'matroska',
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  flac: 'flac',
  aac: 'adts',
};

const ISO_BMFF = new Set(['mp4', 'mov']);

export function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(i + 1).toLowerCase() : '';
}

/** One way of producing the cut. */
export interface CutAttempt {
  /** copy = no re-encode at all; reencode-audio / reencode-video = the fallback. */
  mode: 'copy' | 'reencode-audio' | 'reencode-video';
  /** What the output carries. */
  output: 'av' | 'audio';
  /** Output file extension (no dot). */
  ext: string;
  /** ffmpeg muxer (`-f`) — needed because the work file is `<name>.tmp`. */
  format: string;
}

/**
 * The attempts for one cut, best first. The runner tries them in order and
 * keeps the first whose output passes `cutIsExact`.
 *
 * - VIDEO file, `av` rendition: a stream copy only when it is KEYFRAME-SAFE
 *   (`keyframeSafe` — a keyframe sits on `from`, or `from` is 0). With `-ss`
 *   before `-i` a copy starts at the keyframe AT OR BEFORE `from`, so on any
 *   other position it would carry up to a GOP of the previous meeting — which
 *   is exactly the leak this module exists to close. Otherwise, and as the
 *   fallback, a fast H.264/AAC re-encode into mp4 (accurate seek: ffmpeg
 *   decodes from the keyframe and drops what precedes `from`).
 * - VIDEO file, `audio` rendition (`?variant=audio`): `-c copy` into m4a when
 *   the track is AAC AND the start is keyframe-safe — the demuxer seeks a
 *   video container to the video keyframe, so even an audio-only copy starts
 *   there (measured: a 3 s cut of a 2 s-GOP mp4 came out 5.1 s) — else, and as
 *   the fallback, the same mono 64 kbps AAC the audio-only derivative uses.
 * - AUDIO file: `-c copy` into its own container when we know a muxer for it,
 *   then a re-encode into m4a when the copy is not exact. Audio packets are
 *   ~20 ms, so a copy is as exact as a meeting needs.
 */
export function cutAttempts(input: {
  sourceFilename: string;
  sourceHasVideo: boolean;
  variant: CutVariant;
  /** `codec_name` of the first audio stream, lower-case; null = unknown/none. */
  audioCodec: string | null;
  /** For a plan of several segments: true only when EVERY segment's start is
   * keyframe-safe — one attempt is applied to all of them (`buildConcatArgs`). */
  keyframeSafe: boolean;
}): CutAttempt[] {
  const ext = extOf(input.sourceFilename);
  const out: CutAttempt[] = [];
  if (input.sourceHasVideo && input.variant === 'av') {
    if (input.keyframeSafe && COPY_MUXER[ext] && ext !== 'm4a' && ext !== 'mka') {
      out.push({ mode: 'copy', output: 'av', ext, format: COPY_MUXER[ext]! });
    }
    out.push({ mode: 'reencode-video', output: 'av', ext: 'mp4', format: 'mp4' });
    return out;
  }
  if (input.sourceHasVideo) {
    if (input.audioCodec === 'aac' && input.keyframeSafe) out.push({ mode: 'copy', output: 'audio', ext: 'm4a', format: 'mp4' });
    out.push({ mode: 'reencode-audio', output: 'audio', ext: 'm4a', format: 'mp4' });
    return out;
  }
  if (COPY_MUXER[ext]) out.push({ mode: 'copy', output: 'audio', ext, format: COPY_MUXER[ext]! });
  out.push({ mode: 'reencode-audio', output: 'audio', ext: 'm4a', format: 'mp4' });
  return out;
}

/** Seconds, as ffmpeg wants them: three decimals, never exponent notation. */
export function secs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/**
 * The ffmpeg argument list for ONE attempt.
 *
 * `-ss` goes BEFORE `-i` (a fast input seek — and with a re-encode an exact
 * one) and the end is `-t <to − from>` after it, which is `-to` expressed as a
 * duration so it means the same thing on every ffmpeg the VM has ever run.
 * `-avoid_negative_ts make_zero` makes the cut start at 0 — the player treats
 * the served file as starting at the clip's first second.
 *
 * `audioTracks: 'all'` keeps every audio track of an audio-only source (a
 * multi-track recording carries its mix as track 0 and the rest beside it);
 * the `?variant=audio` rendition is the mix alone, like the derivative.
 */
export function buildCutArgs(input: {
  src: string;
  out: string;
  window: CutWindow;
  attempt: CutAttempt;
  audioTracks: 'all' | 'first';
}): string[] {
  const { fromMs, toMs } = input.window;
  const a = input.attempt;
  const args = ['-y', '-loglevel', 'error', '-nostdin'];
  if (fromMs > 0) args.push('-ss', secs(fromMs));
  args.push('-i', input.src);
  if (toMs !== null) args.push('-t', secs(toMs - fromMs));

  const audioMap = input.audioTracks === 'all' ? '0:a?' : '0:a:0';
  if (a.output === 'av') {
    args.push('-map', '0:v:0?', '-map', '0:a?');
  } else {
    args.push('-map', audioMap, '-vn');
  }
  args.push('-sn', '-dn');

  switch (a.mode) {
    case 'copy':
      args.push('-c', 'copy');
      break;
    case 'reencode-video':
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k'
      );
      break;
    case 'reencode-audio':
      args.push('-c:a', 'aac');
      // The `?variant=audio` rendition of a video matches the audio-only
      // derivative (mono 64 kbps); an audio source keeps a sensible bitrate.
      if (input.audioTracks === 'first') args.push('-ac', '1', '-b:a', '64k');
      else args.push('-b:a', '128k');
      break;
  }
  args.push('-avoid_negative_ts', 'make_zero');
  if (a.format === 'mp4' || ISO_BMFF.has(a.ext)) args.push('-movflags', '+faststart');
  args.push('-f', a.format, input.out);
  return args;
}

/**
 * Joining the per-segment cuts of a plan with a hole in the middle into ONE
 * served file: the concat DEMUXER over the segment files, stream-copied.
 *
 * That is only sound when every segment was produced the SAME way — all
 * stream copies of one source, or all re-encodes with one setting — because
 * the demuxer takes the codec parameters from the first file. The runner
 * therefore applies ONE attempt to every segment (`cutAttempts` with the
 * keyframe verdict AND-ed over the segments) and never mixes them.
 */
export function buildConcatArgs(input: { list: string; out: string; attempt: CutAttempt }): string[] {
  const a = input.attempt;
  const args = ['-y', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', input.list];
  args.push('-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero');
  if (a.format === 'mp4' || ISO_BMFF.has(a.ext)) args.push('-movflags', '+faststart');
  args.push('-f', a.format, input.out);
  return args;
}

/** The concat demuxer's list file: one `file '<path>'` line per segment, quotes escaped. */
export function concatListBody(paths: readonly string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'\n`).join('');
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** How far a keyframe may sit from `from` and still count as "on" it (≈ one frame). */
export const KEYFRAME_TOLERANCE_MS = 50;

/**
 * Is a stream copy of the VIDEO safe — does it start exactly where the window
 * does? True at the top of the file; otherwise only when a keyframe's
 * presentation time (relative to the file's start time, which is how `-ss`
 * counts) is within `KEYFRAME_TOLERANCE_MS` of `from`.
 */
export function isKeyframeSafe(input: {
  fromMs: number;
  keyframePtsSec: number[];
  startTimeSec: number | null;
}): boolean {
  if (input.fromMs <= 0) return true;
  const base = input.startTimeSec ?? 0;
  return input.keyframePtsSec.some(
    (pts) => Math.abs((pts - base) * 1000 - input.fromMs) <= KEYFRAME_TOLERANCE_MS
  );
}

/**
 * Parse `ffprobe -show_entries packet=pts_time,flags -of json` into the
 * keyframe presentation times, in seconds. Tolerates junk.
 */
export function keyframesFromProbe(json: unknown): number[] {
  const packets = (json as { packets?: unknown })?.packets;
  if (!Array.isArray(packets)) return [];
  const out: number[] = [];
  for (const p of packets) {
    const flags = (p as { flags?: unknown }).flags;
    const pts = Number.parseFloat(String((p as { pts_time?: unknown }).pts_time));
    if (typeof flags === 'string' && flags.includes('K') && Number.isFinite(pts)) out.push(pts);
  }
  return out;
}

/** Slack on a cut's duration: AAC/MP3 packet edges and a trailing video frame. */
export const CUT_DURATION_TOLERANCE_MS = 750;

/**
 * The cut's expected length: the window, clipped to the file when the file is
 * shorter than the window says (or the window runs to the end). Null when it
 * cannot be known (open-ended window, unknown source duration).
 */
export function expectedCutMs(window: CutWindow, sourceDurationMs: number | null): number | null {
  const end =
    window.toMs === null
      ? sourceDurationMs
      : sourceDurationMs !== null
        ? Math.min(window.toMs, sourceDurationMs)
        : window.toMs;
  if (end === null) return null;
  return Math.max(0, end - window.fromMs);
}

/**
 * The served length of a whole plan: the sum of its segments. Null when any
 * segment's length cannot be known (open-ended, unknown source duration).
 */
export function expectedPlanMs(segments: readonly CutWindow[], sourceDurationMs: number | null): number | null {
  let total = 0;
  for (const s of segments) {
    const ms = expectedCutMs(s, sourceDurationMs);
    if (ms === null) return null;
    total += ms;
  }
  return total;
}

/**
 * What the served rendition of a plan should weigh before it has been cut
 * (`GET /api/offline/plan`, 2026-10-02 M3): the source's bytes in proportion
 * to the kept time. A re-encode does not keep the source's bitrate, so this
 * is an ESTIMATE and the plan flags it. Null when a length is unknown.
 */
export function estimateCutBytes(input: {
  sourceBytes: number | null;
  sourceDurationMs: number | null;
  segments: readonly CutWindow[];
}): number | null {
  const { sourceBytes, sourceDurationMs } = input;
  if (sourceBytes === null || sourceDurationMs === null || sourceDurationMs <= 0) return null;
  const kept = expectedPlanMs(input.segments, sourceDurationMs);
  if (kept === null) return null;
  return Math.round(sourceBytes * Math.min(1, kept / sourceDurationMs));
}

/**
 * Did an attempt produce the window and nothing else? A copy that started at
 * an earlier keyframe comes out LONGER by up to a GOP; a broken one shorter.
 * Either way the next attempt runs. With no expectation (unknown length) a
 * non-empty output is accepted.
 */
export function cutIsExact(input: { actualMs: number | null; expectedMs: number | null }): boolean {
  if (input.actualMs === null || !Number.isFinite(input.actualMs) || input.actualMs <= 0) return false;
  if (input.expectedMs === null) return true;
  const slack = Math.max(CUT_DURATION_TOLERANCE_MS, input.expectedMs * 0.005);
  return Math.abs(input.actualMs - input.expectedMs) <= slack;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Why a frame at file position `fileMs` may NOT be served for this meeting,
 * or null when it may. The window bounds are the media's own (`windowFromMs`
 * / `windowToMs`, file ms); `holes` are the meeting's split-off stretches on
 * ITS timeline, checked against `meetingMs`.
 *
 * Half-open like a clip: `to` itself is already the next meeting.
 */
export function frameRefusal(input: {
  media: MediaWindowLike;
  fileMs: number;
  meetingMs: number;
  holes?: Array<{ fromMs: number; toMs: number }>;
}): 'before-window' | 'after-window' | 'in-hole' | null {
  const from = input.media.windowFromMs ?? 0;
  const to = input.media.windowToMs;
  if (input.fileMs < from) return 'before-window';
  if (to !== null && input.fileMs >= to) return 'after-window';
  for (const h of input.holes ?? []) {
    if (input.meetingMs >= h.fromMs && input.meetingMs < h.toMs) return 'in-hole';
  }
  return null;
}
