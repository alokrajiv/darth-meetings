/**
 * The Darth desktop shell's offline surface, as Meetings uses it (desktop
 * docs/OFFLINE.md §1–§3 and plans/offline/2026-10-22-shell-offline-cache-
 * contract.md "App side"). Browser only; everything is feature-detected and
 * nothing here throws.
 *
 *   window.darthDesktop.store         the per-app SQLite bridge (replica-db.ts)
 *   window.darthDesktop.connectivity  .get() → { state, online, reason }
 *   'darth-shell:connectivity'        the same detail on every change (+ once per load)
 *   window.darthDesktop.offlineCache  { has(urls), list(), warm(urls) } (shell 0.5.0)
 *
 * On the web (no `darthDesktop`) the state stays `null` ("no shell") and the
 * app behaves exactly as before: there is no web offline mode.
 */

import { useSyncExternalStore } from 'react';

export type ShellConnectivityState = 'online' | 'offline-network' | 'offline-manual';

export const CONNECTIVITY_EVENT = 'darth-shell:connectivity';

/** The state a connectivity detail (event detail or `get()` answer) carries,
 * or null when it is not the contract's shape (an `{error}` answer too). Pure. */
export function connectivityStateOf(detail: unknown): ShellConnectivityState | null {
  if (!detail || typeof detail !== 'object' || 'error' in detail) return null;
  const s = (detail as { state?: unknown }).state;
  return s === 'online' || s === 'offline-network' || s === 'offline-manual' ? s : null;
}

/** True for the two offline states; false for online and for "no shell". Pure. */
export function isOfflineState(state: ShellConnectivityState | null): boolean {
  return state === 'offline-network' || state === 'offline-manual';
}

type ConnectivityApi = { get?: () => Promise<unknown> };
type OfflineCacheApi = {
  has?: (urls: string[]) => Promise<unknown>;
  list?: () => Promise<unknown>;
  warm?: (urls: string[]) => Promise<unknown>;
};
type ShellWindow = {
  darthDesktop?: {
    store?: unknown;
    connectivity?: ConnectivityApi;
    offlineCache?: OfflineCacheApi;
  };
};

function shellOf(win?: unknown): ShellWindow['darthDesktop'] | undefined {
  const w = (win ?? (typeof window === 'undefined' ? undefined : window)) as ShellWindow | undefined;
  return w?.darthDesktop;
}

// ---- Connectivity: one module-level reading, shared by every hook ---------

let current: ShellConnectivityState | null = null;
const listeners = new Set<() => void>();
let subscribed = false;

function publish(next: ShellConnectivityState | null): void {
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn();
}

function ensureSubscribed(): void {
  if (subscribed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  subscribed = true;
  window.addEventListener(CONNECTIVITY_EVENT, (e) => {
    const s = connectivityStateOf((e as CustomEvent<unknown>).detail);
    if (s) publish(s);
  });
  // The shell sends the event once after every load; ask anyway (this
  // listener may attach after it fired).
  try {
    const get = shellOf()?.connectivity?.get;
    if (typeof get === 'function') {
      Promise.resolve(get.call(shellOf()!.connectivity))
        .then((d) => {
          const s = connectivityStateOf(d);
          if (s) publish(s);
        })
        .catch(() => {});
    }
  } catch {
    /* an old shell without connectivity: stays null */
  }
}

/** The shell's last reported state; null outside the shell (or before the
 * first reading). */
export function shellConnectivity(): ShellConnectivityState | null {
  ensureSubscribed();
  return current;
}

/** True while the shell says the app is offline (Work Offline or no network). */
export function isShellOffline(): boolean {
  return isOfflineState(shellConnectivity());
}

/** Subscribe to connectivity changes; returns the unsubscribe. */
export function onShellConnectivity(fn: () => void): () => void {
  ensureSubscribed();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: set the reading as if the shell had sent it. */
export function setShellConnectivityForTests(state: ShellConnectivityState | null): void {
  publish(state);
}

/** The shell's state, live (null on the web and on the server). */
export function useShellConnectivity(): ShellConnectivityState | null {
  return useSyncExternalStore(onShellConnectivity, shellConnectivity, () => null);
}

/** True while the shell says offline. Always false on the web / at SSR. */
export function useShellOffline(): boolean {
  return isOfflineState(useShellConnectivity());
}

// ---- The shell's page cache (contract §5) ---------------------------------

/** The meeting page URL the shell caches (hash-free, absolute). Pure. */
export function meetingPageUrl(origin: string, id: string): string {
  return `${origin}/transcript/${encodeURIComponent(id)}`;
}

/** Ask the shell to keep these page documents + flights on disk. Resolves to
 * how many it queued (0 on the web, an older shell, offline, or any error). */
export async function warmPages(urls: string[], win?: unknown): Promise<number> {
  try {
    const cache = shellOf(win)?.offlineCache;
    if (!cache || typeof cache.warm !== 'function' || urls.length === 0) return 0;
    const r = (await cache.warm.call(cache, urls.slice(0, 200))) as { queued?: unknown } | null;
    return r && typeof r.queued === 'number' ? r.queued : 0;
  } catch {
    return 0;
  }
}
