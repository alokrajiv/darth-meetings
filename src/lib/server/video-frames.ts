import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStorageDir, resolveAudioPath } from '@/lib/server/audio-storage';
import { canonicalMedia, localMsIn, type ResolvedMedia } from '@/lib/server/recordings';

const execFileP = promisify(execFile);

/**
 * Frame extraction from stored meeting videos (ffmpeg/ffprobe, both present
 * on the VM and dev laptops). Frames are cached on disk under
 * `${MW_STORAGE_DIR}/frames/<assemblyaiId>/<ms>.jpg` so repeat requests
 * (notes agent + the serving route + regenerations) never re-decode.
 */

/**
 * Which of a meeting's files a frame at a MEETING-time offset is taken from.
 *
 * Always the canonical one, whatever the timestamp — the same "frames read the
 * primary file only" rule the app has always had (design §4, landmine #15).
 * Every `frame:<ms>` already written into a summary or report means "ms into
 * this meeting", so picking a stop-restart part by its offset here would
 * silently re-point existing citations at a different image.
 */
export function frameSourceFor(media: ResolvedMedia[]): ResolvedMedia | null {
  return canonicalMedia(media);
}

/**
 * THE meeting-ms → (file, file-ms) seam (landmine #15, closed in Phase 3a).
 *
 * A meeting split off a longer recording plays a WINDOW of the same file, so
 * its `frame:<ms>` citations — which are meeting-relative, and must stay that
 * way for the notes to keep working — are `windowFromMs + ms` into the file.
 * `localMsIn` is the one arithmetic that says so, and every frame grab goes
 * through here: the route, the notes agent's `grab_frames` tool, and the
 * pre-warm that follows a generated report.
 *
 * Null when nothing playable is stored.
 */
export function frameRequestFor(
  media: ResolvedMedia[],
  meetingMs: number
): { source: ResolvedMedia; fileMs: number } | null {
  const source = frameSourceFor(media);
  if (!source) return null;
  return { source, fileMs: localMsIn(source, meetingMs) };
}

const FRAME_WIDTH = 960; // ~700 tokens/frame for the model; plenty for slides
const EXEC_OPTS = { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 } as const;

/** Extensions that can only ever carry audio — skip the probe for these.
 * Anything else (including the `.bin` fallback for extension-less Drive
 * names) gets ffprobed: extension is a hint here, never the verdict. */
const AUDIO_ONLY_EXT = /\.(m4a|mp3|wav|aac|flac|ogg|oga|opus|wma|amr)$/i;

const videoStreamCache = new Map<string, boolean>();

/** ffprobe: does this stored file actually contain a video stream? */
export async function hasVideoStream(audioFilename: string): Promise<boolean> {
  const cached = videoStreamCache.get(audioFilename);
  if (cached !== undefined) return cached;
  if (AUDIO_ONLY_EXT.test(audioFilename)) {
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

/**
 * Sniff a stored file's container with ffprobe and suggest a filename
 * extension. Used at store time when the original name gives none — Drive
 * names Meet recordings without an extension, and both playback Content-Type
 * and the client's "is this a video?" checks key off the stored extension.
 */
export async function sniffMediaExtension(filename: string): Promise<string | null> {
  try {
    const abs = resolveAudioPath(filename);
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_type:format=format_name',
        '-of', 'default=noprint_wrappers=1',
        abs,
      ],
      EXEC_OPTS
    );
    const fmt = (stdout.match(/^format_name=(.*)$/m)?.[1] ?? '').toLowerCase();
    const hasVideo = /^codec_type=video$/m.test(stdout);
    if (fmt.includes('mp4')) return hasVideo ? '.mp4' : '.m4a';
    if (fmt.includes('webm') || fmt.includes('matroska')) return hasVideo ? '.webm' : '.mka';
    if (fmt.includes('mp3')) return '.mp3';
    if (fmt.includes('wav')) return '.wav';
    if (fmt.includes('ogg')) return '.ogg';
    if (fmt.includes('flac')) return '.flac';
    if (fmt.includes('aac')) return '.aac';
    return null;
  } catch {
    return null;
  }
}

export function frameDir(assemblyaiId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(assemblyaiId)) {
    throw new Error(`Refusing unsafe id for frame dir: ${assemblyaiId}`);
  }
  return path.join(getStorageDir(), 'frames', assemblyaiId);
}

export function framePath(assemblyaiId: string, ms: number, width: number = FRAME_WIDTH): string {
  const safeMs = Math.max(0, Math.floor(ms));
  // The default width keeps its historical name — it is what `frame:<ms>`
  // citations are served from. Other widths (the speaker-ID pass reading
  // name tiles at 1600 px) are cached beside it.
  const suffix = width === FRAME_WIDTH ? '' : `-w${Math.floor(width)}`;
  return path.join(frameDir(assemblyaiId), `${safeMs}${suffix}.jpg`);
}

/** Width for reading small text in a frame (call name tiles): ~2k vision tokens. */
export const HIRES_FRAME_WIDTH = 1600;

/**
 * Extract (or reuse a cached) frame into the frame cache dir.
 * Returns the absolute path of the jpeg. Throws if ffmpeg fails (no video
 * stream, timestamp past EOF, …).
 *
 * `fileMs` is an offset into the FILE (what ffmpeg seeks to); `cacheMs` is the
 * MEETING-time offset the citation used, and is what the cache is keyed by —
 * two meetings clipping one recording each keep their own cache under their
 * own id, at the ms their own notes name. Callers get both from
 * `frameRequestFor`; they are equal for every meeting that was never split.
 */
export async function extractFrame(
  assemblyaiId: string,
  audioFilename: string,
  fileMs: number,
  cacheMs: number = fileMs,
  width: number = FRAME_WIDTH
): Promise<string> {
  const ms = fileMs;
  const out = framePath(assemblyaiId, cacheMs, width);
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
    ['-y', '-loglevel', 'error', '-ss', ts, '-i', src, '-frames:v', '1', '-vf', `scale=${Math.floor(width)}:-2`, '-q:v', '4', out],
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
