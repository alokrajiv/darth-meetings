import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensureAudioDir, getAudioDir, resolveAudioPath } from '@/lib/server/audio-storage';

const execFileP = promisify(execFile);

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
export async function concatMediaToTemp(filenames: string[]): Promise<string> {
  await ensureAudioDir();
  const listPath = path.join(getAudioDir(), `concat-${randomUUID()}.txt`);
  const outName = `concat-${randomUUID()}.mp4`;
  const outAbs = resolveAudioPath(outName);
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
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y',
        outAbs,
      ],
      { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }
    );
    return outName;
  } catch (err) {
    await fsp.unlink(outAbs).catch(() => {});
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).slice(-500) : '';
    throw new Error(`ffmpeg concat failed${stderr ? `: ${stderr}` : `: ${String(err)}`}`);
  } finally {
    await fsp.unlink(listPath).catch(() => {});
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

async function hasVideo(filename: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0',
        resolveAudioPath(filename),
      ],
      { timeout: 30_000 }
    );
    return stdout.trim().startsWith('video');
  } catch {
    return false;
  }
}

/**
 * Re-encode concat for inputs the stream-copy demuxer can't join (mixed
 * containers/codecs — the normal case for user-uploaded files from different
 * devices). All-video inputs → h264+aac mp4; anything else → audio-only m4a.
 * Slow by design (real transcode); callers should try concatMediaToTemp
 * first. Use concatMediaSmart for the try-fast-then-fall-back pair.
 */
export async function concatMediaReencodeToTemp(filenames: string[]): Promise<string> {
  await ensureAudioDir();
  const n = filenames.length;
  const allVideo = (await Promise.all(filenames.map(hasVideo))).every(Boolean);
  const outName = allVideo ? `concat-${randomUUID()}.mp4` : `concat-${randomUUID()}.m4a`;
  const outAbs = resolveAudioPath(outName);
  const inputs = filenames.flatMap((f) => ['-i', resolveAudioPath(f)]);
  const filter = allVideo
    ? filenames.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('') + `concat=n=${n}:v=1:a=1[v][a]`
    : filenames.map((_, i) => `[${i}:a:0]`).join('') + `concat=n=${n}:v=0:a=1[a]`;
  const maps = allVideo ? ['-map', '[v]', '-map', '[a]'] : ['-map', '[a]'];
  const codecs = allVideo
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k']
    : ['-c:a', 'aac', '-b:a', '128k'];
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
    return outName;
  } catch (err) {
    await fsp.unlink(outAbs).catch(() => {});
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).slice(-500) : '';
    throw new Error(`ffmpeg re-encode concat failed${stderr ? `: ${stderr}` : `: ${String(err)}`}`);
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
  filenames: string[]
): Promise<{ filename: string; reencoded: boolean }> {
  const signatures = await Promise.all(filenames.map(probeStreamSignature));
  const uniform = signatures.every((s) => s === signatures[0] && !s.startsWith('unreadable'));
  if (uniform) {
    try {
      const out = await concatMediaToTemp(filenames);
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
  return { filename: await concatMediaReencodeToTemp(filenames), reencoded: true };
}
