'use client';

import { useEffect } from 'react';

/**
 * One-release cleanup of the removed web offline mode (2026-10-02).
 * REMOVE AFTER ONE RELEASE (2026-10), together with the kill-switch
 * public/sw.js.
 *
 * Browsers that used the old PWA still hold its service worker, its
 * `darth-*` Cache Storage caches, the `darth-offline` IndexedDB pin ledger
 * and the `darth-offline-mode` localStorage key. Once on mount this
 * unregisters every worker on this origin and deletes all of that. Every
 * step is feature-detected and guarded, silent, and never blocks render.
 * (The kill-switch sw.js does the same from the worker side for pages that
 * the old worker still controls.)
 */
export function SwCleanup() {
  useEffect(() => {
    try {
      navigator.serviceWorker
        ?.getRegistrations()
        .then((rs) => rs.forEach((r) => void r.unregister().catch(() => {})))
        .catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      if (typeof caches !== 'undefined') {
        caches
          .keys()
          .then((names) => names.filter((n) => n.startsWith('darth-')).forEach((n) => void caches.delete(n).catch(() => {})))
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
    try {
      if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('darth-offline');
    } catch {
      /* ignore */
    }
    try {
      localStorage.removeItem('darth-offline-mode');
    } catch {
      /* ignore */
    }
  }, []);
  return null;
}
