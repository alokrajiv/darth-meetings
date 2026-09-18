/* eslint-disable */
/**
 * Darth Meetings service worker — offline support.
 *
 * A deliberately dumb router: it never decides WHAT to keep offline (the
 * page does that through src/lib/offline/*, which fills the caches with
 * the user's cookies and normal devtools visibility). The worker only
 * answers "is this URL in one of our caches, and how should it be served?"
 *
 * It DOES know one thing the page decided: the MODE. In offline mode the
 * worker is cache-only — nothing waits on the network, cached copies are
 * served instantly and everything else gets an instant 503. In online mode
 * it is network-first with a short cap wherever a cached copy exists, so a
 * network that stalls instead of failing (a VPN tunnel that stays up with
 * Wi-Fi off — the OS says "online", requests just hang) can never hold a
 * page load hostage for longer than NET_TIMEOUT_MS.
 *
 * Cache names and URL shapes are a contract with src/lib/offline/
 * offline-types.ts + offline-urls.ts — change them in both places.
 *
 * Passes straight through (no respondWith at all): every non-GET request
 * (uploads: POST /api/transcripts, PUT /api/uploads/…), the SSE stream
 * /api/events, and cross-origin requests.
 */

const CACHE_PAGES = 'darth-offline-pages-v1';
const CACHE_API = 'darth-offline-api-v1';
const CACHE_MEDIA = 'darth-offline-media-v1';
const CACHE_STATIC = 'darth-static-v1';
const CACHE_META = 'darth-meta-v1';
const CURRENT_CACHES = [CACHE_PAGES, CACHE_API, CACHE_MEDIA, CACHE_STATIC, CACHE_META];

const OFFLINE_PAGE = '/offline';
/** Key (in CACHE_META) whose body is 'offline' | 'online' — written by the page AND by SET_MODE. */
const MODE_KEY = '/__darth/mode';
/** Suffix under which a page's RSC (flight) payload is cached in CACHE_API: `<pathname>?__rsc=1`. */
const RSC_SUFFIX = '?__rsc=1';

/**
 * Online mode, cached copy exists: how long the network gets before the copy
 * is served instead. A healthy server answers these in well under a second;
 * a stalled one never answers at all.
 */
const NET_TIMEOUT_MS = 2500;

const AUDIO_RE = /^\/api\/transcripts\/[^/]+\/audio$/;
const FRAME_RE = /^\/api\/transcripts\/[^/]+\/frames\/\d+\.jpg$/;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('darth-') && !CURRENT_CACHES.includes(n))
          .map((n) => caches.delete(n))
      );
      await precacheOfflinePage();
      await self.clients.claim();
    })()
  );
});

/** Best effort: the "not saved for offline" fallback document. */
async function precacheOfflinePage() {
  try {
    const res = await fetchWithTimeout(new Request(OFFLINE_PAGE, { credentials: 'include', headers: { accept: 'text/html' } }), NET_TIMEOUT_MS);
    if (res.ok && !res.redirected && /text\/html/i.test(res.headers.get('content-type') || '')) {
      const cache = await caches.open(CACHE_PAGES);
      await cache.put(OFFLINE_PAGE, res);
    }
  } catch (_) {
    /* offline at activate time — the page caches it on the next sync */
  }
}

// ---------------------------------------------------------------------------
// Mode — 'online' | 'offline'. Memoised per worker lifetime; the browser
// stops idle workers, so every cold start re-reads the cache entry (~1 ms)
// before answering the first request — a PWA launched with the network dead
// therefore knows it is in offline mode before it asks for anything.
// ---------------------------------------------------------------------------

let modePromise = null;

function getMode() {
  if (!modePromise) modePromise = readMode();
  return modePromise;
}

async function readMode() {
  try {
    const cache = await caches.open(CACHE_META);
    const hit = await cache.match(MODE_KEY);
    if (hit && (await hit.text()).trim() === 'offline') return 'offline';
  } catch (_) {
    /* fall through */
  }
  return 'online';
}

