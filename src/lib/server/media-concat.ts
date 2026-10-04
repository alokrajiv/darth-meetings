import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensureAudioDir, getAudioDir, resolveAudioPath } from '@/lib/server/audio-storage';
import { dropScratchDir, makeScratchDir, moveFromScratch } from '@/lib/server/scratch-dir';

const execFileP = promisify(execFile);

/**
 * Where one concat job works. With `MW_SCRATCH_DIR` set (the VM's NVMe —
 * DEC-3's scratch rule) the list file and the several-GB output are written
 * there and the result is moved into the audio dir at the end; with it unset
 * this is today's code exactly: straight into the audio dir, no move.
 */
interface ConcatOpts {
  /** Names the scratch directory (`<root>/<scratchId>/`). */
  scratchId?: string;
  /**
   * TESTS ONLY: append a filter that does not exist to every video leg of the
   * re-encode, so the video attempt fails the way a real one can and the
   * audio-only retry is exercised. Never set by a caller.
   */
  breakVideoForTest?: boolean;
}

async function openWorkspace(
  scratchId: string | undefined
): Promise<{ dir: string; scratch: string | null }> {
  await ensureAudioDir();
  const scratch = scratchId ? await makeScratchDir(scratchId) : null;
  return { dir: scratch ?? getAudioDir(), scratch };
}

/** Put the finished output where the ingest expects it (`<audio dir>/<name>`). */
async function landOutput(
  workspace: { dir: string; scratch: string | null },
  outName: string
): Promise<void> {
  if (!workspace.scratch) return; // already written in the audio dir
  await moveFromScratch(path.join(workspace.dir, outName), resolveAudioPath(outName));
}

/**
 * Concatenate stored media files (a multi-video meeting's primary + part
 * segments) into one temp file in the audio dir, returning its filename —
 * same filesystem as the final store, so the ingest rename stays atomic.
 *
 * Stream-copy only (`-c copy`): Meet segments of one conference share codecs,
 * so this is a fast remux, not a re-encode. If the inputs genuinely differ
 * (mixed containers/codecs) ffmpeg fails and we surface its stderr — better
 * an honest error than a silent hours-long re-encode on the VM.
 */
export async function concatMediaToTemp(filenames: string[], opts: ConcatOpts = {}): Promise<string> {
  return concatMediaPathsToTemp(filenames.map(resolveAudioPath), opts);
}

/**
 * `concatMediaToTemp` over ABSOLUTE input paths — for inputs that are not
 * (or no longer) under the audio dir: a stored file Stage D evicted is read
 * from media-local's cache (docs/recordings-stage-d-spec.md "As built —
 * readers"). The output still lands in the audio dir as a temp the ingest
 * consumes; the inputs are only read.
 */
