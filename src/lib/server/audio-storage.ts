import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * Local audio storage on the server filesystem.
 *
 * AssemblyAI deletes uploaded audio immediately after transcription completes
 * (verified empirically + per their docs), so the `audio_url` they return is
 * useless for playback. To support the synced audio player we keep our own
 * copy of every uploaded file under `${MW_STORAGE_DIR}/audio/` and serve it
 * through `/api/transcripts/[id]/audio`. The DB stores **just the filename**
 * (relative to the audio dir) so changing MW_STORAGE_DIR doesn't break old
 * rows.
 */

const DEFAULT_STORAGE_DIR = './storage';

export function getStorageDir(): string {
  const raw = process.env.MW_STORAGE_DIR || DEFAULT_STORAGE_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export function getAudioDir(): string {
  return path.join(getStorageDir(), 'audio');
}

/**
 * Compute the storage filename for a given transcript. Uses the original
 * file extension if we can recover one (so the Content-Type derived from the
 * extension is correct), otherwise falls back to `.bin`.
 */
export function audioFilename(
  assemblyaiId: string,
  originalFilename: string | null
): string {
  let ext = '';
  if (originalFilename) {
    const dotIdx = originalFilename.lastIndexOf('.');
    if (dotIdx > 0 && dotIdx < originalFilename.length - 1) {
      ext = originalFilename.substring(dotIdx).toLowerCase();
    }
  }
  // Sanitise the extension to avoid path traversal / weird chars.
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) {
    ext = '.bin';
  }
  return `${assemblyaiId}${ext}`;
}

/** Resolve the absolute path of an audio file from its stored filename. */
export function resolveAudioPath(filename: string): string {
  // Defensive: filenames in the DB should be plain — no slashes, no `..`.
  if (filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
    throw new Error(`Refusing unsafe audio filename: ${filename}`);
  }
  return path.join(getAudioDir(), filename);
}

export async function ensureAudioDir(): Promise<void> {
  await fsp.mkdir(getAudioDir(), { recursive: true });
}

export async function saveAudioBytes(filename: string, data: Buffer | Uint8Array): Promise<string> {
  await ensureAudioDir();
  const abs = resolveAudioPath(filename);
  await fsp.writeFile(abs, data);
  return abs;
}

export async function audioFileExists(filename: string): Promise<boolean> {
  try {
    const abs = resolveAudioPath(filename);
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function deleteAudioFile(filename: string): Promise<void> {
  try {
    const abs = resolveAudioPath(filename);
    await fsp.unlink(abs);
  } catch {
    // ignore — best-effort
  }
}
