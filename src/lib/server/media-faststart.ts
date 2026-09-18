import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { getAudioOnlyPath } from '@/lib/server/audio-only';
import { isIsoBmffName, scanFileLayout, type MoovLayout } from '@/lib/server/media-boxes';

/**
 * "Faststart" for stored ISO-BMFF recordings (mp4 / m4a / mov / m4v).
 *
 * Google Meet writes the `moov` atom (the index: sample tables, durations)
 * AFTER the `mdat` payload. A browser then has to fetch the head AND the
 * tail of a multi-hundred-MB file before the first frame, and every seek is
 * another round trip to the server — on a phone that is "press play, nothing
 * happens" (tech-debt A1, measured 2026-09-13: 11 of the 12 newest Meet
 * recordings were moov-last; Teams and our own extracts are index-first).
 *
 * `ffmpeg -c copy -movflags +faststart` rewrites the container with `moov`
 * first, no re-encode (3.6 s for a 64-min file on the VM). Whether a file
 * needs it is decided by the box walk in media-boxes.ts (a few positional
 * header reads, never a full `ffprobe -v trace`).
 */

const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000;


export type FaststartResult =
  /** The file was moov-last and has been rewritten in place. */
  | { status: 'remuxed'; ms: number }
  /** Already progressive (or header-only) — untouched. */
  | { status: 'already' }
  /** Not an ISO-BMFF file — nothing to do, untouched. */
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

/**
 * Make a stored recording progressive, in place, when it is not already:
 * `ffmpeg -map 0 -c copy -movflags +faststart` into `<file>.faststart.tmp`,
 * verified with the scanner, then renamed over the source (atomic on the
 * same filesystem — a reader mid-stream keeps the old inode). Every track
 * is mapped so multi-track Darth Recorder files keep their mic/system
 * tracks. `nice` runs ffmpeg at low priority (the backfill sweeper).
 *
 * The audio-only derivative (audio-only.ts) is mtime-compared with its
 * source; a stream copy does not change the content, so the derivative is
 * touched afterwards to keep it "fresh" instead of forcing a rebuild.
 */
export async function ensureFaststart(
  storedFilename: string,
  opts?: { nice?: boolean }
): Promise<FaststartResult> {
  let src: string;
  try {
    src = resolveAudioPath(storedFilename);
  } catch (e) {
    return { status: 'skipped', reason: e instanceof Error ? e.message : String(e) };
  }
  if (!isIsoBmffName(storedFilename)) {
    return { status: 'skipped', reason: 'not an ISO-BMFF container' };
  }
  let layout: MoovLayout;
  try {
    layout = await scanFileLayout(src);
  } catch (e) {
    return { status: 'error', error: `scan failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (layout === 'moov-first' || layout === 'no-mdat') return { status: 'already' };
  if (layout === 'not-isobmff') {
    return { status: 'skipped', reason: 'box walk did not parse as ISO-BMFF' };
  }

  const tmp = `${src}.faststart.tmp`;
  const started = Date.now();
  try {
    await remux(src, tmp, path.extname(storedFilename).toLowerCase() === '.mov' ? 'mov' : 'mp4', !!opts?.nice);
    const check = await scanFileLayout(tmp);
    if (check !== 'moov-first') {
      throw new Error(`remux output is ${check}, expected moov-first`);
    }
    await fsp.rename(tmp, src);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  // Keep an existing derivative newer than its (unchanged-content) source.
  try {
    const derivative = getAudioOnlyPath(storedFilename);
    const st = await fsp.stat(derivative).catch(() => null);
    if (st && st.size > 0) {
      const now = new Date();
      await fsp.utimes(derivative, now, now);
    }
  } catch {
    // best-effort
  }
  return { status: 'remuxed', ms: Date.now() - started };
}

async function remux(src: string, out: string, format: 'mp4' | 'mov', nice: boolean): Promise<void> {
  await fsp.unlink(out).catch(() => {});
  const ffmpegArgs = [
    '-y', '-loglevel', 'error',
    '-i', src,
    '-map', '0',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', format,
    out,
  ];
  const [cmd, args] = nice ? ['nice', ['-n', '15', 'ffmpeg', ...ffmpegArgs]] : ['ffmpeg', ffmpegArgs];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
      reject(new Error(`${cmd} could not start: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 60000} min`));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? signal}: ${stderr.trim() || 'no stderr'}`));
    });
  });
  const st = await fsp.stat(out).catch(() => null);
  if (!st || st.size === 0) throw new Error('ffmpeg produced an empty file');
}
