import 'server-only';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import { Writable } from 'node:stream';
import { getStorageDir, resolveAudioPath } from '@/lib/server/audio-storage';
import { mediaStore, type MediaBlobLike } from '@/lib/server/media-store';
import { redactSasInText } from '@/lib/server/media-serve';
import { scratchRoot } from '@/lib/server/scratch-dir';

/**
 * A READABLE LOCAL FILE for a meeting's media, for the work that cannot read
 * a blob: ffmpeg in the voiceprint sidecar (`/embed`, `/embed-batch`,
 * `/align`) and the frame grabs (`video-frames.ts`).
 *
 * Why this exists: the archive (DEC-3, `media-archive.ts`) puts every file in
 * the permanent media container, and with `MW_MEDIA_FROM_BLOB` playback and
 * ingest stopped needing the copy under `${MW_STORAGE_DIR}/audio/` — so that
 * copy can be gone (purged, a blue/green slot that never had it, a Stage C
 * local copy that never landed). The player proxies the blob, ingest pulls
 * it; the voiceprint pass was handed `storage/audio/<id>.mp4` raw and the
 * sidecar answered `404 audio file not found` (prod, 2026-10-02, recordings
 * 02af969f… and 793c624b…).
 *
 * The ladder, cheapest first:
 *   1. the stored file itself, on disk — exactly what every caller read
 *      before; nothing changes for a VM that still holds its files;
 *   2. (`want: 'audio'`) the `audio-only/<stem>.m4a` derivative, on disk;
 *   3. a pull from the media container into a BOUNDED CACHE —
 *      for `'audio'` the derivative's blob when it has one (mono AAC, ~30
 *      MB/h, against several hundred MB for the video; the sidecar decodes
 *      anything ffmpeg does, and the player already plays this same file
 *      against the same transcript times), else the canonical's;
 *      for `'video'` the canonical (frames need the picture).
 *   Nothing on disk and nothing to pull → null, and ONE warning per
 *   recording per process says why (`warnOnce`) — never a silent skip.
 *
 * The cache (`<MW_SCRATCH_DIR or MW_STORAGE_DIR>/media-cache/`) is NOT the
 * audio store: a pulled file never re-populates `storage/audio/`, so a drained
 * VM stays drained. Entries are named by a hash of the blob name, pulled once
 * at a time per blob (single-flight), reference-counted while a caller reads
 * them, and evicted least-recently-used once the cache is over
 * `MW_MEDIA_CACHE_MAX_BYTES` (default 4 GiB) or idle past
 * `MW_MEDIA_CACHE_TTL_MS` (default 1 h) — never while held.
 *
 * Every caller must `release()` what it got (a disk hit's release is a
 * no-op), typically in a `finally`.
 */

export const MEDIA_CACHE_MAX_BYTES_ENV = 'MW_MEDIA_CACHE_MAX_BYTES';
export const MEDIA_CACHE_TTL_MS_ENV = 'MW_MEDIA_CACHE_TTL_MS';
const DEFAULT_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 60 * 60_000;
/** A `.part` older than this is a crashed pull's leftover. */
const STALE_PART_MS = 60 * 60_000;

/** The slice of `ResolvedMedia` this needs — `align.ts` builds it from rows. */
export interface LocalizableMedia {
  /** The stored name under `storage/audio/`. */
  filename: string;
  /** For the log line; '' in fallback mode. */
  recordingId: string;
  /** `recording_media.blob_name`; null = never archived / fallback mode. */
  blobName: string | null;
  isVideo: boolean | null;
  /** The `audio_only` derivative, when one has been built. */
  audioOnly: { filename: string; blobName: string | null } | null;
}

export type LocalMediaWant = 'audio' | 'video';

export interface LocalMedia {
  /** Absolute path, readable now. */
  path: string;
  /** Where it came from — for logs and tests. */
  source: 'disk' | 'disk-audio-only' | 'blob';
  /** Let the cache evict it again. Idempotent; a no-op for a disk hit. */
  release(): void;
}

const g = globalThis as unknown as {
  __mwMediaLocalInflight?: Map<string, Promise<string>>;
  __mwMediaLocalRefs?: Map<string, number>;
  __mwMediaLocalWarned?: Set<string>;
};
// globalThis, not module scope: Next bundles this module once per route
// graph, and two graphs must share one pull and one reference count.
const inflight = (g.__mwMediaLocalInflight ??= new Map<string, Promise<string>>());
const refs = (g.__mwMediaLocalRefs ??= new Map<string, number>());
const warned = (g.__mwMediaLocalWarned ??= new Set<string>());

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Read lazily — `bun run build` has no env, and pm2 restarts flip it. */
export function mediaCacheDir(): string {
  return path.join(scratchRoot() ?? getStorageDir(), 'media-cache');
}

