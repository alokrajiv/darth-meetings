import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getDarthBearer,
  hasMeetingsAccess,
  isSessionValue,
  resolveDarthToken,
  NO_ACCESS_MESSAGE,
} from '@/lib/auth/cli-auth';
import { SESSION_COOKIE } from '@/lib/auth/session';
import { publicOrigin } from '@/lib/auth/public-origin';

/**
 * Edge gate (SPEC §3 + §4.2).
 *
 * Every matched request is verified against darth-auth introspection — the
 * `darth_session` cookie (opaque `dss_…`) or a `Bearer dth_…` — through the
 * shared 60 s cache, and must carry the `meetings` module. The proxy runs on
 * the Node runtime in Next 16 so the loopback hop is fine here; route handlers
 * re-verify inside `withAuth` (same cache), which also covers the streaming
 * routes excluded from the matcher below.
 *
 * Outcomes: no/invalid credential → API/XHR 401 JSON, document navigation
 * 302 to darth-auth login with an absolute returnTo; valid but no `meetings`
 * module → 403 (JSON or page). RSC/prefetch fetches are never redirected
 * cross-origin (their CORS mode can't follow it) — they get the 401 and the
 * Next router falls back to a browser navigation, which is then redirected.
 */

const AUTH_URL = (process.env.DARTH_AUTH_URL || 'https://auth.darth-internal.trames.io').replace(/\/+$/, '');

/** Top-level page navigation (address bar, link click, reload). */
function isDocumentNav(request: NextRequest): boolean {
  if (request.method !== 'GET') return false;
  const dest = request.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  // Old browsers / curl without sec-fetch-*: accept-header heuristic, RSC excluded.
  return (
    !request.headers.get('rsc') &&
    !request.nextUrl.searchParams.has('_rsc') &&
    (request.headers.get('accept') ?? '').includes('text/html')
  );
}

function wantsJson(request: NextRequest): boolean {
  return (
    request.nextUrl.pathname.startsWith('/api/') ||
    (request.headers.get('accept') ?? '').includes('application/json') ||
    !isDocumentNav(request)
  );
}

/** Absolute public URL of the current request — request.url reflects the
 * INTERNAL origin behind nginx (localhost:3002), so build it from the public
 * origin (`Host` + nginx's X-Forwarded-Proto, see `public-origin.ts`) or
 * darth-auth bounces the user to localhost. */
function publicUrl(request: NextRequest, path?: string): string {
  const p = path ?? request.nextUrl.pathname + request.nextUrl.search;
  return new URL(p, publicOrigin(request)).toString();
}

function loginRedirect(request: NextRequest) {
  const login = new URL('/login', AUTH_URL);
  login.searchParams.set('returnTo', publicUrl(request));
  return NextResponse.redirect(login, 302);
}

function unauthorized(message: string) {
  return NextResponse.json({ error: message }, { status: 401 });
}

function noAccess(request: NextRequest) {
  if (wantsJson(request)) return NextResponse.json({ error: NO_ACCESS_MESSAGE }, { status: 403 });
  const logout = `${AUTH_URL}/logout?returnTo=${encodeURIComponent(publicUrl(request, '/'))}`;
  const html = `<!doctype html><meta charset="utf-8"><title>No access · Darth Meetings</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#111}main{max-width:32rem;padding:2rem;border:1px solid #ddd;border-radius:12px;background:#fff}a{color:#2563eb}</style>
<main><h1 style="font-size:1.25rem;margin:0 0 .5rem">No access to Darth Meetings</h1>
<p>Your darth account is signed in but does not hold the <code>meetings</code> module.
Ask a darth admin at <a href="https://admin.darth-internal.trames.io">admin.darth-internal.trames.io</a>.</p>
<p><a href="${logout}">Sign out</a></p></main>`;
  return new NextResponse(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Public routes — no auth required. /login and /logout only bounce to
  // darth-auth; /api/auth/* are self-gated diagnostics. The service worker,
  // manifest, icons and the static /offline fallback carry nothing
  // user-specific and must be fetchable without a session (the SW precaches
  // /offline at activate time, browsers fetch the manifest cookie-less).
  if (
    pathname === '/login' ||
    pathname === '/logout' ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/health' ||
    pathname === '/favicon.ico' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/icons/') ||
    pathname === '/offline'
  ) {
    return NextResponse.next();
  }

  // 1. Bearer (darth-cli dth_ / app dapp_) beats the cookie; an invalid token
  //    is a hard 401 and never falls through to cookie auth.
  const bearer = getDarthBearer(request.headers.get('authorization'));
  if (bearer) {
    const identity = await resolveDarthToken(bearer);
    if (!identity) return unauthorized('Unauthorized - invalid or revoked darth token');
    if (identity.kind === 'app') {
      return NextResponse.json(
        { error: 'Forbidden - app tokens are not accepted by meetings' },
        { status: 403 }
      );
    }
    if (!hasMeetingsAccess(identity)) return noAccess(request);
    return NextResponse.next(); // read-scope → GET-only is enforced in withAuth
  }

  // 2. Browser session cookie.
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const user = isSessionValue(cookie) ? await resolveDarthToken(cookie) : null;
  if (!user || user.kind === 'app') {
    if (wantsJson(request)) return unauthorized('Unauthorized - No valid session');
    return loginRedirect(request);
  }
  if (!hasMeetingsAccess(user)) return noAccess(request);

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
