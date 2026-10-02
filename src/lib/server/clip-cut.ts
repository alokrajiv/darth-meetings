import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getStorageDir, resolveAudioPath } from '@/lib/server/audio-storage';
import { hasVideoStream, mediaHasVideo } from '@/lib/server/video-frames';
import { ensureLocalMedia } from '@/lib/server/media-local';
import type { ResolvedMedia } from '@/lib/server/recordings';
import {
  buildConcatArgs,
  buildCutArgs,
  clipCutStem,
  concatListBody,
  cutAttempts,
  cutIsExact,
  expectedCutMs,
  expectedPlanMs,
  extOf,
  segmentsLabel,
  isKeyframeSafe,
  keyframesFromProbe,
  type CutVariant,
  type CutWindow,
} from '@/lib/clip-cut';

const execFileP = promisify(execFile);

/**
 * The CUT renditions a meeting's media routes serve (lib/clip-cut.ts has the
 * why and every pure decision; this file runs them).
 *
 * Layout: `${MW_STORAGE_DIR}/clips/<meeting id>/<variant>.<segments>.<src8>.<ext>`
 * — e.g. `clips/9f1c…/av.1200000-2000000.1a2b3c4d.mp4` for a window,
 * `av.0-1200000_2000000-end.1a2b3c4d.mp4` for a source with a hole in the
 * middle, and, for `?variant=audio` of a video, `audio.<segments>.<src8>.m4a`.
 *
 * - EARLY, AND LAZY AS THE FALLBACK: the clip writers queue the cut the
 *   moment a window or hole is written (lib/server/clip-precut.ts, M2), the
 *   media sweeper backfills any that is missing, and a meeting route that
 *   still finds none makes it on the spot.
 * - ONCE: one in-flight ffmpeg per output stem, process-wide (globalThis, for
 *   the same reason audio-only.ts keeps its map there — Next bundles a module
 *   once per route graph, and two route graphs must join one job). The
 *   pre-cut goes through the same `ensureClipCut`, so it joins a request's
 *   job and vice versa.
 * - ATOMIC: ffmpeg writes `<name>.<pid>.tmp`, the duration is checked, then a
 *   rename. A reader never sees a half-written cut, and the two colours of a
 *   blue/green deploy never write the same temp file.
 * - HOLES: a plan of several segments (lib/clip-cut.ts `cutPlanOf`) is cut
 *   segment by segment with ONE attempt for all of them, then joined with the
 *   concat demuxer into one file; each segment and the whole are checked.
 * - STALE-SAFE: everything that decides the bytes is in the name, and a cut
 *   older than its source (the source replaced in place) is rebuilt.
 * - LOCAL ONLY: cuts are not archived to Blob. They are derivatives that the
 *   source rebuilds in seconds (a copy) to minutes (a re-encode); a VM that
 *   lost its cache simply regenerates on the next request. The SOURCE may be
 *   archived-and-purged: it is then pulled through media-local's bounded
 *   cache (`ensureLocalMedia`) for the one ffmpeg run, exactly as frames are.
 * - CLEANED: `dropClipCuts(meeting)` removes the meeting's whole directory. It
 *   runs whenever the meeting's clips are rewritten (`setClipMirror` — split,
 *   un-split, combine add / patch / delete / rollback) and on permanent delete.
 *
 * A source meeting with a HOLE in the middle keeps its own timeline (the hole
 * stays where its notes say it is); only the SERVED file is contiguous, and
 * the player maps meeting time across the removed span (lib/clip-window.ts
 * `PlaybackWindow.gaps`). Only a meeting that holds the whole file with no
 * hole is served the file itself.
 */

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_OPTS = { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 } as const;

export interface ClipCutRequest {
  /** `transcripts.assemblyai_id` — the URL id, and the cache directory. */
  meetingId: string;
  /** The stored source (`ResolvedMedia.filename`). */
  sourceFilename: string;
  /** What the meeting keeps of the file, in file order (`cutPlanOf`): one
   * segment for a window, several for a hole in the middle. */
  segments: CutWindow[];
  variant: CutVariant;
  /** `?part=N`, for the log line only. */
  part: number;
  /** Who asked, for the log line only: `route`, `split`, `sweeper`, … */
  trigger?: string;
  /**
   * `ResolvedMedia.durationMs` — only a fallback for the file's own probed
   * length: in the row-fallback resolver it is the ROW's duration, which for
   * a split-off meeting is its window, not the file.
   */
  sourceDurationMs?: number | null;
  /** Overrides the video probe (tests); otherwise `mediaHasVideo` / ffprobe. */
  sourceHasVideo?: boolean | null;
  /**
   * The resolved file, when the caller has it (the audio route always does):
   * lets a source whose stored copy was archived and purged be pulled from
   * the archive (`ensureLocalMedia`) instead of answering "missing".
   */
  media?: ResolvedMedia;
}

