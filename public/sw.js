/* eslint-disable */
/**
 * Darth Meetings service worker — offline support.
 *
 * A deliberately dumb router: it never decides WHAT to keep offline (the
 * page does that through src/lib/offline/*, which fills the caches with
 * the user's cookies and normal devtools visibility). The worker only
 * answers "is this URL in one of our caches, and how should it be served?"
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
const CURRENT_CACHES = [CACHE_PAGES, CACHE_API, CACHE_MEDIA, CACHE_STATIC];

const OFFLINE_PAGE = '/offline';
const API_TIMEOUT_MS = 8000;

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
    const res = await fetch(OFFLINE_PAGE, { credentials: 'include', headers: { accept: 'text/html' } });
    if (res.ok && !res.redirected && /text\/html/i.test(res.headers.get('content-type') || '')) {
      const cache = await caches.open(CACHE_PAGES);
      await cache.put(OFFLINE_PAGE, res);
    }
  } catch (_) {
    /* offline at activate time — the page caches it on the next sync */
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CLEAR_ALL') {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('darth-')).map((n) => caches.delete(n)));
        const reply = { type: 'CLEARED' };
        if (event.source && typeof event.source.postMessage === 'function') {
          event.source.postMessage(reply);
        } else {
          const all = await self.clients.matchAll({ includeUncontrolled: true });
          for (const c of all) c.postMessage(reply);
        }
      })()
    );
  }
});

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

  if (path.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(CACHE_STATIC, request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request, url));
    return;
  }

  if (AUDIO_RE.test(path)) {
    event.respondWith(handleMedia(request, url));
    return;
  }

  if (FRAME_RE.test(path)) {
    // Frame jpgs are immutable per millisecond offset.
    event.respondWith(cacheFirst(CACHE_API, request, false));
    return;
  }

  if (path.startsWith('/api/')) {
    event.respondWith(handleApi(request, url));
    return;
  }

  event.respondWith(networkThenCache(request));
});

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

function storable(res) {
  return !!res && res.ok && res.status < 300 && res.type !== 'opaqueredirect' && !res.redirected;
}

/** Cache hit wins; otherwise network, stored on success (unless `put` is false). */
async function cacheFirst(cacheName, request, put = true) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (put && storable(res)) {
      cache.put(request.url, res.clone()).catch(() => undefined);
    }
    return res;
  } catch (err) {
    return offlineResponse(request);
  }
}

/**
 * The page's own offline sync fetches with `cache: 'no-store'` (it is
 * refreshing the copy we hold). Those must see the REAL network outcome:
 * answering them from the cache on a timeout/5xx would make the sync
 * re-store the stale body and stamp it with the new rev, so the edit is
 * never fetched again. Ordinary page fetches keep their fallbacks.
 */
function isSyncFetch(request) {
  return request.cache === 'no-store';
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return offlineResponse(request);
  }
}

/** Network; on failure the exact cached URL if any. */
async function networkThenCache(request) {
  if (isSyncFetch(request)) return networkOnly(request);
  try {
    return await fetch(request);
  } catch (err) {
    const hit = await caches.match(request.url);
    return hit || offlineResponse(request);
  }
}

/**
 * Documents: network-first so an online visit is always fresh; offline →
 * the cached document for this pathname (query ignored), else the
 * /offline fallback, else an inline 503.
 */
async function handleNavigation(request, url) {
  try {
    const res = await fetch(request);
    return res;
  } catch (err) {
    const pages = await caches.open(CACHE_PAGES);
    const hit = await pages.match(url.pathname, { ignoreSearch: true });
    if (hit) return hit;
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
}

/**
 * API JSON: if we hold a copy, network-first with a timeout and refresh
 * the copy; offline (or slow) → the copy. Not held → network, and a
 * uniform 503 { offline: true } when that fails so pages can tell "offline"
 * from a server error.
 */
async function handleApi(request, url) {
  if (isSyncFetch(request)) return networkOnly(request);
  const cache = await caches.open(CACHE_API);
  const key = url.pathname + url.search;
  const cached = await cache.match(key);
  if (!cached) return networkOnly(request);
  try {
    const res = await fetchWithTimeout(request, API_TIMEOUT_MS);
    if (storable(res)) {
      cache.put(key, res.clone()).catch(() => undefined);
      return res;
    }
    // 401/403/404/5xx while online: the server's word beats a stale copy —
    // except a network-ish 5xx, where the copy is still the better answer.
    if (res.status >= 500) return cached;
    return res;
  } catch (err) {
    return cached;
  }
}

function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
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
// works. Not cached → plain network passthrough.
// ---------------------------------------------------------------------------

async function handleMedia(request, url) {
  const cache = await caches.open(CACHE_MEDIA);
  const key = url.pathname + url.search;
  const cached = await cache.match(key);
  if (!cached) {
    try {
      return await fetch(request);
    } catch (err) {
      return offlineResponse(request);
    }
  }
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