async function writeMode(mode) {
  const m = mode === 'offline' ? 'offline' : 'online';
  modePromise = Promise.resolve(m);
  try {
    const cache = await caches.open(CACHE_META);
    await cache.put(MODE_KEY, new Response(m, { headers: { 'content-type': 'text/plain' } }));
  } catch (_) {
    /* storage unavailable — in-memory mode still applies for this worker */
  }
  return m;
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const reply = async (msg) => {
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(msg);
    } else {
      const all = await self.clients.matchAll({ includeUncontrolled: true });
      for (const c of all) c.postMessage(msg);
    }
  };
  if (data.type === 'SET_MODE') {
    event.waitUntil(
      (async () => {
        const m = await writeMode(data.mode);
        await reply({ type: 'MODE_SET', mode: m });
      })()
    );
    return;
  }
  if (data.type === 'GET_MODE') {
    event.waitUntil(getMode().then((m) => reply({ type: 'MODE_IS', mode: m })));
    return;
  }
  if (data.type === 'CLEAR_ALL') {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('darth-')).map((n) => caches.delete(n)));
        // The wipe removed the mode flag too: a signed-out browser is online.
        modePromise = Promise.resolve('online');
        // The wipe also removed the /offline fallback; without re-priming it
        // the next failed navigation gets the inline 503 until the SW is
        // next re-installed (a sign-out followed by a flight).
        await precacheOfflinePage();
        await reply({ type: 'CLEARED' });
      })()
    );
  }
});

// ---------------------------------------------------------------------------
// Background Sync — the offline activity outbox (src/lib/offline/
// offline-outbox.ts registers OUTBOX_SYNC_TAG after every write). Chrome
// fires 'sync' once the network is back, tab open or not; the worker reads
// the IndexedDB 'outbox' store the page filled and POSTs it with the same
// wire format the page uses. Both may flush at once — the server dedupes on
// each row's `key`, and deleting an already-deleted key is a no-op.
// Browsers without Background Sync never fire this; the page flushes then.
// ---------------------------------------------------------------------------

const IDB_NAME = 'darth-offline';
const OUTBOX_STORE = 'outbox';
const OUTBOX_URL = '/api/offline/outbox';
const OUTBOX_SYNC_TAG = 'darth-outbox';
const OUTBOX_BATCH = 200;

self.addEventListener('sync', (event) => {
  if (event.tag !== OUTBOX_SYNC_TAG) return;
  event.waitUntil(flushOutboxFromWorker().catch((err) => console.warn('[sw] outbox flush failed', err)));
});