export type ClipCutResult =
  | { status: 'ready'; path: string; contentType: string }
  | { status: 'missing' } // the source bytes are not on this VM
  | { status: 'error'; error: string };

const g = globalThis as unknown as { __mwClipCutInflight?: Map<string, Promise<ClipCutResult>> };
const inflight = (g.__mwClipCutInflight ??= new Map<string, Promise<ClipCutResult>>());

export { clipCutRoot, dropClipCuts } from '@/lib/server/clip-cut-store';

function contentTypeFor(ext: string, output: 'av' | 'audio'): string {
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return output === 'av' ? 'video/mp4' : 'audio/mp4';
    case 'm4a':
      return 'audio/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'webm':
      return output === 'av' ? 'video/webm' : 'audio/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'mka':
      return 'audio/x-matroska';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}

/** What ffprobe says about the source, in one call. */
interface SourceFacts {
  hasVideo: boolean;
  audioCodec: string | null;
  durationMs: number | null;
  startTimeSec: number | null;
}

async function probeSource(abs: string): Promise<SourceFacts> {
  const { stdout } = await execFileP(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration,start_time', '-of', 'json', abs],
    PROBE_OPTS
  );
  const j = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string }>;
    format?: { duration?: string; start_time?: string };
  };
  const streams = j.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const dur = Number.parseFloat(j.format?.duration ?? '');
  const start = Number.parseFloat(j.format?.start_time ?? '');
  return {
    hasVideo: streams.some((s) => s.codec_type === 'video'),
    audioCodec: audio?.codec_name?.toLowerCase() ?? null,
    durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
    startTimeSec: Number.isFinite(start) ? start : null,
  };
}

/** Video keyframe times in a short stretch around `fromMs` (packets only — no decode). */
async function keyframesNear(abs: string, fromMs: number): Promise<number[]> {
  const lo = Math.max(0, fromMs / 1000 - 15);
  const hi = fromMs / 1000 + 1;
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-read_intervals', `${lo.toFixed(3)}%${hi.toFixed(3)}`,
        '-show_entries', 'packet=pts_time,flags',
        '-of', 'json',
        abs,
      ],
      PROBE_OPTS
    );
    return keyframesFromProbe(JSON.parse(stdout));
  } catch {
    return []; // unknown ⇒ not keyframe-safe ⇒ re-encode, never a leaky copy
  }
}

async function probeDurationMs(abs: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs],
      PROBE_OPTS
    );
    const d = Number.parseFloat(stdout.trim());
    return Number.isFinite(d) ? Math.round(d * 1000) : null;
  } catch {
    return null;
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 60000} min`));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? signal}: ${stderr.trim() || 'no stderr'}`));
    });
  });
}

/**
 * An existing, fresh cut for this stem, whatever its extension (it depends on
 * which attempt succeeded). A cut older than its source is deleted and missed.
 */
async function existingCut(
  dir: string,
  stem: string,
  srcMtimeMs: number,
  opts: { remove: boolean } = { remove: true }
): Promise<string | null> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    // The stem ends in `.<src8>`, so no other plan's name starts with it.
    if (!name.startsWith(`${stem}.`) || name.endsWith('.tmp')) continue;
    const p = path.join(dir, name);
    const st = await fsp.stat(p).catch(() => null);
    if (!st || st.size === 0) continue;
    if (st.mtimeMs < srcMtimeMs) {
      if (opts.remove) await fsp.unlink(p).catch(() => {});
      continue;
    }
    return p;
  }
  return null;
}

interface CutKey {
  hasVideo: boolean;
  variant: CutVariant;
  dir: string;
  stem: string;
}

/** Where a request's cut lives. `?variant=audio` of an AUDIO file is the same
 * bytes as the plain cut, so both name the `av` stem. `hasVideoStream` is
 * cached per process. */