export async function concatMediaPathsToTemp(paths: string[], opts: ConcatOpts = {}): Promise<string> {
  const workspace = await openWorkspace(opts.scratchId);
  const listPath = path.join(workspace.dir, `concat-${randomUUID()}.txt`);
  // Container by CONTENT, not habit: stitched phone recordings (m4a) are
  // audio-only AAC — naming them .mp4 made the transcript page call them
  // "Uploaded video" and offer a video toggle (Alok 2026-08-30). The
  // re-encode path below already picks this way.
  //
  // Asked of the SET, not of `filenames[0]`: a group whose first part is
  // audio-only and whose later parts carry a window (Darth Recorder 0.3.15
  // lets a video source be added mid-call) would otherwise be named `.m4a`
  // and be treated as audio for the rest of its life (2026-09-22).
  const anyHasVideo = (
    await Promise.all(paths.map(async (abs) => (await probeMediaAt(path.basename(abs), abs)).hasVideo))
  ).some(Boolean);
  const outName = `concat-${randomUUID()}.${anyHasVideo ? 'mp4' : 'm4a'}`;
  const outAbs = path.join(workspace.dir, outName);
  // ffmpeg concat-demuxer list syntax: file 'path' — single quotes escaped.
  const list = paths.map((abs) => `file '${abs.replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listPath, list);
  try {
    await execFileP(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        // Every stream, not ffmpeg's one-per-type default: Darth Recorder
        // segments carry two audio tracks (system + mic) and the default
        // selection silently dropped the mic (2026-09-16).
        '-map', '0',
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y',
        outAbs,
      ],
      { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }
    );
    await landOutput(workspace, outName);
    return outName;
  } catch (err) {
    await fsp.unlink(outAbs).catch(() => {});
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).slice(-500) : '';
    throw new Error(`ffmpeg concat failed${stderr ? `: ${stderr}` : `: ${String(err)}`}`);
  } finally {
    await fsp.unlink(listPath).catch(() => {});
    await dropScratchDir(workspace.scratch);
  }
}

/** Media duration in seconds via ffprobe, or null when unreadable. */
export async function probeDurationSec(filename: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        resolveAudioPath(filename),
      ],
      { timeout: 30_000 }
    );
    const sec = Number(stdout.trim());
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null;
  }
}

/**
 * What one part of a stitch actually contains. One ffprobe per file, read by
 * both the container choice and the re-encode filter graph.
 */
interface PartProbe {
  filename: string;
  /** A real picture track — an mp4 cover-art `attached_pic` does not count. */
  hasVideo: boolean;
  /** How many audio streams the file carries (the tray writes mix+system+mic). */
  audioTracks: number;
  /**
   * Per audio stream, in file order: its language tag and default flag. The
   * tray labels its tracks by language (`qmx` mix, `mul` system, `eng` mic)
   * and `normalizeMultiTrack` finds the mix by that tag — a filter graph
   * output carries none of it unless it is written back explicitly.
   */
  audioMeta: AudioTrackMeta[];
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Already clamped to [MIN_FPS, MAX_FPS]; null when there is no video. */
  fps: number | null;
  /** Why ffprobe could not read the file at all (its stderr's last line). */
  probeError?: string;
  /** ffprobe was killed (timeout) — says nothing about the file itself. */
  probeTimedOut?: boolean;
}

interface AudioTrackMeta {
  language: string | null;
  isDefault: boolean;
}

async function probePart(filename: string): Promise<PartProbe> {
  return probeMediaAt(filename, null);
}

/** `probePart` of a file at an absolute path (`concatMediaPathsToTemp`); null = the stored `filename`. */
async function probeMediaAt(filename: string, abs: string | null): Promise<PartProbe> {
  const empty: PartProbe = {
    filename,
    hasVideo: false,
    audioTracks: 0,
    audioMeta: [],
    durationSec: null,
    width: null,
    height: null,
    fps: null,
  };
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries',
        'stream=codec_type,width,height,r_frame_rate,avg_frame_rate' +
          ':stream_disposition=attached_pic,default:stream_tags=language:format=duration',
        '-of', 'json',
        abs ?? resolveAudioPath(filename),
      ],
      { timeout: 30_000 }
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        avg_frame_rate?: string;
        disposition?: { attached_pic?: number; default?: number };
        tags?: { language?: string };
      }>;
      format?: { duration?: string };
    };
    const streams = parsed.streams ?? [];
    const video = streams.filter(
      (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
    );
    const audio = streams.filter((s) => s.codec_type === 'audio');
    const duration = Number(parsed.format?.duration ?? NaN);
    const first = video[0];
    return {
      filename,
      hasVideo: video.length > 0,
      audioTracks: audio.length,
      audioMeta: audio.map((s) => ({
        language: s.tags?.language?.trim() || null,
        isDefault: s.disposition?.default === 1,
      })),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: first?.width ?? null,
      height: first?.height ?? null,
      fps: first ? streamFps(first.avg_frame_rate, first.r_frame_rate) : null,
    };
  } catch (err) {
    const killed = !!err && typeof err === 'object' && 'killed' in err && !!err.killed;
    return { ...empty, probeError: probeFailure(err), probeTimedOut: killed };
  }
}

/** ffprobe's own complaint, one line ("moov atom not found"), else the error. */
function probeFailure(err: unknown): string {
  const stderr =
    err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : '';
  const lines = stderr
    .split('\n')
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter(Boolean);
  // The demuxer's line names the cause; the last line is usually the generic
  // "<path>: Invalid data found when processing input".
  const cause = lines.find((l) => !l.includes(': Invalid data found')) ?? lines[lines.length - 1];
  return (cause ?? String(err)).slice(0, 200);
}

/** ffprobe's `num/den` rate → a positive number, or null ("0/0", den 0, junk). */
function parseRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [num, den] = raw.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  const fps = n / d;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/**
 * The frame rate a video leg is resampled to. `avg_frame_rate` FIRST: tray
 * captures are variable-frame-rate (~5 fps on average, a frame only when the
 * window changes) and their `r_frame_rate` — ffprobe's guess at the lowest
 * rate that represents every timestamp — reads 60/1, 120/1, 240/1 or 299/12.
 * Feeding that to `fps=` duplicated every frame up to 240 fps and turned a
 * 1-hour re-encode on the VM from minutes into 35-60+ min, past the timeout,
 * and the recording was deleted (2026-09-30). Clamped to [1, 30]: nothing a
 * transcript page shows needs more, and a bogus rate can never blow up again.
 */
function streamFps(avg: string | undefined, r: string | undefined): number {
  const fps = parseRate(avg) ?? parseRate(r) ?? FALLBACK_FPS;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, fps));
}

/** What the mixed-part stitch normalises every leg to. */
const AUDIO_RATE = 48_000;
const FALLBACK_W = 1280;
const FALLBACK_H = 720;
/** A tray window capture's real average rate. */
const FALLBACK_FPS = 5;
const MIN_FPS = 1;
const MAX_FPS = 30;
/**
 * The VM has 4 vCPUs shared with every other app on it: the re-encode runs
 * niced and on 3 threads so a long stitch cannot starve the web server.
 * (`nice` execs ffmpeg in place, so the timeout's SIGTERM still reaches it.)
 */
const NICE = ['nice', '-n', '10'];
const THREADS = '3';
const REENCODE_TIMEOUT_MS = 60 * 60_000;

/** A shell-pasteable rendering of an argv, for the log line only. */
function shellQuote(args: string[]): string {
  return args
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))
    .join(' ');
}

/** Why an ffmpeg run failed, in one line: timeout, signal or stderr tail. */
function ffmpegFailure(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { killed?: boolean; signal?: string | null; stderr?: unknown };
    if (e.killed) {
      return `timed out after ${REENCODE_TIMEOUT_MS / 60_000} min${e.signal ? ` (${e.signal})` : ''}`;
    }
    const stderr = e.stderr ? String(e.stderr).trim().slice(-500) : '';
    if (stderr) return stderr;
  }
  return String(err);
}

/**
 * Re-encode concat for inputs the stream-copy demuxer can't join (mixed
 * containers/codecs — the normal case for user-uploaded files from different
 * devices, and for a Darth Recorder group that gained a video source
 * mid-call). ANY video input → h264+aac mp4; audio-only inputs → m4a.
 *
 * What this path has to get right, all learned the hard way:
 *
 *  - **Mixed parts keep the picture.** `part1.m4a · part2.mp4 · part3.m4a ·
 *    part4.mp4` used to be judged by `allVideo`, so one audio-only part made
 *    the whole output audio-only: ffmpeg exited 0, the log said the usual
 *    "re-encoded — mixed codecs", and the window the person deliberately
 *    added was silently discarded (found 2026-09-22). Now the audio-only
 *    spans get BLACK video synthesised at the first video part's geometry so
 *    the timeline still lines up with the audio.
 *  - **Every audio track survives, in order, WITH its label.** The old graph
 *    mapped `[i:a:0]` only, which threw away the mic track of any file whose
 *    mix is not track 0. Track 0 of each part stays track 0 of the output —
 *    `normalizeMultiTrack` and `tracks.mixFirst` both depend on that — and a
 *    part with fewer tracks than the widest one is padded with silence rather
 *    than shortening the set. The filter graph's outputs carry no stream
 *    metadata, so each track's language tag (the tray's `qmx`/`mul`/`eng`)
 *    and default flag are written back from the probes; without the `qmx`
 *    tag `normalizeMultiTrack` stopped recognising the mix and amixed it
 *    with the raw tracks — every voice summed twice (2026-09-30).
 *  - **The frame rate is the real one** (`streamFps`), not the 240 fps a VFR
 *    capture's `r_frame_rate` claims.
 *  - **The transcript beats the picture.** This runs inside the last part's
 *    upload request, and a failure there deletes the recording. So when the
 *    video re-encode fails (error or timeout) the same graph runs again with
 *    no video at all, into an m4a — exactly what an audio-only group produces
 *    — and the meeting is at least transcribed.
 *
 * Slow by design (real transcode); callers should try concatMediaToTemp
 * first. Use concatMediaSmart for the try-fast-then-fall-back pair.
 */
export async function concatMediaReencodeToTemp(
  filenames: string[],
  opts: ConcatOpts = {}
): Promise<string> {
  const workspace = await openWorkspace(opts.scratchId);
  const n = filenames.length;
  const probes = await Promise.all(filenames.map(probePart));
  const anyVideo = probes.some((p) => p.hasVideo);
  const allVideo = probes.every((p) => p.hasVideo);

  // Black video can only be synthesised for a span whose length we know. A
  // part with an unreadable duration is the one case where the picture still
  // has to go — say so loudly instead of letting it vanish into the old
  // "(re-encoded — mixed codecs)" line.
  const unmeasured = probes.filter((p) => !p.hasVideo && p.durationSec == null);
  if (anyVideo && !allVideo && unmeasured.length > 0) {
    console.warn(
      `[concat] cannot read the duration of ${unmeasured.map((p) => p.filename).join(', ')} — ` +
        'stitching audio only; the video parts lose their picture'
    );
  }
  const videoOut = anyVideo && (allVideo || unmeasured.length === 0);

  // Widest track count wins; a part with fewer gets silence for the missing
  // ones. Same duration caveat as the black video above.
  const maxTracks = probes.reduce((m, p) => Math.max(m, p.audioTracks), 0);
  const minTracks = probes.reduce((m, p) => Math.min(m, p.audioTracks), maxTracks);
  const unpaddable = probes.some((p) => p.audioTracks < maxTracks && p.durationSec == null);
  const tracks = unpaddable ? minTracks : maxTracks;
  if (unpaddable && minTracks < maxTracks) {
    console.warn(
      `[concat] a part with fewer than ${maxTracks} audio tracks has no readable duration — ` +
        `stitching ${tracks} track(s)`
    );
  }
  if (!videoOut && tracks === 0) {
    await dropScratchDir(workspace.scratch);
    throw new Error('ffmpeg re-encode concat failed: no usable audio or video streams in the parts');
  }

  const geo = probes.find((p) => p.hasVideo && p.width && p.height);
  const W = geo?.width ?? FALLBACK_W;
  const H = geo?.height ?? FALLBACK_H;
  // ONE rate for the whole graph (the concat filter needs the legs to agree):
  // the fastest part's real average, each already clamped to MAX_FPS. The max
  // rather than the first part's, so a 30 fps camera part after a 5 fps
  // window capture is not decimated to a slideshow; the clamp is what keeps
  // the duplication of the slower parts cheap.
  const fastest = probes.reduce((m, p) => (p.hasVideo && p.fps != null ? Math.max(m, p.fps) : m), 0);
  const FPS = Math.round((fastest || FALLBACK_FPS) * 1000) / 1000;

  // Each output track's label and default flag, from the FIRST part that has
  // that track. Exactly one track is default: the first one the source marked
  // so (track 0, the mix, on a tray file), else track 0. Raw tracks are never
  // left enabled — AVFoundation plays every enabled audio track at once
  // (`keepOnlyMixEnabled`, lib/server/multitrack.ts).
  const trackMeta: AudioTrackMeta[] = Array.from({ length: tracks }, (_, t) => {
    const owner = probes.find((p) => p.audioMeta.length > t);
    return owner?.audioMeta[t] ?? { language: null, isDefault: false };
  });
  const defaultTrack = Math.max(0, trackMeta.findIndex((m) => m.isDefault));
  const audioMetaArgs = trackMeta.flatMap((m, t) => [
    ...(m.language ? [`-metadata:s:a:${t}`, `language=${m.language}`] : []),
    `-disposition:a:${t}`,
    t === defaultTrack ? 'default' : '0',
  ]);

  if (videoOut && !allVideo) {
    const silentParts = probes.filter((p) => !p.hasVideo).length;
    console.log(
      `[concat] mixed parts: ${silentParts} audio-only, ${n - silentParts} video — ` +
        'black video synthesised for the audio-only span(s)'
    );
  }

  /** The full ffmpeg argv (after `nice`) for one attempt, with or without video. */
  const ffmpegArgs = (withVideo: boolean, outAbs: string): string[] => {
    // Real files first, then the lavfi generators, so a file's input index is
    // simply its position in `filenames`.
    const inputs: string[] = probes.flatMap((p) => ['-i', resolveAudioPath(p.filename)]);
    let nextIdx = n;
    const blackIdx = new Map<number, number>();
    const silenceIdx = new Map<string, number>();
    probes.forEach((p, i) => {
      const dur = (p.durationSec ?? 0).toFixed(3);
      if (withVideo && !p.hasVideo) {
        inputs.push('-f', 'lavfi', '-t', dur, '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
        blackIdx.set(i, nextIdx++);
      }
      for (let t = p.audioTracks; t < tracks; t++) {
        inputs.push(
          '-f', 'lavfi',
          '-t', dur,
          '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`
        );
        silenceIdx.set(`${i}:${t}`, nextIdx++);
      }
    });

    // Every leg normalised to one size/SAR/fps and one sample rate/layout —
    // the concat filter refuses segments whose streams disagree.
    const vTail = `fps=${FPS},format=yuv420p${opts.breakVideoForTest ? ',no_such_filter' : ''}`;
    const chains: string[] = [];
    const segments: string[] = [];
    probes.forEach((p, i) => {
      if (withVideo) {
        chains.push(
          p.hasVideo
            ? `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:-1:-1:color=black,setsar=1,${vTail}[v${i}]`
            : `[${blackIdx.get(i)}:v:0]setsar=1,${vTail}[v${i}]`
        );
        segments.push(`[v${i}]`);
      }
      for (let t = 0; t < tracks; t++) {
        const src = t < p.audioTracks ? `[${i}:a:${t}]` : `[${silenceIdx.get(`${i}:${t}`)}:a:0]`;
        chains.push(
          `${src}aresample=${AUDIO_RATE},aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo[a${i}_${t}]`
        );
        segments.push(`[a${i}_${t}]`);
      }
    });
    const outLabels =
      (withVideo ? '[cv]' : '') + Array.from({ length: tracks }, (_, t) => `[ca${t}]`).join('');
    const filter =
      chains.join(';') +
      ';' +
      segments.join('') +
      `concat=n=${n}:v=${withVideo ? 1 : 0}:a=${tracks}${outLabels}`;
    const maps = [
      ...(withVideo ? ['-map', '[cv]'] : []),
      ...Array.from({ length: tracks }, (_, t) => ['-map', `[ca${t}]`]).flat(),
    ];
    const codecs = [
      ...(withVideo
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
        : []),
      ...(tracks > 0 ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    ];
    return [
      'ffmpeg',
      '-hide_banner',
      '-loglevel', 'error',
      '-filter_complex_threads', THREADS,
      ...inputs,
      '-filter_complex', filter,
      ...maps,
      ...codecs,
      ...audioMetaArgs,
      '-threads', THREADS,
      '-movflags', '+faststart',
      '-y',
      outAbs,
    ];
  };

  /** One attempt; resolves to the output's name in the workspace. */
  const attempt = async (withVideo: boolean): Promise<string> => {
    const outName = `concat-${randomUUID()}.${withVideo ? 'mp4' : 'm4a'}`;
    const outAbs = path.join(workspace.dir, outName);
    const argv = [...NICE, ...ffmpegArgs(withVideo, outAbs)];
    console.log(`[media-concat] re-encode: ${shellQuote(argv)}`);
    try {
      await execFileP(argv[0]!, argv.slice(1), {
        timeout: REENCODE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      return outName;
    } catch (err) {
      await fsp.unlink(outAbs).catch(() => {});
      throw err;
    }
  };

  try {
    let outName: string;
    try {
      outName = await attempt(videoOut);
    } catch (err) {
      if (!videoOut || tracks === 0) throw err;
      console.warn(
        `[media-concat] video re-encode failed, retrying audio-only: ${ffmpegFailure(err)}`
      );
      outName = await attempt(false);
    }
    await landOutput(workspace, outName);
    return outName;
  } catch (err) {
    throw new Error(`ffmpeg re-encode concat failed: ${ffmpegFailure(err)}`);
  } finally {
    await dropScratchDir(workspace.scratch);
  }
}

async function probeStreamSignature(filename: string): Promise<string> {
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries',
        'stream=codec_type,codec_name,profile,level,pix_fmt,width,height,sample_rate',
        '-of', 'json',
        resolveAudioPath(filename),
      ],
      { timeout: 30_000 }
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        profile?: string;
        level?: number;
        pix_fmt?: string;
        width?: number;
        height?: number;
        sample_rate?: string;
      }>;
    };
    // Profile/level/pix_fmt too: two same-size H.264 parts with different
    // encoder params would otherwise take the `-c copy` path and produce a
    // file that decodes wrong from the second part on.
    return (parsed.streams ?? [])
      .map(
        (s) =>
          `${s.codec_type}:${s.codec_name}:${s.profile ?? ''}:${s.level ?? ''}:${s.pix_fmt ?? ''}:` +
          `${s.width ?? ''}x${s.height ?? ''}:${s.sample_rate ?? ''}`
      )
      .sort()
      .join('|');
  } catch {
    return `unreadable:${filename}`;
  }
}

