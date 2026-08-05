import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStorageDir, resolveAudioPath } from '@/lib/server/audio-storage';

const execFileP = promisify(execFile);

/**
 * Frame extraction from stored meeting videos (ffmpeg/ffprobe, both present
 * on the VM and dev laptops). Frames are cached on disk under
 * `${MW_STORAGE_DIR}/frames/<assemblyaiId>/<ms>.jpg` so repeat requests
 * (notes agent + the serving route + regenerations) never re-decode.
 */

const FRAME_WIDTH = 960; // ~700 tokens/frame for the model; plenty for slides
const EXEC_OPTS = { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 } as const;

/** File extensions that can plausibly carry a video stream. */
export function looksLikeVideo(filename: string | null | undefined): boolean {
  if (!filename) return false;
  return /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(filename);
}

const videoStreamCache = new Map<string, boolean>();

/** ffprobe: does this stored file actually contain a video stream? */
export async function hasVideoStream(audioFilename: string): Promise<boolean> {
  const cached = videoStreamCache.get(audioFilename);
  if (cached !== undefined) return cached;
  if (!looksLikeVideo(audioFilename)) {
    videoStreamCache.set(audioFilename, false);
    return false;
  }
  try {
    const abs = resolveAudioPath(audioFilename);
    const { stdout } = await execFileP(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', abs],
      EXEC_OPTS
    );
    const has = stdout.trim().startsWith('video');
    videoStreamCache.set(audioFilename, has);
    return has;
  } catch {
    videoStreamCache.set(audioFilename, false);
    return false;
  }
}

export function frameDir(assemblyaiId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(assemblyaiId)) {
    throw new Error(`Refusing unsafe id for frame dir: ${assemblyaiId}`);
  }
  return path.join(getStorageDir(), 'frames', assemblyaiId);
}

export function framePath(assemblyaiId: string, ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  return path.join(frameDir(assemblyaiId), `${safeMs}.jpg`);
}

/**
 * Extract (or reuse a cached) frame at `ms` into the frame cache dir.
 * Returns the absolute path of the jpeg. Throws if ffmpeg fails (no video
 * stream, timestamp past EOF, …).
 */
export async function extractFrame(
  assemblyaiId: string,
  audioFilename: string,
  ms: number
): Promise<string> {
  const out = framePath(assemblyaiId, ms);
  try {
    await fsp.access(out);
    return out; // cached
  } catch {
    /* extract below */
  }
  await fsp.mkdir(frameDir(assemblyaiId), { recursive: true });
  const src = resolveAudioPath(audioFilename);
  const ts = (Math.max(0, Math.floor(ms)) / 1000).toFixed(3);
  // -ss before -i = fast keyframe seek; decode starts near the target
  // rather than from byte zero. scale to a fixed width, -2 keeps aspect.
  await execFileP(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-ss', ts, '-i', src, '-frames:v', '1', '-vf', `scale=${FRAME_WIDTH}:-2`, '-q:v', '4', out],
    EXEC_OPTS
  );
  // ffmpeg exits 0 even when seeking past EOF produces nothing — verify.
  const st = await fsp.stat(out).catch(() => null);
  if (!st || st.size === 0) {
    await fsp.unlink(out).catch(() => {});
    throw new Error(`no frame at ${ms}ms (past end of video?)`);
  }
  return out;
}
