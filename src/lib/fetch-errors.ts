/**
 * Fetch-error helpers for client call sites. Dep-free.
 *
 * `fetch()` rejects with a TypeError only when the request never reached a
 * server (no network, DNS, connection reset); every HTTP status resolves.
 * These helpers turn that one rejection into readable copy and pass any
 * other error's message through.
 */

export const NETWORK_ERROR_MESSAGE = "Can't reach Darth Meetings — check your connection.";

export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

/** Message for a catch block: network failure → NETWORK_ERROR_MESSAGE, else the error's message (or fallback). */
export function networkErrorMessage(err: unknown, fallback: string): string {
  if (isNetworkFailure(err)) return NETWORK_ERROR_MESSAGE;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
