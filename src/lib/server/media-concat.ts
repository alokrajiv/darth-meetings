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
  const anyHasVideo = (await Promise.all(filenames.map(hasVideo))).some(Boolean);
  const outName = `concat-${randomUUID()}.${anyHasVideo ? 'mp4' : 'm4a'}`;
  const outAbs = path.join(workspace.dir, outName);
  // ffmpeg concat-demuxer list syntax: file 'path' — single quotes escaped.
  const list = filenames
    .map((f) => `file '${resolveAudioPath(f).replace(/'/g, "'\\''")}'`)
    .join('\n');
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
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

async function probePart(filename: string): Promise<PartProbe> {
  const empty: PartProbe = {
    filename,
    hasVideo: false,
    audioTracks: 0,
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
        '-show_entries', 'stream=codec_type,width,height,r_frame_rate:stream_disposition=attached_pic:format=duration',
        '-of', 'json',
        resolveAudioPath(filename),
      ],
      { timeout: 30_000 }
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        disposition?: { attached_pic?: number };
      }>;
      format?: { duration?: string };
    };
    const streams = parsed.streams ?? [];
    const video = streams.filter(
      (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
    );
    const duration = Number(parsed.format?.duration ?? NaN);
    const first = video[0];
    return {
      filename,
      hasVideo: video.length > 0,
      audioTracks: streams.filter((s) => s.codec_type === 'audio').length,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: first?.width ?? null,
      height: first?.height ?? null,
      fps: parseFps(first?.r_frame_rate),
    };
  } catch {
    return empty;
  }
}

/** ffprobe's `num/den` frame rate → a number, or null when it is unusable. */
function parseFps(raw: string | undefined): number | null {
  if (!raw) return null;
  const [num, den] = raw.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  const fps = n / d;
  return fps > 0 && fps <= 240 ? fps : null;
}

async function hasVideo(filename: string): Promise<boolean> {
  return (await probePart(filename)).hasVideo;
}

/** What the mixed-part stitch normalises every leg to. */
const AUDIO_RATE = 48_000;
const FALLBACK_W = 1280;
const FALLBACK_H = 720;
const FALLBACK_FPS = 30;

/**
 * Re-encode concat for inputs the stream-copy demuxer can't join (mixed
 * containers/codecs — the normal case for user-uploaded files from different
 * devices, and for a Darth Recorder group that gained a video source
 * mid-call). ANY video input → h264+aac mp4; audio-only inputs → m4a.
 *
 * Two things this path has to get right, both learned the hard way:
 *
 *  - **Mixed parts keep the picture.** `part1.m4a · part2.mp4 · part3.m4a ·
 *    part4.mp4` used to be judged by `allVideo`, so one audio-only part made
 *    the whole output audio-only: ffmpeg exited 0, the log said the usual
 *    "re-encoded — mixed codecs", and the window the person deliberately
 *    added was silently discarded (found 2026-09-22). Now the audio-only
 *    spans get BLACK video synthesised at the first video part's geometry so
 *    the timeline still lines up with the audio.
 *  - **Every audio track survives, in order.** The old graph mapped `[i:a:0]`
 *    only, which threw away the mic track of any file whose mix is not track
 *    0. Track 0 of each part stays track 0 of the output — `normalizeMultiTrack`
 *    and `tracks.mixFirst` both depend on that — and a part with fewer tracks
 *    than the widest one is padded with silence rather than shortening the set.
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
  const FPS = Math.round((geo?.fps ?? FALLBACK_FPS) * 1000) / 1000;

  if (videoOut && !allVideo) {
    const silentParts = probes.filter((p) => !p.hasVideo).length;
    console.log(
      `[concat] mixed parts: ${silentParts} audio-only, ${n - silentParts} video — ` +
        'black video synthesised for the audio-only span(s)'
    );
  }

  const outName = `concat-${randomUUID()}.${videoOut ? 'mp4' : 'm4a'}`;
  const outAbs = path.join(workspace.dir, outName);

  // Real files first, then the lavfi generators, so a file's input index is
  // simply its position in `filenames`.
  const inputs: string[] = probes.flatMap((p) => ['-i', resolveAudioPath(p.filename)]);
  let nextIdx = n;
  const blackIdx = new Map<number, number>();
  const silenceIdx = new Map<string, number>();
  probes.forEach((p, i) => {
    const dur = (p.durationSec ?? 0).toFixed(3);
    if (videoOut && !p.hasVideo) {
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
  const chains: string[] = [];
  const segments: string[] = [];
  probes.forEach((p, i) => {
    if (videoOut) {
      chains.push(
        p.hasVideo
          ? `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:-1:-1:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`
          : `[${blackIdx.get(i)}:v:0]setsar=1,fps=${FPS},format=yuv420p[v${i}]`
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
    (videoOut ? '[cv]' : '') + Array.from({ length: tracks }, (_, t) => `[ca${t}]`).join('');
  const filter =
    chains.join(';') +
    ';' +
    segments.join('') +
    `concat=n=${n}:v=${videoOut ? 1 : 0}:a=${tracks}${outLabels}`;
  const maps = [
    ...(videoOut ? ['-map', '[cv]'] : []),
    ...Array.from({ length: tracks }, (_, t) => ['-map', `[ca${t}]`]).flat(),
  ];
  const codecs = [
    ...(videoOut
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
      : []),
    ...(tracks > 0 ? ['-c:a', 'aac', '-b:a', '128k'] : []),
  ];
  try {
    await execFileP(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        ...inputs,
        '-filter_complex', filter,
        ...maps,
        ...codecs,
        '-movflags', '+faststart',
        '-y',
        outAbs,
      ],
      { timeout: 60 * 60_000, maxBuffer: 16 * 1024 * 1024 }
    );
    await landOutput(workspace, outName);
    return outName;
  } catch (err) {
    await fsp.unlink(outAbs).catch(() => {});
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).slice(-500) : '';
    throw new Error(`ffmpeg re-encode concat failed${stderr ? `: ${stderr}` : `: ${String(err)}`}`);
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
        '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate',
        '-of', 'json',
        resolveAudioPath(filename),
      ],
      { timeout: 30_000 }
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        sample_rate?: string;
      }>;
    };
    return (parsed.streams ?? [])
      .map((s) => `${s.codec_type}:${s.codec_name}:${s.width ?? ''}x${s.height ?? ''}:${s.sample_rate ?? ''}`)
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