/** `<sha256(blobName)[0:32]><.ext>` — no ids or names of ours on disk twice. */
export function cacheFileFor(blobName: string): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(blobName)?.[0]?.toLowerCase() ?? '';
  const stem = createHash('sha256').update(blobName).digest('hex').slice(0, 32);
  return path.join(mediaCacheDir(), `${stem}${ext}`);
}

async function isNonEmptyFile(p: string): Promise<boolean> {
  const st = await fsp.stat(p).catch(() => null);
  return !!st && st.isFile() && st.size > 0;
}

/**
 * Say it once per recording (per reason) per process: a speaker pass walks
 * every diarized speaker and a report grabs dozens of frames — the same
 * missing file must not print forty times, and must not print zero times.
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  if (warned.size > 2000) warned.clear();
  warned.add(key);
  console.warn(message);
}

function labelOf(media: LocalizableMedia): string {
  return media.recordingId ? `recording ${media.recordingId} (${media.filename})` : media.filename;
}

const NOOP_RELEASE = () => {};

/**
 * A readable local path for `media`, or null (logged once) when there is
 * none to be had. Never throws.
 */
export async function ensureLocalMedia(
  media: LocalizableMedia,
  want: LocalMediaWant,
  opts: {
    /** Who is asking, for the log line: 'voiceprint', 'frames', 'align', … */
    purpose: string;
    /** Tests inject the fake; production reads `mediaStore()`. */
    store?: MediaBlobLike | null;
  }
): Promise<LocalMedia | null> {
  const tag = `[media-local] ${opts.purpose}`;

  // 1. The stored file — the old path, byte for byte.
  let stored: string | null = null;
  try {
    stored = resolveAudioPath(media.filename);
  } catch {
    stored = null;
  }
  if (stored && (await isNonEmptyFile(stored))) {
    return { path: stored, source: 'disk', release: NOOP_RELEASE };
  }

  // 2. The local audio-only derivative, when audio is all that is wanted.
  if (want === 'audio' && media.isVideo !== false) {
    const stem = path.parse(media.filename).name;
    const derivedName = media.audioOnly?.filename ?? `${stem}.m4a`;
    if (!derivedName.includes('/') && !derivedName.includes('\\') && !derivedName.includes('..')) {
      const derived = path.join(getStorageDir(), 'audio-only', derivedName);
      if (await isNonEmptyFile(derived)) {
        return { path: derived, source: 'disk-audio-only', release: NOOP_RELEASE };
      }
    }
  }

  // 3. The archive.
  const store = opts.store === undefined ? mediaStore() : opts.store;
  const blobName =
    want === 'audio' ? (media.audioOnly?.blobName ?? media.blobName) : media.blobName;
  if (!blobName) {
    warnOnce(
      `${opts.purpose}:${media.recordingId || media.filename}:no-blob`,
      `${tag}: ${labelOf(media)} is not on disk and has no archived blob to pull — skipped`
    );
    return null;
  }
  if (!store) {
    warnOnce(
      `${opts.purpose}:${media.recordingId || media.filename}:no-store`,
      `${tag}: ${labelOf(media)} is not on disk and this host has no media store (DARTH_MEDIA_ACCOUNT) to pull ${blobName} from — skipped`
    );
    return null;
  }

  const target = cacheFileFor(blobName);
  // Hold the entry BEFORE awaiting anything, so a concurrent eviction pass
  // never deletes the file between "it is there" and the caller reading it.
  refs.set(target, (refs.get(target) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (refs.get(target) ?? 1) - 1;
    if (n <= 0) refs.delete(target);
    else refs.set(target, n);
    void evictMediaCache().catch(() => {});
  };

  try {
    if (await isNonEmptyFile(target)) {
      // Touch: the eviction order is least-recently-USED, not pulled.
      const now = new Date();
      await fsp.utimes(target, now, now).catch(() => {});
    } else {
      let job = inflight.get(target);
      if (!job) {
        job = pullToCache(store, blobName, target, tag).finally(() => inflight.delete(target));
        inflight.set(target, job);
      }
      await job;
      void evictMediaCache().catch(() => {});
    }
    return { path: target, source: 'blob', release };
  } catch (err) {
    release();
    const message = redactSasInText(err instanceof Error ? err.message : String(err));
    warnOnce(
      `${opts.purpose}:${media.recordingId || media.filename}:pull-failed`,
      `${tag}: ${labelOf(media)} is not on disk and pulling ${blobName} from the archive failed: ${message}`
    );
    return null;
  }
}

/**
 * Blob → `<target>.<uuid>.part` → verify the size against the blob's own
 * properties → rename. The rename is atomic within the cache dir, so a reader
 * never sees half a file; a pull that dies leaves only a `.part` the next
 * eviction pass deletes.
 */
async function pullToCache(
  store: MediaBlobLike,
  blobName: string,
  target: string,
  tag: string
): Promise<string> {
  const started = Date.now();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const props = await store.properties(blobName);
  if (!props) throw new Error(`blob ${blobName} does not exist`);

  const part = `${target}.${randomUUID()}.part`;
  let bytes = 0;
  try {
    const reader = (await store.read(blobName)).getReader();
    const ws = createWriteStream(part, { flags: 'w' });
    const writer = (Writable.toWeb(ws) as unknown as WritableStream<Uint8Array>).getWriter();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        bytes += value.byteLength;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      await reader.cancel().catch(() => {});
      await writer.abort().catch(() => {});
      throw err;
    }
    if (bytes === 0 || bytes !== props.bytes) {
      throw new Error(`pulled ${bytes} B, the blob is ${props.bytes} B`);
    }
    await fsp.rename(part, target);
  } catch (err) {
    await fsp.unlink(part).catch(() => {});
    throw err;
  }
  const ms = Date.now() - started;
  console.log(
    `${tag}: pulled ${blobName} into the media cache, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${(ms / 1000).toFixed(1)}s`
  );
  return target;
}

