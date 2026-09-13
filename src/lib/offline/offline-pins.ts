import {
  ALL_CACHES,
  CACHE_API,
  CACHE_MEDIA,
  CACHE_PAGES,
  CACHE_STATIC,
  META_OWNER_USER_ID,
  META_PERSIST_REQUESTED,
  OFFLINE_CHANGE_EVENT,
  OFFLINE_MODE_KEY,
  type PinBytes,
  type PinLevel,
  type PinRecord,
  type PlanMeeting,
  type StorageEstimate,
} from './offline-types';
import { STORE_PINS, dbClearAll, dbDelete, dbGet, dbGetAll, dbPut, metaGet, metaSet } from './offline-db';
import {
  extractStaticAssets,
  levelRank,
  transcriptApiBase,
  urlsForLevel,
  urlsToDrop,
  type UrlMeta,
} from './offline-urls';

export { levelIncludes, levelRank, maxLevel } from './offline-urls';

/**
 * The pin ledger: which meetings this device keeps offline, at what level,
 * and the Cache Storage bookkeeping that goes with it. Every mutation ends
 * with a window 'darth-offline-change' event so the provider / UI re-read.
 *
 * Why the caches are filled from the PAGE and not from the worker: the
 * service worker has no idea what a "meeting" is — it only answers URL
 * lookups. Keeping the download logic here means it runs with the user's
 * cookies, the 401 → login guard and normal devtools visibility, and the
 * worker stays a dumb, auditable router (public/sw.js).
 */

// ---------------------------------------------------------------------------
// Concurrency limiters (shared with offline-sync so a sync and a manual pin
// never exceed 2 media + 4 transcript-level requests in flight together).
// ---------------------------------------------------------------------------

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly queued: number;
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const job = queue.shift();
    if (job) job();
  };
  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active += 1;
          fn().then(resolve, reject).finally(() => {
            active -= 1;
            next();
          });
        };
        queue.push(start);
        next();
      });
    },
  };
}

/** Transcript-level (document, JSON, frames, static chunks) fetches. */
export const transcriptLimiter = createLimiter(4);
/** Media bodies — big, keep them to two at a time. */
export const mediaLimiter = createLimiter(2);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type OfflineChangeKind = 'pin' | 'unpin' | 'progress' | 'sync' | 'clear' | 'storage';

export function emitOfflineChange(kind: OfflineChangeKind, detail: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(OFFLINE_CHANGE_EVENT, { detail: { kind, ...detail } }));
  } catch {
    /* CustomEvent unavailable — nothing to notify */
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function cachesApi(): CacheStorage | null {
  const c = (globalThis as { caches?: CacheStorage }).caches;
  return c ?? null;
}

export function offlineSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!cachesApi() &&
    'indexedDB' in window &&
    'serviceWorker' in navigator
  );
}

async function openCache(name: string): Promise<Cache> {
  const c = cachesApi();
  if (!c) throw new Error('Cache Storage is not available');
  return c.open(name);
}

