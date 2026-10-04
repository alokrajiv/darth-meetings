import 'server-only';
import { audioFileSize } from '@/lib/server/audio-storage';
import { archivedStoredFiles, type ArchivedStoredFile } from '@/db-ops/media-readers';
import {
  localMediaSession,
  type LocalMedia,
  type LocalMediaWant,
  type LocalizableMedia,
} from '@/lib/server/media-local';

/**
 * Stored files once Stage D can remove the local copies
 * (docs/recordings-stage-d-spec.md "As built — readers").
 *
 * Two questions every reader of a STORED file (`storage/audio/<name>`) now
 * has to ask the right way:
 *
 *   1. "Do we hold these bytes?" — on this disk, OR archived: the file's
 *      canonical/part `recording_media` row carries `blob_name` AND `sha256`
 *      (what `stampMediaArchived` writes once Azure has confirmed them; the
 *      same definition as `aai-retention.ts mediaIsSafe`). A file that is
 *      merely absent from the disk is not "missing" any more.
 *   2. "Give me a readable path, and keep it readable while I work" — always
 *      through `ensureLocalMedia` / `localMediaSession`, whose handle holds a
 *      reference the eviction honours (`localMediaHeld`) until `release()`.
 *      A disk hit is held too; a pulled copy lives in the bounded media cache
 *      and is NEVER written back under `storage/audio/`.
 */

/** The slice of a media row the presence check reads. */
export interface ArchivableRow {
  filename: string | null;
  blob_name: string | null;
  sha256?: string | null;
}

/** Archived = a blob name AND the hash Azure confirmed. */
export function isArchivedMedia(row: ArchivableRow | null | undefined): boolean {
  return !!row?.blob_name && !!row.sha256;
}

/** One stored file: where its bytes are, and how to ask `ensureLocalMedia` for them. */
export interface StoredFileSource {
  filename: string;
  /** The local copy's size; null = not on this disk. */
  localBytes: number | null;
  /** The archived row, when the bytes are in the media container. */
  archived: ArchivedStoredFile | null;
  /** On disk or archived — what a "file missing" check must ask. */
  held: boolean;
  /** Size to announce (the local copy's, else the archived row's). */
  bytes: number | null;
  /** For `ensureLocalMedia(…, 'canonical')`. */
  media: LocalizableMedia;
}

/** The `LocalizableMedia` for a stored file and (when archived) its row. */
export function localizableStoredFile(
  filename: string,
  archived: Pick<ArchivedStoredFile, 'blob_name' | 'sha256' | 'has_video' | 'recording_id'> | null
): LocalizableMedia {
  return {
    filename,
    recordingId: archived?.recording_id ?? '',
    blobName: archived?.blob_name ?? null,
    sha256: archived?.sha256 ?? null,
    isVideo: archived?.has_video ?? null,
    audioOnly: null,
  };
}

/**
 * Where each of `filenames` can be had. One `stat` per file; the database is
 * asked once, and only about the files that are not on disk. A failed lookup
 * answers "not archived" (the old answer: missing) — never the other way.
 */
export async function storedFileSources(filenames: string[]): Promise<Map<string, StoredFileSource>> {
  const local = new Map<string, number | null>();
  for (const f of filenames) local.set(f, await audioFileSize(f));
  const missing = filenames.filter((f) => local.get(f) === null);
  const archived =
    missing.length > 0
      ? await archivedStoredFiles(missing).catch((err) => {
          console.warn('[stored-media] archive lookup failed — treating missing files as missing:', err);
          return new Map<string, ArchivedStoredFile>();
        })
      : new Map<string, ArchivedStoredFile>();
  const out = new Map<string, StoredFileSource>();
  for (const f of filenames) {
    const localBytes = local.get(f) ?? null;
    const a = localBytes === null ? (archived.get(f) ?? null) : null;
    out.set(f, {
      filename: f,
      localBytes,
      archived: a,
      held: localBytes !== null || isArchivedMedia(a),
      bytes: localBytes ?? a?.bytes ?? null,
      media: localizableStoredFile(f, a),
    });
  }
  return out;
}

/** `storedFileSources` for one file. */
export async function storedFileSource(filename: string): Promise<StoredFileSource> {
  return (await storedFileSources([filename])).get(filename)!;
}

/**
 * Run `fn` with readable local paths for `files` (same order), every one held
 * until `fn` settles — the eviction cannot take a file out from under an
 * ffmpeg / sidecar / upload that is still reading it. `null` when any of them
 * cannot be had (logged once by media-local); nothing is held then.
 *
 * `want` is `'canonical'` for the readers that need the stored file's exact
 * bytes (re-transcribe, re-ingest, combine): never the audio-only derivative.
 */
export async function withHeldStoredFiles<T>(
  files: LocalizableMedia[],
  want: LocalMediaWant,
  purpose: string,
  fn: (locals: LocalMedia[]) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  const session = localMediaSession(want, purpose);
  try {
    const locals: LocalMedia[] = [];
    for (const m of files) {
      const got = await session.get(m);
      if (!got) return { ok: false };
      locals.push(got);
    }
    return { ok: true, value: await fn(locals) };
  } finally {
    await session.releaseAll();
  }
}
