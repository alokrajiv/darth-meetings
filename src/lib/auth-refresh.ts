// Client-side session guard.
//
// The `darth_session` cookie is an opaque darth-auth session (30 days, no
// refresh dance — the kenoby JWT refresh path was removed 2026-09-13). When a
// same-origin /api/* call returns 401 the session is gone (expired, revoked
// by an admin, user disabled): bounce ONCE to /login?returnTo=…, which
// forwards to darth-auth's login and lands the user back here.
//
// Design: wrap window.fetch ONCE (installed by <SessionKeeper /> in the root
// layout). Deliberately NOT intercepted:
//  - anything under /api/auth/* (diagnostics that 401 by design),
//  - cross-origin calls (Google APIs get 401s that mean something else).
// 403 is never touched — that is "no access" (module missing or read-only
// token), which the page surfaces itself.

let installed = false;
let redirecting = false;

function redirectToLogin(): void {
  if (redirecting) return;
  redirecting = true;
  const here = window.location.pathname + window.location.search;
  const qs = here !== '/' ? `?returnTo=${encodeURIComponent(here)}` : '';
  window.location.href = `/login${qs}`;
}

function interceptable(input: RequestInfo | URL): boolean {
  let url: URL;
  try {
    const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
    url = new URL(raw, window.location.origin);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  if (!url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/api/auth/')) return false;
  return true;
}

/** Idempotent. Wraps window.fetch; safe to call from module scope + effects. */
export function installAuthFetchGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const origFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await origFetch(input, init);
    if (res.status === 401 && !redirecting && interceptable(input)) {
      redirectToLogin();
    }
    return res;
  };
}