/**
 * Bring the cache back under its budget: crashed `.part`s go; then, newest
 * use first, entries are kept while they are both inside the TTL and inside
 * the byte budget — anything held by a caller is kept regardless (and counts
 * against the budget). Best effort, never throws to a caller that does not
 * await it.
 */
export async function evictMediaCache(now: number = Date.now()): Promise<{ removed: number }> {
  const dir = mediaCacheDir();
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const maxBytes = envNumber(MEDIA_CACHE_MAX_BYTES_ENV, DEFAULT_CACHE_MAX_BYTES);
  const ttlMs = envNumber(MEDIA_CACHE_TTL_MS_ENV, DEFAULT_CACHE_TTL_MS);
  let removed = 0;

  const entries: Array<{ abs: string; size: number; used: number }> = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    if (name.endsWith('.part')) {
      if (now - st.mtimeMs > STALE_PART_MS && !inflightOwns(abs)) {
        await fsp.unlink(abs).catch(() => {});
        removed++;
      }
      continue;
    }
    entries.push({ abs, size: st.size, used: st.mtimeMs });
  }

  entries.sort((a, b) => b.used - a.used);
  let total = 0;
  for (const e of entries) {
    const held = (refs.get(e.abs) ?? 0) > 0 || inflight.has(e.abs);
    if (held) {
      total += e.size;
      continue;
    }
    const fresh = now - e.used <= ttlMs;
    if (fresh && total + e.size <= maxBytes) {
      total += e.size;
      continue;
    }
    await fsp.unlink(e.abs).catch(() => {});
    removed++;
  }
  return { removed };
}

function inflightOwns(partPath: string): boolean {
  for (const target of inflight.keys()) if (partPath.startsWith(`${target}.`)) return true;
  return false;
}

/**
 * One pass over a meeting's files (a speaker pass walks every speaker, and
 * several speakers share one file): each file is made local at most once and
 * everything is released together at the end. A failure is remembered too, so
 * ten speakers of a file that cannot be had cost one attempt, not ten.
 */
export function localMediaSession(want: LocalMediaWant, purpose: string) {
  const held = new Map<string, Promise<LocalMedia | null>>();
  return {
    get(media: LocalizableMedia & { mediaId?: string }): Promise<LocalMedia | null> {
      const key = `${media.mediaId || ''}|${media.filename}`;
      let hit = held.get(key);
      if (!hit) {
        hit = ensureLocalMedia(media, want, { purpose });
        held.set(key, hit);
      }
      return hit;
    },
    async releaseAll(): Promise<void> {
      for (const p of held.values()) (await p.catch(() => null))?.release();
      held.clear();
    },
  };
}

/** Tests: forget the once-per-recording warnings and any reference counts. */
export function resetMediaLocalForTests(): void {
  warned.clear();
  refs.clear();
  inflight.clear();
}