/**
 * Stitch N media files: fast stream-copy when the inputs verifiably share
 * codec signatures (Meet segments), re-encode otherwise (user uploads from
 * different devices). ffmpeg's concat demuxer does NOT reliably error on
 * mixed inputs — it can exit 0 with garbage timestamps — so compatibility is
 * decided by probing up front, and the stream-copy output's duration is
 * verified against the summed inputs before being trusted.
 */
export async function concatMediaSmart(
  filenames: string[],
  opts: ConcatOpts = {}
): Promise<SmartConcatResult> {
  const { readable, skipped } = await dropUnreadableParts(filenames);
  if (readable.length === 0) {
    throw new Error('ffmpeg re-encode concat failed: no usable audio or video streams in the parts');
  }
  // One readable part left takes the same road a 1-part group always has: a
  // uniform signature → `concatMediaToTemp`, a stream-copy remux into a NEW
  // file (the callers delete every part's temp file after the stitch, so the
  // part itself can never be the result).
  return { ...(await concatReadable(readable, opts)), skipped };
}

/** A part the stitch left out, and why. */
export interface SkippedPart {
  /** 0-based position in the `filenames` given to `concatMediaSmart`. */
  index: number;
  name: string;
  bytes: number | null;
  reason: string;
}

export interface SmartConcatResult {
  filename: string;
  reencoded: boolean;
  /** Parts that could not be read at all and are NOT in the output. */
  skipped: SkippedPart[];
}

