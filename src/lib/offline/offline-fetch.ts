import { OFFLINE_TITLE } from './offline-types';

/**
 * Offline-aware error helpers for fetch call sites. Dep-free.
 *
 * - `isNetworkFailure(err)`: fetch rejects with a TypeError when the network
 *   is down (or the service worker has no answer) — the only rejection a
 *   plain `fetch()` produces on its own.
 * - `offlineAwareError(res, fallback)`: the service worker answers every
 *   un-pinned GET with `503 { error: 'offline', offline: true }` while the
 *   app is in offline mode; that must read "Not available offline", not
 *   "(503)".
 */

export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

export async function offlineAwareError(res: Response, fallback: string): Promise<Error> {
  if (res.status === 503) {
    try {
      const body = (await res.clone().json()) as { offline?: unknown } | null;
      if (body && body.offline === true) return new Error(OFFLINE_TITLE);
    } catch {
      /* not JSON — fall through */
    }
  }
  return new Error(fallback);
}

/** Message for a catch block: network failure → OFFLINE_TITLE, else the error's message (or fallback). */
export function offlineErrorMessage(err: unknown, fallback: string): string {
  if (isNetworkFailure(err)) return OFFLINE_TITLE;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