async function cacheHas(name: string, url: string): Promise<boolean> {
  try {
    const cache = await openCache(name);
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

async function cacheDeleteAll(name: string, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  try {
    const cache = await openCache(name);
    await Promise.all(urls.map((u) => cache.delete(u).catch(() => false)));
  } catch {
    /* cache gone already */
  }
}

const FETCH_OPTS: RequestInit = { credentials: 'include', cache: 'no-store' };

function landedOnLogin(res: Response): boolean {
  if (!res.redirected) return false;
  try {
    return new URL(res.url).pathname.startsWith('/login');
  } catch {
    return false;
  }
}

/**
 * Fetch a JSON/asset URL and store it verbatim. Returns the byte size and,
 * for JSON, the parsed body (so callers can mine it without a second read).
 */
async function fetchAndStore(
  cacheName: string,
  url: string,
  init: RequestInit = {}
): Promise<{ bytes: number; response: Response }> {
  const res = await fetch(url, { ...FETCH_OPTS, ...init });
  if (!res.ok || landedOnLogin(res)) {
    throw new Error(`${url} → ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  // The worker can't honour no-store for a programmatic cache anyway; drop
  // the header so devtools doesn't mislead.
  headers.delete('cache-control');
  const stored = new Response(buf, { status: 200, statusText: 'OK', headers });
  const cache = await openCache(cacheName);
  await cache.put(url, stored);
  return { bytes: buf.byteLength, response: new Response(buf, { status: 200, headers }) };
}

/** A document (HTML) fetched as a page would be, stored under its pathname. */
async function fetchAndStoreDocument(path: string): Promise<{ bytes: number; html: string }> {
  const res = await fetch(path, { ...FETCH_OPTS, headers: { accept: 'text/html' } });
  if (!res.ok || landedOnLogin(res)) throw new Error(`${path} → ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!/text\/html/i.test(ct)) throw new Error(`${path} → not HTML (${ct || 'no content-type'})`);
  const html = await res.text();
  const stored = new Response(html, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  const cache = await openCache(CACHE_PAGES);
  await cache.put(path, stored);
  return { bytes: html.length, html };
}

/** Static chunks are content-hashed: cache-first, fetch only what's missing. */
async function ensureStaticAssets(urls: string[]): Promise<void> {
  await Promise.all(
    urls.map((u) =>
      transcriptLimiter.run(async () => {
        if (await cacheHas(CACHE_STATIC, u)) return;
        try {
          await fetchAndStore(CACHE_STATIC, u);
        } catch {
          /* a missing chunk is not fatal — the SW fills it on the next online visit */
        }
      })
    )
  );
}

/**
 * Cache a document plus every static asset it references. Exported for the
 * sync engine (build-id refresh, shell pages like `/`). Returns HTML bytes.
 */
export async function cacheDocument(path: string): Promise<number> {
  const { bytes, html } = await transcriptLimiter.run(() => fetchAndStoreDocument(path));
  await ensureStaticAssets(extractStaticAssets(html));
  return bytes;
}

/** Remove a cached document (shell pages on clear, etc.). */
export async function dropDocument(path: string): Promise<void> {
  await cacheDeleteAll(CACHE_PAGES, [path]);
}

/**
 * Drop every static chunk no cached document references any more. Chunk
 * names are content-hashed, so without this each deploy leaves the previous
 * bundle behind and the static cache grows by one client bundle per deploy,
 * eating the quota the media pins need. Best effort; called after a
 * build-id refresh has re-fetched the documents.
 */
export async function pruneStaticCache(): Promise<{ kept: number; dropped: number }> {
  const out = { kept: 0, dropped: 0 };
  try {
    const pages = await openCache(CACHE_PAGES);
    const live = new Set<string>();
    for (const req of await pages.keys()) {
      const res = await pages.match(req);
      if (!res) continue;
      for (const u of extractStaticAssets(await res.text())) live.add(u);
    }
    const statics = await openCache(CACHE_STATIC);
    for (const req of await statics.keys()) {
      const u = new URL(req.url);
      if (live.has(u.pathname + u.search)) {
        out.kept += 1;
        continue;
      }
      if (await statics.delete(req).catch(() => false)) out.dropped += 1;
    }
  } catch (err) {
    console.warn('[offline] static cache prune failed', err);
  }
  return out;
}

const MEDIA_POLL_MS = 5_000;
const MEDIA_POLL_MAX_MS = 15 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Download one media URL in full (no Range) and store it. A 202 means the
 * server is still transcoding the audio-only derivative: poll every 5 s
 * for up to 15 min. Returns the byte count.
 */
async function fetchAndStoreMedia(url: string): Promise<number> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(url, FETCH_OPTS);
    if (res.status === 202) {
      await res.body?.cancel().catch(() => undefined);
      if (Date.now() - started > MEDIA_POLL_MAX_MS) throw new Error(`${url} → still preparing after 15 min`);
      await sleep(MEDIA_POLL_MS);
      continue;
    }
    if (res.status !== 200 || landedOnLogin(res)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${url} → ${res.status}`);
    }
    const cache = await openCache(CACHE_MEDIA);
    const len = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(len) && len > 0) {
      // Stream straight into the cache — no copy in memory.
      await cache.put(url, res);
      return len;
    }
    const blob = await res.blob();
    const headers = new Headers(res.headers);
    headers.set('content-length', String(blob.size));
    await cache.put(url, new Response(blob, { status: 200, headers }));
    return blob.size;
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function emptyBytes(): PinBytes {
  return { transcript: 0, audio: 0, video: 0 };
}

export interface PinOptions {
  /** true = the user chose this level; the auto policy leaves it alone. */
  manual: boolean;
  /** Plan row (title/date/rev/media). Without it the record keeps its old
   * metadata or, for a brand-new pin, reads the title from the API body. */
  meta?: PlanMeeting | null;
  /** Re-download transcript-level URLs even if the record is already ready
   * at this level (rev changed). Media is never re-downloaded when cached. */
  refresh?: boolean;
}

export async function getPin(id: string): Promise<PinRecord | undefined> {
  try {
    return await dbGet(STORE_PINS, id);
  } catch {
    return undefined;
  }
}

/** All records, newest meeting first. Includes manual 'none' exclusions. */
export async function listPins(): Promise<PinRecord[]> {
  let rows: PinRecord[];
  try {
    rows = await dbGetAll(STORE_PINS);
  } catch {
    return [];
  }
  return rows.sort((a, b) => {
    const ta = a.recordedAt ?? a.pinnedAt;
    const tb = b.recordedAt ?? b.pinnedAt;
    return tb.localeCompare(ta) || b.id.localeCompare(a.id);
  });
}

async function saveRecord(rec: PinRecord): Promise<PinRecord> {
  await dbPut(STORE_PINS, rec);
  return rec;
}

/** Per-id serialisation: two overlapping pin calls on one meeting would race
 * on the record and the caches. */
const inflight = new Map<string, Promise<unknown>>();

function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  inflight.set(id, tail);
  void tail.then(() => {
    if (inflight.get(id) === tail) inflight.delete(id);
  });
  return run;
}

interface TranscriptApiBody {
  transcript?: {
    title?: string | null;
    recorded_at?: string | null;
    created_at?: string | null;
    auto_notes?: string | null;
    auto_report?: string | null;
    duration?: number | null;
    gmeet_context?: { videoParts?: unknown[] } | null;
    local_audio_path?: string | null;
  };
}

/**
 * Transcript tier: the document, its static assets, the API JSON set and
 * every frame image the notes/report embed. Returns bytes + the markdown
 * bodies (so the caller knows which frame URLs to drop later) + a UrlMeta
 * fallback derived from the API row when no plan row is at hand.
 */
async function downloadTranscriptTier(
  id: string,
  onProgress?: (msg: string) => void
): Promise<{ bytes: number; markdowns: string[]; title: string | null; recordedAt: string | null; durationSec: number | null; parts: number }> {
  let bytes = 0;
  const base = transcriptApiBase(id);

  // The row first — it tells us which frames exist.
  onProgress?.('transcript');
  const rowRes = await transcriptLimiter.run(() => fetchAndStore(CACHE_API, base));
  bytes += rowRes.bytes;
  let body: TranscriptApiBody = {};
  try {
    body = (await rowRes.response.json()) as TranscriptApiBody;
  } catch {
    body = {};
  }
  const t = body.transcript ?? {};
  const markdowns = [t.auto_notes ?? '', t.auto_report ?? ''];
  const parts = t.local_audio_path ? 1 + (t.gmeet_context?.videoParts?.length ?? 0) : 0;

  const set = urlsForLevel(id, 'transcript', null, markdowns);
  const rest = set.api.filter((u) => u !== base);
  const results = await Promise.allSettled(
    rest.map((u) =>
      transcriptLimiter.run(async () => {
        const isFrame = u.includes('/frames/');
        if (isFrame && (await cacheHas(CACHE_API, u))) return 0; // frames are immutable
        const r = await fetchAndStore(CACHE_API, u);
        return r.bytes;
      })
    )
  );
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') bytes += r.value;
    else failures.push(rest[i]!);
  });
  // Optional sub-resources (series/labels/ai-runs/attachments) may 404 for
  // some rows; only the essentials decide success.
  const essential = failures.filter((u) => /\/(content|speakers|edits)$/.test(u));
  if (essential.length > 0) throw new Error(`Could not save ${essential.map((u) => u.slice(base.length)).join(', ')}`);

  onProgress?.('page');
  bytes += await cacheDocument(set.pages[0]!);

  return {
    bytes,
    markdowns,
    title: t.title ?? null,
    recordedAt: t.recorded_at ?? t.created_at ?? null,
    durationSec: typeof t.duration === 'number' ? t.duration : null,
    parts,
  };
}

async function downloadMediaTier(urls: string[], onProgress?: (msg: string) => void): Promise<number> {
  let bytes = 0;
  const results = await Promise.allSettled(
    urls.map((u) =>
      mediaLimiter.run(async () => {
        if (await cacheHas(CACHE_MEDIA, u)) return 0;
        onProgress?.(u.includes('variant=audio') ? 'audio' : 'video');
        return fetchAndStoreMedia(u);
      })
    )
  );
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length > 0) throw failed[0]!.reason instanceof Error ? failed[0]!.reason : new Error(String(failed[0]!.reason));
  for (const r of results) if (r.status === 'fulfilled') bytes += r.value;
  return bytes;
}

/** Sum the sizes of cached media URLs (for bytes after a partial re-pin). */
async function cachedMediaBytes(urls: string[]): Promise<number> {
  let total = 0;
  try {
    const cache = await openCache(CACHE_MEDIA);
    for (const u of urls) {
      const res = await cache.match(u);
      if (!res) continue;
      const len = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      total += Number.isFinite(len) ? len : 0;
    }
  } catch {
    /* ignore */
  }
  return total;
}

function metaFromPlan(meta: PlanMeeting | null | undefined): UrlMeta {
  return meta ? { media: meta.media } : null;
}

/**
 * Pin (or re-level) a meeting. Idempotent: adds the URL sets the new level
 * needs, drops the ones it no longer needs. `level: 'none'` with
 * manual:true keeps a tombstone record so the auto policy never re-pins
 * it; with manual:false it deletes everything.
 */
export function pinMeeting(id: string, level: PinLevel, opts: PinOptions): Promise<PinRecord | null> {
  return serialized(id, () => pinMeetingInner(id, level, opts));
}

async function pinMeetingInner(id: string, level: PinLevel, opts: PinOptions): Promise<PinRecord | null> {
  const existing = await getPin(id);
  const meta = opts.meta ?? null;

  if (level === 'none') {
    await dropUrls(id, existing?.level ?? 'video', 'none', metaFromPlan(meta));
    if (!opts.manual) {
      await dbDelete(STORE_PINS, id).catch(() => undefined);
      emitOfflineChange('unpin', { id });
      return null;
    }
    const rec: PinRecord = {
      id,
      level: 'none',
      manual: true,
      title: meta?.title ?? existing?.title ?? null,
      recordedAt: meta?.recordedAt ?? existing?.recordedAt ?? null,
      durationSec: meta?.durationSec ?? existing?.durationSec ?? null,
      rev: meta?.rev ?? existing?.rev ?? '',
      status: 'ready',
      bytes: emptyBytes(),
      pinnedAt: existing?.pinnedAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    await saveRecord(rec);
    emitOfflineChange('pin', { id, level });
    return rec;
  }

  const fromLevel = existing?.level ?? 'none';
  const record: PinRecord = {
    id,
    level,
    manual: opts.manual,
    title: meta?.title ?? existing?.title ?? null,
    recordedAt: meta?.recordedAt ?? existing?.recordedAt ?? null,
    durationSec: meta?.durationSec ?? existing?.durationSec ?? null,
    rev: meta?.rev ?? existing?.rev ?? '',
    status: 'pending',
    bytes: existing?.bytes ? { ...existing.bytes } : emptyBytes(),
    pinnedAt: existing?.pinnedAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  delete record.error;
  await saveRecord(record);
  emitOfflineChange('pin', { id, level, status: 'pending' });

  const progress = (stage: string) => emitOfflineChange('progress', { id, stage });

  try {
    // Transcript tier: fresh when new, when asked (rev changed), or when the
    // previous attempt did not finish.
    const needTranscript =
      opts.refresh || !existing || existing.status !== 'ready' || levelRank(fromLevel) < 1;
    let markdowns: string[] = [];
    let parts = meta ? meta.media.parts.length : 1;
    if (needTranscript) {
      const t = await downloadTranscriptTier(id, progress);
      record.bytes.transcript = t.bytes;
      markdowns = t.markdowns;
      if (!meta) {
        record.title = record.title ?? t.title;
        record.recordedAt = record.recordedAt ?? t.recordedAt;
        record.durationSec = record.durationSec ?? t.durationSec;
        parts = t.parts;
      }
    } else if (!meta) {
      // Level change only: reuse the cached row for the part count.
      parts = await cachedPartCount(id);
    }

    const urlMeta: UrlMeta = meta
      ? metaFromPlan(meta)
      : { media: { hasLocal: parts > 0, isVideo: true, parts: Array.from({ length: parts }, (_, i) => ({ part: i + 1, filename: '', isVideo: true, bytes: null })) } };
    const want = urlsForLevel(id, level, urlMeta, markdowns);

    // Media tiers (cache-first per URL — an upgrade only fetches what's new).
    const audioUrls = want.media.filter((u) => u.includes('variant=audio'));
    const videoUrls = want.media.filter((u) => !u.includes('variant=audio'));
    if (audioUrls.length > 0) {
      await downloadMediaTier(audioUrls, progress);
      record.bytes.audio = await cachedMediaBytes(audioUrls);
    } else {
      record.bytes.audio = 0;
    }
    if (videoUrls.length > 0) {
      await downloadMediaTier(videoUrls, progress);
      record.bytes.video = await cachedMediaBytes(videoUrls);
    } else {
      record.bytes.video = 0;
    }

    // Downgrade: evict what the new level no longer covers.
    if (levelRank(fromLevel) > levelRank(level)) {
      await dropUrls(id, fromLevel, level, urlMeta);
    }

    record.status = 'ready';
    delete record.error;
  } catch (err) {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
  }
  record.updatedAt = nowIso();
  await saveRecord(record);
  emitOfflineChange('pin', { id, level, status: record.status });
  return record;
}

async function cachedPartCount(id: string): Promise<number> {
  try {
    const cache = await openCache(CACHE_API);
    const res = await cache.match(transcriptApiBase(id));
    if (!res) return 1;
    const body = (await res.json()) as TranscriptApiBody;
    const t = body.transcript ?? {};
    return t.local_audio_path ? 1 + (t.gmeet_context?.videoParts?.length ?? 0) : 0;
  } catch {
    return 1;
  }
}

/** Frame URLs currently cached for a meeting (so a drop doesn't need the markdown). */
async function cachedFrameUrls(id: string): Promise<string[]> {
  try {
    const cache = await openCache(CACHE_API);
    const prefix = `${transcriptApiBase(id)}/frames/`;
    const keys = await cache.keys();
    return keys.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Evict the URLs `from` has but `to` lacks. Media parts unknown → assume up to 10. */
async function dropUrls(id: string, from: PinLevel, to: PinLevel, meta: UrlMeta): Promise<void> {
  const wide: UrlMeta = meta ?? {
    media: { hasLocal: true, isVideo: true, parts: Array.from({ length: 10 }, (_, i) => ({ part: i + 1, filename: '', isVideo: true, bytes: null })) },
  };
  const drop = urlsToDrop(id, from, to, wide);
  if (levelRank(to) < 1) drop.api.push(...(await cachedFrameUrls(id)));
  await Promise.all([
    cacheDeleteAll(CACHE_PAGES, drop.pages),
    cacheDeleteAll(CACHE_API, drop.api),
    cacheDeleteAll(CACHE_MEDIA, drop.media),
  ]);
}

/** Remove a meeting entirely: caches + record. */
export function unpinMeeting(id: string): Promise<void> {
  return serialized(id, () => unpinInner(id));
}

/**
 * The auto policy's eviction: like unpinMeeting, but re-checks `manual`
 * inside the per-id queue. A sync pass builds its eviction jobs from a
 * snapshot and runs them minutes later; if the user pinned the meeting by
 * hand in between, that pin must win.
 */
export function unpinIfAuto(id: string): Promise<void> {
  return serialized(id, async () => {
    const cur = await getPin(id);
    if (cur?.manual) return;
    await unpinInner(id);
  });
}

async function unpinInner(id: string): Promise<void> {
  const existing = await getPin(id);
  await dropUrls(id, existing?.level === 'none' ? 'video' : (existing?.level ?? 'video'), 'none', null);
  await dbDelete(STORE_PINS, id).catch(() => undefined);
  emitOfflineChange('unpin', { id });
}

/**
 * Re-download the transcript tier of an existing pin (rev changed or the
 * build moved). Keeps level/manual; media untouched.
 */
export async function refreshPinContent(id: string, meta?: PlanMeeting | null): Promise<PinRecord | null> {
  const existing = await getPin(id);
  if (!existing || existing.level === 'none') return existing ?? null;
  return pinMeeting(id, existing.level, { manual: existing.manual, meta: meta ?? null, refresh: true });
}

/** Re-fetch only the document + its static assets (build-id change). */
export async function refreshPinDocument(id: string): Promise<void> {
  const existing = await getPin(id);
  if (!existing || existing.level === 'none') return;
  try {
    await cacheDocument(urlsForLevel(id, 'transcript').pages[0]!);
  } catch (err) {
    await saveRecord({ ...existing, status: 'error', error: err instanceof Error ? err.message : String(err), updatedAt: nowIso() });
    emitOfflineChange('pin', { id, level: existing.level, status: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function estimateStorage(): Promise<StorageEstimate> {
  const pinned: PinBytes = emptyBytes();
  for (const p of await listPins()) {
    pinned.transcript += p.bytes?.transcript ?? 0;
    pinned.audio += p.bytes?.audio ?? 0;
    pinned.video += p.bytes?.video ?? 0;
  }
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    usage = est?.usage ?? null;
    quota = est?.quota ?? null;
  } catch {
    /* unsupported */
  }
  return { usage, quota, pinned };
}

/**
 * Ask the browser to exempt our origin from storage pressure eviction
 * (Chrome grants it silently for installed/engaged sites; Safari ignores
 * it and evicts after 7 days without a visit). Asked once per device.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const prior = await metaGet<boolean>(META_PERSIST_REQUESTED);
    if (prior === true) return (await navigator.storage?.persisted?.()) ?? true;
    const granted = (await navigator.storage?.persist?.()) ?? false;
    await metaSet(META_PERSIST_REQUESTED, true);
    return granted;
  } catch {
    return false;
  }
}

/** Local-storage keys this feature owns (cleared with everything else). */
const LOCAL_KEYS = [OFFLINE_MODE_KEY];

/**
 * Wipe every trace: the IndexedDB ledger and our localStorage keys first
 * (cheap, unconditional — the logout button races this against a 3 s cap
 * and navigates away, so the identifying data must go before anything
 * that can stall), then the caches directly, and only then a courtesy
 * message to the worker (capped at 1 s; the direct delete already removed
 * the same data). Mode resets to 'online'.
 */
export async function clearAllOffline(): Promise<void> {
  await dbClearAll();
  try {
    for (const k of LOCAL_KEYS) window.localStorage.removeItem(k);
  } catch {
    /* private mode */
  }
  const c = cachesApi();
  if (c) {
    try {
      const names = await c.keys();
      await Promise.all(names.filter((n) => n.startsWith('darth-')).map((n) => c.delete(n)));
    } catch {
      /* ignore */
    }
  }
  await askWorkerToClear();
  emitOfflineChange('clear');
}

/**
 * Bind the ledger + caches to a session identity. Called with the userId
 * every successful session probe returns: the first one is adopted; a
 * DIFFERENT one means another person signed in on this browser, so
 * everything the previous user pinned is wiped before their id is
 * recorded. Returns true when a wipe happened. Never throws.
 */
export async function ensureOfflineOwner(userId: string): Promise<boolean> {
  if (!userId) return false;
  let owner: string | undefined;
  try {
    owner = await metaGet<string>(META_OWNER_USER_ID);
  } catch {
    return false;
  }
  if (owner === userId) return false;
  let wiped = false;
  if (owner !== undefined) {
    await clearAllOffline().catch(() => undefined);
    wiped = true;
  }
  await metaSet(META_OWNER_USER_ID, userId).catch(() => undefined);
  return wiped;
}

function askWorkerToClear(): Promise<void> {
  return new Promise((resolve) => {
    const ctrl = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
    if (!ctrl) return resolve();
    const timer = setTimeout(done, 1_000);
    function done() {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMsg);
      resolve();
    }
    function onMsg(ev: MessageEvent) {
      if (ev.data && (ev.data as { type?: string }).type === 'CLEARED') done();
    }
    navigator.serviceWorker.addEventListener('message', onMsg);
    try {
      ctrl.postMessage({ type: 'CLEAR_ALL' });
    } catch {
      done();
    }
  });
}

/** Names of the caches this feature owns — for diagnostics. */
export const OFFLINE_CACHE_NAMES: readonly string[] = ALL_CACHES;