async function cutKeyOf(req: ClipCutRequest): Promise<CutKey | { error: string }> {
  const hasVideo =
    req.sourceHasVideo ??
    (req.media ? await mediaHasVideo(req.media) : await hasVideoStream(req.sourceFilename));
  const variant: CutVariant = hasVideo ? req.variant : 'av';
  try {
    const k = clipCutStem({
      meetingId: req.meetingId,
      sourceFilename: req.sourceFilename,
      segments: req.segments,
      variant,
    });
    return { hasVideo, variant, dir: path.join(getStorageDir(), k.dir), stem: k.stem };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The cut for one (meeting, file, plan, variant) — from the cache, or made
 * now. Concurrent callers for the same stem share ONE job (and so one
 * ffmpeg): the job is registered synchronously after the only await, so two
 * requests can never both miss it. Never throws: failures come back as
 * `{ status: 'error' }` and the next request retries.
 */
export async function ensureClipCut(req: ClipCutRequest): Promise<ClipCutResult> {
  const k = await cutKeyOf(req);
  if ('error' in k) return { status: 'error', error: k.error };
  const key = path.join(k.dir, k.stem);
  const running = inflight.get(key);
  if (running) return running;
  const job = cutOnce({ ...req, variant: k.variant }, k.hasVideo, k.dir, k.stem).finally(() =>
    inflight.delete(key)
  );
  inflight.set(key, job);
  return job;
}

/**
 * The cut that is ALREADY on disk for this request, or null — never makes
 * one. For the readers that only want to know (the media sweeper's pre-cut
 * backstop, the offline plan's sizes). A cut older than its stored source
 * counts as absent.
 */
export async function findClipCut(req: ClipCutRequest): Promise<{ path: string; bytes: number } | null> {
  const k = await cutKeyOf(req);
  if ('error' in k) return null;
  let srcMtimeMs = 0;
  try {
    srcMtimeMs = (await fsp.stat(resolveAudioPath(req.sourceFilename)).catch(() => null))?.mtimeMs ?? 0;
  } catch {
    srcMtimeMs = 0;
  }
  const found = await existingCut(k.dir, k.stem, srcMtimeMs, { remove: false });
  if (!found) return null;
  const st = await fsp.stat(found).catch(() => null);
  return st ? { path: found, bytes: st.size } : null;
}

const durationCache = new Map<string, number | null>();

/**
 * A stored file's own length, ms (ffprobe, cached per name + mtime). What the
 * offline plan's size estimate divides by when the resolver's `durationMs`
 * cannot be trusted to be the FILE's (the row fallback).
 */
export async function storedFileDurationMs(filename: string): Promise<number | null> {
  let abs: string;
  try {
    abs = resolveAudioPath(filename);
  } catch {
    return null;
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return null;
  const key = `${filename}@${st.mtimeMs}`;
  if (durationCache.has(key)) return durationCache.get(key) ?? null;
  const ms = await probeDurationMs(abs);
  if (durationCache.size > 2000) durationCache.clear();
  durationCache.set(key, ms);
  return ms;
}

/** How many cuts are being looked up or produced right now (diagnostics). */
export function clipCutInFlight(): number {
  return inflight.size;
}

function outputOf(hasVideo: boolean, variant: CutVariant): 'av' | 'audio' {
  return hasVideo && variant === 'av' ? 'av' : 'audio';
}

async function cutOnce(
  req: ClipCutRequest,
  hasVideo: boolean,
  dir: string,
  stem: string
): Promise<ClipCutResult> {
  let stored: string;
  try {
    stored = resolveAudioPath(req.sourceFilename);
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  const storedSt = await fsp.stat(stored).catch(() => null);

  // An archived copy never changes, so only a file ON DISK can make a cut stale.
  const cached = await existingCut(dir, stem, storedSt?.mtimeMs ?? 0);
  if (cached) {
    return { status: 'ready', path: cached, contentType: contentTypeFor(extOf(cached), outputOf(hasVideo, req.variant)) };
  }

  // The source: the stored file, or — its copy archived and purged (Stage D)
  // — the archived blob pulled into media-local's bounded cache for this one
  // cut (`ensureLocalMedia`, the same path frames and voiceprints use). The
  // cut itself stays local either way; it is never archived.
  if (storedSt) return produceCut(req, hasVideo, dir, stem, stored);
  const local = req.media
    ? await ensureLocalMedia(req.media, hasVideo && req.variant === 'audio' ? 'audio' : 'video', {
        purpose: 'clip-cut',
      })
    : null;
  if (!local) return { status: 'missing' };
  try {
    return await produceCut(req, hasVideo, dir, stem, local.path);
  } finally {
    local.release();
  }
}

async function produceCut(
  req: ClipCutRequest,
  hasVideo: boolean,
  dir: string,
  stem: string,
  src: string
): Promise<ClipCutResult> {
  let facts: SourceFacts;
  try {
    facts = await probeSource(src);
  } catch (e) {
    return { status: 'error', error: `ffprobe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  // The FILE's own length first: the resolver's `durationMs` is, in the row
  // fallback, the row's duration — for a split-off meeting its window, which
  // would make every open-ended or file-clipped expectation wrong.
  const sourceDurationMs = facts.durationMs ?? req.sourceDurationMs ?? null;
  const segments = req.segments;

  // One verdict for the whole plan: a copy is only taken when EVERY segment
  // starts on a keyframe, because the segments are joined by a stream copy
  // that needs them all made the same way (`buildConcatArgs`).
  let keyframeSafe = true;
  if (hasVideo) {
    for (const seg of segments) {
      if (seg.fromMs <= 0) continue;
      const safe = isKeyframeSafe({
        fromMs: seg.fromMs,
        keyframePtsSec: await keyframesNear(src, seg.fromMs),
        startTimeSec: facts.startTimeSec,
      });
      if (!safe) {
        keyframeSafe = false;
        break;
      }
    }
  }

  const attempts = cutAttempts({
    sourceFilename: req.sourceFilename,
    sourceHasVideo: hasVideo,
    variant: req.variant,
    audioCodec: facts.audioCodec,
    keyframeSafe,
  });

  await fsp.mkdir(dir, { recursive: true });
  const expected = expectedPlanMs(segments, sourceDurationMs);
  const started = Date.now();
  const tag =
    `${req.meetingId} part=${req.part} ${segmentsLabel(segments)} ${req.variant}` +
    (segments.length > 1 ? ` segments=${segments.length}` : '') +
    (req.trigger ? ` via=${req.trigger}` : '');
  const failures: string[] = [];
  // An audio-only SOURCE keeps all its tracks; the soundtrack rendition of a
  // video is the mix (track 0), like the audio-only derivative.
  const audioTracks = hasVideo ? 'first' : 'all';

  for (const attempt of attempts) {
    const out = path.join(dir, `${stem}.${attempt.ext}`);
    const tmp = `${out}.${process.pid}.tmp`;
    const scratch: string[] = [];
    await fsp.unlink(tmp).catch(() => {});
    try {
      if (segments.length === 1) {
        await runFfmpeg(buildCutArgs({ src, out: tmp, window: segments[0]!, attempt, audioTracks }));
      } else {
        // A hole in the middle: each kept segment cut on its own with THIS
        // attempt, each checked, then joined by a stream copy into one file.
        const parts: string[] = [];
        for (const [i, seg] of segments.entries()) {
          const part = path.join(dir, `${stem}.s${i}.${process.pid}.tmp`);
          scratch.push(part);
          await fsp.unlink(part).catch(() => {});
          await runFfmpeg(buildCutArgs({ src, out: part, window: seg, attempt, audioTracks }));
          const got = await probeDurationMs(part);
          const want = expectedCutMs(seg, sourceDurationMs);
          if (!cutIsExact({ actualMs: got, expectedMs: want })) {
            throw new Error(`segment ${i + 1}/${segments.length} is ${got ?? '?'} ms, wanted ${want ?? '?'} ms`);
          }
          parts.push(part);
        }
        const list = path.join(dir, `${stem}.list.${process.pid}.tmp`);
        scratch.push(list);
        await fsp.writeFile(list, concatListBody(parts));
        await runFfmpeg(buildConcatArgs({ list, out: tmp, attempt }));
      }
      const actual = await probeDurationMs(tmp);
      if (!cutIsExact({ actualMs: actual, expectedMs: expected })) {
        failures.push(`${attempt.mode}: ${actual ?? '?'} ms, wanted ${expected ?? '?'} ms`);
        await fsp.unlink(tmp).catch(() => {});
        continue;
      }
      await fsp.mkdir(dir, { recursive: true }); // a cleanup may have raced us
      await fsp.rename(tmp, out);
      const bytes = (await fsp.stat(out).catch(() => null))?.size ?? 0;
      console.log(
        `[clip-cut] ${tag} mode=${attempt.mode}${keyframeSafe ? '' : ' (not keyframe-safe)'} ` +
          `ms=${Date.now() - started} bytes=${bytes} dur=${actual}`
      );
      return { status: 'ready', path: out, contentType: contentTypeFor(attempt.ext, attempt.output) };
    } catch (e) {
      failures.push(`${attempt.mode}: ${e instanceof Error ? e.message : String(e)}`);
      await fsp.unlink(tmp).catch(() => {});
    } finally {
      for (const f of scratch) await fsp.unlink(f).catch(() => {});
    }
  }
  const error = `no attempt produced the window (${failures.join(' | ')})`;
  console.error(`[clip-cut] ${tag} FAILED ms=${Date.now() - started}: ${error}`);
  return { status: 'error', error };
}

/**
 * Wait for a cut, but not for ever: a long video re-encode keeps running in the
 * background and the caller answers "preparing" instead of holding a request
 * open. `null` = not ready within `waitMs`.
 */
export async function clipCutWithin(req: ClipCutRequest, waitMs: number): Promise<ClipCutResult | null> {
  const job = ensureClipCut(req);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([job, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

