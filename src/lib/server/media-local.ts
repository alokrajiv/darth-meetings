import 'server-only';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import { statfs as nodeStatfs } from 'node:fs/promises';
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
 * Every caller must `release()` what it got, typically in a `finally`. Since
 * Stage D (docs/recordings-stage-d-spec.md) a DISK hit is reference-counted
 * too, keyed by the absolute path handed out: `localMediaHeld(path)` is how the
 * eviction (`media-evict.ts`) sees that an ffmpeg / sidecar / upload is
 * reading a stored file right now and leaves it alone.
 *
 * Stage D also makes the pull stricter: the bytes are hashed while they are
 * written and must equal the row's `sha256` when the caller knows it (the
 * `.part` is removed and nothing is cached otherwise), and a pull never starts
 * when the cache's filesystem would be left with less than
 * `MW_MEDIA_CACHE_MIN_FREE_BYTES` (default 5 GiB) — the cache lives on the
 * shared `/temphigh` NVMe and must never fill it.
 */

export const MEDIA_CACHE_MAX_BYTES_ENV = 'MW_MEDIA_CACHE_MAX_BYTES';
export const MEDIA_CACHE_TTL_MS_ENV = 'MW_MEDIA_CACHE_TTL_MS';
const DEFAULT_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 60 * 60_000;
/** Stage D: free space the cache's filesystem must keep AFTER a pull. */
export const MEDIA_CACHE_MIN_FREE_BYTES_ENV = 'MW_MEDIA_CACHE_MIN_FREE_BYTES';
const DEFAULT_CACHE_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;
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
  /**
   * `recording_media.sha256` of the stored file (Stage D). When known, a pull
   * of `blobName` must hash to it; absent/null = the size check only, as
   * before.
   */
  sha256?: string | null;
  isVideo: boolean | null;
  /** The `audio_only` derivative, when one has been built. */
  audioOnly: { filename: string; blobName: string | null; sha256?: string | null } | null;
}

/**
 * - `'audio'`: anything with the soundtrack — the stored file, else the local
 *   or archived audio-only extract (smallest pull), else the canonical blob.
 * - `'video'`: the picture — the stored file, else the canonical blob.
 * - `'canonical'`: THE STORED FILE'S OWN BYTES and nothing else — the stored
 *   file, else the canonical blob, never a derivative and regardless of
 *   `isVideo`. Re-transcription and re-ingest need the exact bytes
 *   `recordings.sha256` describes.
 */
export type LocalMediaWant = 'audio' | 'video' | 'canonical';