/**
 * A caller's stitch map (`uploadedParts`, one entry per input in the same
 * order) with the skipped parts marked — "segment 2 unreadable (9 MB) —
 * skipped" — which is what the recording card's Segments list, the notes
 * prompt and the part's `recording_media.source_ref` carry. The segment
 * number is the entry's own (1-based) `index`, the one the person knows.
 */
export function withSkippedNotes<T extends { index: number }>(
  entries: T[],
  skipped: SkippedPart[]
): Array<T & { skipped?: string }> {
  const byPosition = new Map(skipped.map((s) => [s.index, s]));
  return entries.map((e, i) => {
    const s = byPosition.get(i);
    return s ? { ...e, skipped: `segment ${e.index} unreadable (${formatBytes(s.bytes)}) — skipped` } : e;
  });
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'size unknown';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Drop the parts nothing can be read from — no duration AND no audio or
 * video stream — instead of failing the whole group on them.
 *
 * The case (2026-10-01, Ivan's recording 862a1066): the tray died 35 s into a
 * segment roll and uploaded part 2 as an UNFINISHED MP4 — the `moov` atom
 * (the index AVAssetWriter writes last) was never written. ffprobe says
 * "moov atom not found"; the stitch collapsed to "0 tracks", threw, the
 * caller deleted the upload, and the tray re-sent all 258 MB every 30 min
 * while a perfectly good 20-minute part 1 was never transcribed.
 *
 * No salvage attempt: without the moov there is no sample table, so neither
 * `ffprobe -err_detect ignore_err` nor an `ffmpeg -c copy` remux can open the
 * file (both verified to fail with "moov atom not found"). The real fix is on
 * the tray side (fragmented MP4).
 */
async function dropUnreadableParts(
  filenames: string[]
): Promise<{ readable: string[]; skipped: SkippedPart[] }> {
  const probes = await Promise.all(filenames.map(probePart));
  const readable: string[] = [];
  const skipped: SkippedPart[] = [];
  for (const [index, p] of probes.entries()) {
    // A probe that timed out (a loaded VM, a huge file) proves nothing about
    // the bytes — never drop a part for it; the stitch gets it as before.
    if (p.hasVideo || p.audioTracks > 0 || p.durationSec != null || p.probeTimedOut) {
      readable.push(p.filename);
      continue;
    }
    const bytes = await fsp
      .stat(resolveAudioPath(p.filename))
      .then((s) => s.size)
      .catch(() => null);
    const reason = p.probeError ?? 'no audio or video stream';
    console.warn(
      `[media-concat] part ${p.filename} (${bytes ?? '?'} B) is unreadable (${reason}) — skipped`
    );
    skipped.push({ index, name: p.filename, bytes, reason });
  }
  return { readable, skipped };
}

/** The stitch proper, over parts already known to be readable. */
async function concatReadable(
  filenames: string[],
  opts: ConcatOpts
): Promise<{ filename: string; reencoded: boolean }> {
  const signatures = await Promise.all(filenames.map(probeStreamSignature));
  const uniform = signatures.every((s) => s === signatures[0] && !s.startsWith('unreadable'));
  if (uniform) {
    try {
      const out = await concatMediaToTemp(filenames, opts);
      const durations = await Promise.all(filenames.map(probeDurationSec));
      const expected = durations.reduce<number>((s, d) => s + (d ?? 0), 0);
      const actual = await probeDurationSec(out);
      const tolerance = Math.max(2, expected * 0.05);
      if (expected > 0 && actual != null && Math.abs(actual - expected) <= tolerance) {
        return { filename: out, reencoded: false };
      }
      console.warn(
        `[media-concat] stream-copy duration mismatch (expected ~${Math.round(expected)}s, got ${actual == null ? 'unreadable' : Math.round(actual) + 's'}) — re-encoding`
      );
      await fsp.unlink(resolveAudioPath(out)).catch(() => {});
    } catch (err) {
      console.warn('[media-concat] stream-copy failed, falling back to re-encode:', err);
    }
  }
  return { filename: await concatMediaReencodeToTemp(filenames, opts), reencoded: true };
}
