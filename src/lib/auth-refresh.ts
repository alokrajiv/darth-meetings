// Client-side session self-heal.
//
// The trames-auth-session JWT lives 24h but its cookie lives 30d, so after a
// day every /api/* call starts 401ing while the page itself still renders —
// the "Retry loop". kenoby-sso owns the Cognito refresh token (encrypted,
// httpOnly, .trames.io) and exposes POST /api/auth/refresh; kyloren has done
// this exact cross-origin call from app.trames.io in prod for ages
// (src/services/ssoAxios.ts there). We are the second consumer.
//
// Design: wrap window.fetch ONCE (installed by <SessionKeeper /> in the root
// layout). On a 401 from a same-origin /api/ call, run a single-flight
// refresh against login.trames.io and replay the original request one time.
// If the refresh itself fails (refresh token dead / cookies wiped), bounce to
// /login?returnTo=… which re-enters the SSO flow.
//
// Deliberately NOT intercepted:
//  - anything under /api/auth/* (would recurse the login check),
//  - cross-origin calls (Google APIs get 401s that mean something else),
//  - Request-object inputs and ReadableStream bodies (not safely replayable;
//    the multi-GB upload path uses XHR anyway, so it never comes through here).

const SSO_BASE = process.env.NEXT_PUBLIC_SSO_LOGIN_URL || 'https://login.trames.io';

/** A 401 arriving within this window of a successful refresh is real
 * (access revoked, row-level denial…) — don't refresh-loop on it. */
const REFRESH_COOLDOWN_MS = 5_000;

let installed = false;
let refreshPromise: Promise<boolean> | null = null;
let lastRefreshOkAt = 0;
let redirecting = false;

/** Single-flight: concurrent 401s share one refresh round-trip. */
function refreshSession(fetchImpl: typeof fetch): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        // Same-site (both under trames.io) so the Lax cookies ride along;
        // kenoby echoes our exact origin with allow-credentials, so the
        // rotated Set-Cookie lands on .trames.io for us to use immediately.
        const res = await fetchImpl(`${SSO_BASE}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

function redirectToLogin(): void {
  if (redirecting) return;
  redirecting = true;
  const here = window.location.pathname + window.location.search;
  const qs = here !== '/' ? `?returnTo=${encodeURIComponent(here)}` : '';
  window.location.href = `/login${qs}`;
}

function interceptable(input: RequestInfo | URL, init: RequestInit | undefined): URL | null {
  // Request objects may carry one-shot bodies; skip rather than half-replay.
  if (typeof input !== 'string' && !(input instanceof URL)) return null;
  if (init?.body instanceof ReadableStream) return null;
  let url: URL;
  try {
    url = new URL(input, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (!url.pathname.startsWith('/api/')) return null;
  if (url.pathname.startsWith('/api/auth/')) return null;
  return url;
}

/** Idempotent. Wraps window.fetch; safe to call from module scope + effects. */
export function installAuthFetchGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const origFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await origFetch(input, init);
    if (res.status !== 401 || redirecting) return res;
    if (!interceptable(input, init)) return res;
    if (Date.now() - lastRefreshOkAt < REFRESH_COOLDOWN_MS) return res;

    const ok = await refreshSession(origFetch);
    if (!ok) {
      redirectToLogin();
      return res;
    }
    lastRefreshOkAt = Date.now();
    // Replay exactly once; if it still 401s the caller sees that as-is.
    return origFetch(input, init);
  };
}