function openOutboxDb() {
  return new Promise((resolve, reject) => {
    // Version-less open: never upgrade from the worker — the page owns the
    // schema. A db that predates the store simply yields nothing to send.
    const req = indexedDB.open(IDB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

async function flushOutboxFromWorker() {
  const db = await openOutboxDb();
  try {
    if (!db.objectStoreNames.contains(OUTBOX_STORE)) return;
    const rows = await idbRequest(db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).getAll());
    if (!rows || rows.length === 0) return;
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (let i = 0; i < rows.length; i += OUTBOX_BATCH) {
      const batch = rows.slice(i, i + OUTBOX_BATCH);
      const res = await fetch(OUTBOX_URL, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
      let drop;
      if (res.status === 400) {
        drop = batch.map((r) => r.key); // contract mismatch: never retry these
      } else if (!res.ok) {
        // 401/403/5xx: keep everything and let Chrome retry the sync later.
        throw new Error(`outbox → ${res.status}`);
      } else {
        const body = await res.json();
        drop = [].concat(body.accepted || [], (body.rejected || []).map((r) => r && r.key)).filter(Boolean);
      }
      if (drop.length > 0) {
        const tx = db.transaction(OUTBOX_STORE, 'readwrite');
        const store = tx.objectStore(OUTBOX_STORE);
        for (const k of drop) store.delete(k);
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
      }
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  // SSE and the worker script itself: never touched.
  if (path === '/api/events' || path.startsWith('/api/events/') || path === '/sw.js') return;

  // The page's own probe + sync fetches (`cache: 'no-store'`) must see the
  // REAL network outcome in every mode: the health probe is how the app
  // learns the connection is back, and a sync answered from the cache would
  // re-store the stale body under the new rev. They carry their own caps.
  if (isSyncFetch(request)) {
    event.respondWith(networkOnly(request));
    return;
  }

  event.respondWith(route(request, url, path));
});

async function route(request, url, path) {
  const mode = await getMode();
  const offline = mode === 'offline';

  if (path.startsWith('/_next/static/')) return staticAsset(request, offline);
  if (request.mode === 'navigate') return navigation(request, url, offline);
  if (isRscFetch(request, url)) return rscFetch(request, url, offline);
  if (AUDIO_RE.test(path)) return media(request, url, offline);
  if (FRAME_RE.test(path)) return frame(request, offline);
  if (path.startsWith('/api/')) return api(request, url, offline);
  return other(request, offline);
}

function isSyncFetch(request) {
  return request.cache === 'no-store';
}

/** Next's client router fetching a page's flight payload (link click / prefetch). */
function isRscFetch(request, url) {
  return request.headers.get('RSC') === '1' || url.searchParams.has('_rsc');
}

function storable(res) {
  return !!res && res.ok && res.status < 300 && res.type !== 'opaqueredirect' && !res.redirected;
}

function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return offlineResponse(request);
  }
}

// ---------------------------------------------------------------------------
// Strategies. Each takes `offline` (the MODE, not connectivity) and follows
// the same two rules:
//   offline → cache only; a miss is an instant 503 (or the /offline page).
//   online  → cached copy exists: network raced against NET_TIMEOUT_MS, the
//             copy on timeout/failure/5xx; no copy: plain network.
// ---------------------------------------------------------------------------

/** Content-hashed chunks: cache-first always. A miss while offline still gets one capped try — a missing lazy chunk breaks the page either way. */
async function staticAsset(request, offline) {
  const cache = await caches.open(CACHE_STATIC);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    const res = offline ? await fetchWithTimeout(request, NET_TIMEOUT_MS) : await fetch(request);
    if (storable(res)) cache.put(request.url, res.clone()).catch(() => undefined);
    return res;
  } catch (err) {
    return offlineResponse(request);
  }
}

/**
 * Documents. Cached under their pathname (query ignored — the PWA launches
 * with `/?…`, calendar deep-links carry params).
 */
async function navigation(request, url, offline) {
  const pages = await caches.open(CACHE_PAGES);
  const cached = await pages.match(url.pathname, { ignoreSearch: true });

  if (offline) {
    if (cached) return cached;
    return offlineDocument(pages);
  }

  if (cached) {
    try {
      // A navigate-mode Request cannot be re-issued with a RequestInit
      // (the signal), so rebuild it: same URL + cookies, redirects left to
      // the browser (an opaqueredirect is returned as-is and followed —
      // the darth-auth bounce for a dead session keeps working).
      const res = await fetchWithTimeout(
        new Request(url.href, {
          credentials: 'include',
          redirect: 'manual',
          headers: { accept: request.headers.get('accept') || 'text/html' },
        }),
        NET_TIMEOUT_MS
      );
      // A 5xx from nginx (deploy window) is not a better answer than the copy.
      if (res.status >= 500) return cached;
      return res;
    } catch (err) {
      return cached;
    }
  }
  try {
    return await fetch(request);
  } catch (err) {
    return offlineDocument(pages);
  }
}

async function offlineDocument(pages) {
  const fallback = await pages.match(OFFLINE_PAGE, { ignoreSearch: true });
  if (fallback) return fallback;
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">' +
      '<h1 style="font-size:1.25rem">This page isn\'t saved for offline use</h1>' +
      '<p>Reconnect, or open a meeting you saved for offline from the <a href="/">home page</a>.</p></body>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

/**
 * Flight payloads for client-side navigations. The sync stores one full
 * payload per cached page under `<pathname>?__rsc=1` (fetched without a
 * router state tree, so it is complete). Served from the cache the click
 * stays a single-page transition; a miss returns the offline 503, which
 * Next treats as "not a flight response" and turns into a document
 * navigation — answered by `navigation()` above. Prefetches and clicks the
 * worker sees online are never stored: the server tailors them to the
 * client's current tree, so they are not reusable.
 */
async function rscFetch(request, url, offline) {
  const cache = await caches.open(CACHE_API);
  const cached = await cache.match(url.pathname + RSC_SUFFIX);
  if (offline) return cached || offlineResponse(request);
  if (!cached) return networkOnly(request);
  try {
    const res = await fetchWithTimeout(request, NET_TIMEOUT_MS);
    if (res.status >= 500) return cached;
    return res;
  } catch (err) {
    return cached;
  }
}

/** API JSON. Keys are exact path+query. */
async function api(request, url, offline) {
  const cache = await caches.open(CACHE_API);
  const key = url.pathname + url.search;
  const cached = await cache.match(key);
  if (offline) return cached || offlineResponse(request);
  if (!cached) return networkOnly(request);
  try {
    const res = await fetchWithTimeout(request, NET_TIMEOUT_MS);
    if (storable(res)) {
      cache.put(key, res.clone()).catch(() => undefined);
      return res;
    }
    // 401/403/404 while online: the server's word beats a stale copy —
    // except a 5xx, where the copy is still the better answer.
    if (res.status >= 500) return cached;
    return res;
  } catch (err) {
    return cached;
  }
}

/** Frame jpgs are immutable per millisecond offset: cache-first, never re-stored. */
async function frame(request, offline) {
  const cache = await caches.open(CACHE_API);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  if (offline) return offlineResponse(request);
  return networkOnly(request);
}

/** Anything else same-origin (favicon, manifest, icons): network, then any cached copy. */
async function other(request, offline) {
  if (offline) {
    const hit = await caches.match(request.url);
    return hit || offlineResponse(request);
  }
  try {
    return await fetch(request);
  } catch (err) {
    const hit = await caches.match(request.url);
    return hit || offlineResponse(request);
  }
}

function offlineResponse(request) {
  const accept = request.headers.get('accept') || '';
  if (request.destination === '' || accept.includes('application/json') || new URL(request.url).pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'offline', offline: true }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  return new Response('', { status: 503, headers: { 'cache-control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// Media: cached bodies are served even when online (the player never
// re-streams a recording we already hold), with Range support so seeking
// works. Not cached → plain network passthrough (instant 503 offline).
// ---------------------------------------------------------------------------

async function media(request, url, offline) {
  const cache = await caches.open(CACHE_MEDIA);
  const key = url.pathname + url.search;
  const cached = await cache.match(key);
  if (!cached) return offline ? offlineResponse(request) : networkOnly(request);
  return rangeResponse(cached, request.headers.get('range'));
}

/**
 * Slice a cached full-body response for a Range request. Supports
 * bytes=START-, bytes=START-END and bytes=-SUFFIX; multi-range → 416.
 */
async function rangeResponse(cached, rangeHeader) {
  const blob = await cached.blob();
  const total = blob.size;
  const type = cached.headers.get('content-type') || 'application/octet-stream';
  const baseHeaders = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
  };

  if (!rangeHeader) {
    return new Response(blob, { status: 200, headers: { ...baseHeaders, 'content-length': String(total) } });
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${total}` } });
  }
  let start;
  let end;
  if (m[1] === '') {
    // bytes=-SUFFIX
    const suffix = Number.parseInt(m[2], 10);
    if (suffix <= 0) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${total}` } });
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number.parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : Math.min(Number.parseInt(m[2], 10), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${total}` } });
  }
  const part = blob.slice(start, end + 1);
  return new Response(part, {
    status: 206,
    headers: {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': String(end - start + 1),
    },
  });
}