export interface LocalMedia {
  /** Absolute path, readable now. */
  path: string;
  /** Where it came from — for logs and tests. */
  source: 'disk' | 'disk-audio-only' | 'blob';
  /** Drop this handle's reference (the cache may evict, Stage D may delete). Idempotent. */
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

/**
 * Take a reference on `abs` and return its release: idempotent per handle,
 * and the count is what `localMediaHeld` and the cache's eviction read.
 */
function hold(abs: string, onRelease?: () => void): () => void {
  refs.set(abs, (refs.get(abs) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (refs.get(abs) ?? 1) - 1;
    if (n <= 0) refs.delete(abs);
    else refs.set(abs, n);
    onRelease?.();
  };
}

/**
 * Hold a stored file by PATH, for a caller that reads a file this module did
 * not hand out — align.ts reads the on-disk audio-only extract of a video it
 * holds the source of. Same count `localMediaHeld` and the eviction read; the
 * returned release is idempotent. Only for paths under the storage dir.
 */
export function holdLocalPath(absPath: string): () => void {
  return hold(absPath);
}

/**
 * Is somebody reading `absPath` through this module right now (a handle not
 * yet released), or is a pull writing it? Stage D's eviction asks this
 * before it deletes a stored file — an ffmpeg pass, the voiceprint sidecar
 * or an AssemblyAI upload holding the file blocks its eviction.
 */
export function localMediaHeld(absPath: string): boolean {
  return (refs.get(absPath) ?? 0) > 0 || inflight.has(absPath);
}

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
  if (stored) {
    // Held BEFORE the stat, so an eviction that asks `localMediaHeld` after
    // this point sees the reader even while the stat is in flight.
    const releaseStored = hold(stored);
    if (await isNonEmptyFile(stored)) {
      return { path: stored, source: 'disk', release: releaseStored };
    }
    releaseStored();
  }

  // 2. The local audio-only derivative, when audio is all that is wanted.
  if (want === 'audio' && media.isVideo !== false) {
    const stem = path.parse(media.filename).name;
    const derivedName = media.audioOnly?.filename ?? `${stem}.m4a`;
    if (!derivedName.includes('/') && !derivedName.includes('\\') && !derivedName.includes('..')) {
      const derived = path.join(getStorageDir(), 'audio-only', derivedName);
      const releaseDerived = hold(derived);
      if (await isNonEmptyFile(derived)) {
        return { path: derived, source: 'disk-audio-only', release: releaseDerived };
      }
      releaseDerived();
    }
  }

  // 3. The archive. Only `'audio'` may take the derivative's blob; `'video'`
  // and `'canonical'` pull the stored file's own.
  const store = opts.store === undefined ? mediaStore() : opts.store;
  const useDerivative = want === 'audio' && !!media.audioOnly?.blobName;
  const blobName = useDerivative ? media.audioOnly!.blobName : media.blobName;
  const expectedSha256 = (useDerivative ? media.audioOnly?.sha256 : media.sha256) ?? null;
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
  const release = hold(target, () => void evictMediaCache().catch(() => {}));

  try {
    if (await isNonEmptyFile(target)) {
      // Touch: the eviction order is least-recently-USED, not pulled.
      const now = new Date();
      await fsp.utimes(target, now, now).catch(() => {});
    } else {
      let job = inflight.get(target);
      if (!job) {
        job = pullToCache(store, blobName, target, tag, expectedSha256).finally(() =>
          inflight.delete(target)
        );
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

/** `statfs` — swappable so the free-space guard can be tested. */
type StatfsLike = (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
let statfsImpl: StatfsLike = nodeStatfs as unknown as StatfsLike;

/** Tests: pretend the cache's filesystem has this much room (null = the real one). */
export function setMediaCacheStatfsForTests(fn: StatfsLike | null): void {
  statfsImpl = fn ?? (nodeStatfs as unknown as StatfsLike);
}

/** Free bytes for an unprivileged writer on `dir`'s filesystem; null = cannot tell. */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const st = await statfsImpl(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function minFreeBytes(): number {
  // 0 is a legitimate setting (tests, a dedicated volume); unset/garbage = default.
  const raw = Number(process.env[MEDIA_CACHE_MIN_FREE_BYTES_ENV]);
  return Number.isFinite(raw) && raw >= 0 && process.env[MEDIA_CACHE_MIN_FREE_BYTES_ENV]?.trim()
    ? raw
    : DEFAULT_CACHE_MIN_FREE_BYTES;
}

/**
 * Stage D: never start a pull that would leave the cache's filesystem with
 * less than `MW_MEDIA_CACHE_MIN_FREE_BYTES` — the cache shares `/temphigh`
 * with every scratch job. Short → evict the cache first and look again; still
 * short → throw, which `ensureLocalMedia` turns into null plus one warning
 * naming the free space. A filesystem that cannot be asked is not a reason to
 * refuse every read: the pull goes ahead, as before this guard existed.
 */
async function ensureCacheRoom(dir: string, size: number): Promise<void> {
  const need = size + minFreeBytes();
  const free = await freeBytes(dir);
  if (free === null || free >= need) return;
  await evictMediaCache();
  const after = await freeBytes(dir);
  if (after === null || after >= need) return;
  throw new Error(
    `not enough free space for the media cache at ${dir}: ${after} B free, ` +
      `${need} B needed (${size} B + ${MEDIA_CACHE_MIN_FREE_BYTES_ENV} ${need - size} B) — pull refused`
  );
}

/**
 * Blob → `<target>.<uuid>.part` → verify the size against the blob's own
 * properties and, when the caller knows it, the sha256 of the bytes written
 * (hashed on the way through — Stage D) → rename. The rename is atomic within
 * the cache dir, so a reader never sees half a file; a pull that dies — or
 * whose bytes are not the row's — leaves no cache entry, its `.part` removed.
 */
async function pullToCache(
  store: MediaBlobLike,
  blobName: string,
  target: string,
  tag: string,
  expectedSha256: string | null
): Promise<string> {
  const started = Date.now();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const props = await store.properties(blobName);
  if (!props) throw new Error(`blob ${blobName} does not exist`);
  await ensureCacheRoom(path.dirname(target), props.bytes);

  const part = `${target}.${randomUUID()}.part`;
  const hash = createHash('sha256');
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
        hash.update(value);
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
    const sha256 = hash.digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(
        `sha256 mismatch: the pulled bytes hash to ${sha256}, the media row says ${expectedSha256} — not cached`
      );
    }
    await fsp.rename(part, target);
  } catch (err) {
    await fsp.unlink(part).catch(() => {});
    throw err;
  }
  const ms = Date.now() - started;
  console.log(
    `${tag}: pulled ${blobName} into the media cache, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${(ms / 1000).toFixed(1)}s` +
      (expectedSha256 ? ' (sha256 verified)' : '')
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
