/* eslint-disable */
/**
 * Kill-switch, delete after one release (2026-10).
 *
 * The web offline mode / PWA was removed on 2026-10-02 (README "Offline and
 * PWA — removed 2026-10-02"); offline now lives only in the Darth desktop
 * shell. Browsers that installed the old offline worker keep running it
 * until an update check of /sw.js succeeds — a 404 leaves the old worker in
 * charge, and the old worker in offline mode served cache-only, so new page
 * code would never load. This file replaces it once:
 *
 *   install  → skipWaiting (take over without waiting for tabs to close)
 *   activate → delete every `darth-*` cache, unregister this worker, then
 *              reload every open window from the network
 *
 * There is deliberately NO fetch handler: while this worker is active every
 * request goes straight to the network.
 *
 * The page side does the same for pages no worker controls
 * (src/components/sw-cleanup.tsx). Delete both after one release.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('darth-')).map((n) => caches.delete(n)));
      } catch (e) {
        /* best effort */
      }
      try {
        await self.registration.unregister();
      } catch (e) {
        /* best effort */
      }
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        await Promise.all(clients.map((client) => client.navigate(client.url).catch(() => {})));
      } catch (e) {
        /* best effort */
      }
    })(),
  );
});
