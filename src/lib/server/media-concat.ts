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
