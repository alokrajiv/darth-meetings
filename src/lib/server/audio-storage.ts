import 'server-only';
import path from 'node:path';
import { createWriteStream, promises as fsp } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { createHash, randomUUID } from 'node:crypto';

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

/**
 * Stream an incoming request body straight to a temp file in the audio dir.
 * Constant memory regardless of file size — this is the upload path for
 * multi-GB recordings. The temp file lives in the audio dir itself so the
 * later rename to its final name is atomic (same filesystem).
 *
 * Returns the temp filename (relative, like all stored filenames) and the
 * byte count actually written.
 *
 * `opts.tempFilename` pins the temp name (the upload route derives it from
 * the placeholder row's uuid so the stale-upload sweeper can find the file);
 * `opts.onProgress` fires with the running byte count on every chunk — the
 * caller throttles.
 */
export async function saveAudioStreamToTemp(
  stream: ReadableStream<Uint8Array>,
  opts?: { tempFilename?: string; onProgress?: (bytes: number) => void }
): Promise<{ tempFilename: string; bytes: number }> {
  await ensureAudioDir();
  const tempFilename = opts?.tempFilename ?? `upload-${randomUUID()}.part`;
  const abs = resolveAudioPath(tempFilename);

  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      opts?.onProgress?.(bytes);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(stream as unknown as NodeWebReadableStream<Uint8Array>),
      counter,
      createWriteStream(abs)
    );
  } catch (error) {
    await deleteAudioFile(tempFilename);
    throw error;
  }

  return { tempFilename, bytes };
}

/**
 * Create the (empty) temp file a chunked upload session writes into. The
 * chunks arrive in parallel at byte offsets, so the file has to exist
 * before the first positional write. No-op when it already exists (a
 * resumed session keeps its bytes).
 */
export async function ensureTempFileExists(tempFilename: string): Promise<void> {
  await ensureAudioDir();
  const fh = await fsp.open(resolveAudioPath(tempFilename), 'a');
  await fh.close();
}

export async function audioFileSize(filename: string): Promise<number | null> {
  try {
    const st = await fsp.stat(resolveAudioPath(filename));
    return st.size;
  } catch {
    return null;
  }
}

/**
 * Write one chunk of a chunked upload at its byte offset (pwrite via a
 * positioned write stream — several chunks of the same file stream in
 * concurrently, each on its own fd). The body is counted and SHA-256'd as
 * it streams; the caller compares against the expected length / client
 * hash and simply lets a retry overwrite the same range on mismatch.
 * `flags: 'r+'` never truncates, and fails loudly when the temp file is
 * gone (session reaped) instead of silently recreating an empty one.
 */
export async function writeChunkAt(
  tempFilename: string,
  offset: number,
  stream: ReadableStream<Uint8Array>
): Promise<{ bytes: number; sha256: string }> {
  const abs = resolveAudioPath(tempFilename);
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(stream as unknown as NodeWebReadableStream<Uint8Array>),
    tap,
    createWriteStream(abs, { flags: 'r+', start: offset })
  );
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Copy a stored audio file to a fresh temp name. Lets a re-transcription
 * consume the copy via the normal temp→final rename while the source row
 * keeps its audio.
 */
export async function copyAudioToTemp(sourceFilename: string): Promise<string> {
  await ensureAudioDir();
  const tempFilename = `upload-${randomUUID()}.part`;
  await fsp.copyFile(resolveAudioPath(sourceFilename), resolveAudioPath(tempFilename));
  return tempFilename;
}

/** Rename a stored audio file (e.g. temp upload → final AAI-id-based name). */
export async function renameAudioFile(fromFilename: string, toFilename: string): Promise<string> {
  const from = resolveAudioPath(fromFilename);
  const to = resolveAudioPath(toFilename);
  await fsp.rename(from, to);
  return to;
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

/** Best-effort delete of every audio-dir file whose name starts with the
 * prefix — multi-part upload temps (`upload-<uuid>.part`, `.part2`, …). */
export async function deleteAudioFilesByPrefix(prefix: string): Promise<void> {
  if (!prefix || prefix.includes('/') || prefix.includes('..')) return;
  try {
    const entries = await fsp.readdir(getAudioDir());
    await Promise.all(
      entries.filter((f) => f.startsWith(prefix)).map((f) => deleteAudioFile(f))
    );
  } catch {
    // ignore — best-effort
  }
}
