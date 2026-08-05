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

  return NextResponse.next();
}

export const config = {
  // `api/transcripts$` (the upload endpoint, exact match — subpaths still
  // proxied) is excluded on purpose: when the proxy matches a route, Next
  // buffers the whole request body in memory to enforce
  // proxyClientMaxBodySize, which defeats the route's streaming upload and
  // blows up RAM on multi-GB files. The route is still fully protected —
  // withAuth verifies the session before the body is ever read.
  matcher: ['/((?!api/transcripts$|_next/static|_next/image|favicon.ico).*)'],
};
