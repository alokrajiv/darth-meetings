import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Cookie presence check.
 *
 * We can't verify the JWT signature here — middleware runs on the Edge runtime
 * and `jsonwebtoken` + `crypto.createPublicKey` aren't available. Full
 * validation happens inside route handlers via `withAuth` / `getCurrentUser`.
 */
function hasSSOSession(request: NextRequest): boolean {
  return !!request.cookies.get('trames-auth-session')?.value;
}

/** Decode (NOT verify) the JWT's exp claim. Edge-safe: atob + JSON only.
 * Returns null when the token doesn't parse — callers must fail open and let
 * withAuth do the real verification. */
function jwtExpMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Top-level page navigation (address bar, link click, reload) — the only
 * requests we bounce through the SSO refresh redirect. RSC/prefetch fetches
 * must NOT be redirected cross-origin (their CORS mode can't follow it);
 * they fall through and the client fetch guard heals the session instead. */
function isDocumentNav(request: NextRequest): boolean {
  if (request.method !== 'GET') return false;
  const dest = request.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  // Old browsers without sec-fetch-*: accept-header heuristic, RSC excluded.
  return (
    !request.headers.get('rsc') &&
    (request.headers.get('accept') ?? '').includes('text/html')
  );
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Public routes — no auth required
  if (
    pathname === '/login' ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/public/') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // Protected API routes — 401 if no cookie. darth-cli bearer tokens (dth_…)
  // pass through on header *presence* only — the proxy runs on Edge, so real
  // introspection happens in withAuth; an invalid token still 401s there.
  if (pathname.startsWith('/api/')) {
    const authz = request.headers.get('authorization') || '';
    if (/^Bearer\s+dth_/.test(authz)) {
      return NextResponse.next();
    }
    if (!hasSSOSession(request)) {
      return NextResponse.json(
        { error: 'Unauthorized - No session found' },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // Everything else (including `/` and `/transcript/[id]`) requires auth.
  // Redirect to /login with a returnTo, which in turn will bounce to the SSO.
  if (!hasSSOSession(request)) {
    const loginUrl = new URL('/login', request.url);
    const returnTo = request.nextUrl.pathname + request.nextUrl.search;
    if (returnTo !== '/') {
      loginUrl.searchParams.set('returnTo', returnTo);
    }
    return NextResponse.redirect(loginUrl);
  }

  // Cookie present but JWT expired (24h life vs the cookie's 30d): silently
  // rotate via kenoby-sso and land back here — no 401 flash, no Retry loop.
  // The refresh route whitelists *.trames.io returnTo values; on a dead
  // refresh token it wipes the cookies and forwards to the SSO login itself,
  // so there is no loop through this branch. Document navigations only.
  if (isDocumentNav(request)) {
    const token = request.cookies.get('trames-auth-session')!.value;
    const expMs = jwtExpMs(token);
    if (expMs !== null && expMs <= Date.now()) {
      const sso = process.env.NEXT_PUBLIC_SSO_LOGIN_URL || 'https://login.trames.io';
      const refreshUrl = new URL('/api/auth/refresh', sso);
      // request.url reflects the INTERNAL origin behind nginx
      // (https://localhost:3002/...) — build returnTo from the forwarded
      // public host or kenoby bounces the user to localhost.
      const host =
        request.headers.get('x-forwarded-host') ?? request.headers.get('host');
      const proto = request.headers.get('x-forwarded-proto') ?? 'https';
      const returnTo = host
        ? `${proto}://${host}${request.nextUrl.pathname}${request.nextUrl.search}`
        : request.url;
      refreshUrl.searchParams.set('returnTo', returnTo);
      return NextResponse.redirect(refreshUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  // `api/transcripts$` (the upload endpoint, exact match — subpaths still
  // proxied) is excluded on purpose: when the proxy matches a route, Next
  // buffers the whole request body in memory to enforce
  // proxyClientMaxBodySize, which defeats the route's streaming upload and
  // blows up RAM on multi-GB files. The route is still fully protected —
  // withAuth verifies the session before the body is ever read. Same for
  // the chunked-upload family under `api/uploads` — chunks are 4–8MB raw
  // bodies arriving 4 at a time; buffering them in the proxy would double
  // the copies and serialize the positional writes.
  matcher: ['/((?!api/transcripts$|api/uploads(?:/|$)|_next/static|_next/image|favicon.ico).*)'],
};
