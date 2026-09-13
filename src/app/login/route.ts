import { NextResponse, type NextRequest } from 'next/server';
import { config } from '@/config';
import { publicOrigin, sameOriginReturnTo } from '@/lib/auth/public-origin';

export const runtime = 'nodejs';

/**
 * GET /login[?returnTo=<path>] — 302 to darth-auth's login (SPEC §4.2).
 *
 * The proxy already sends unauthenticated document navigations straight to
 * darth-auth; this route only serves old bookmarks and the client 401 guard
 * (`auth-refresh.ts`), which pass a same-origin `returnTo` path. returnTo is
 * resolved against OUR public origin and only forwarded when the resulting
 * URL's origin IS that origin (so `//evil`, `/\evil` — the WHATWG parser
 * treats `\` as `/` for http(s) — and `https://evil` all fall back to `/`);
 * darth-auth's own same-site check is the second line of defence.
 */
export async function GET(request: NextRequest) {
  const origin = publicOrigin(request);
  const login = new URL('/login', config.auth.authUrl);
  login.searchParams.set('returnTo', sameOriginReturnTo(request.nextUrl.searchParams.get('returnTo'), origin));
  return NextResponse.redirect(login, 302);
}

