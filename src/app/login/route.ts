import { NextResponse, type NextRequest } from 'next/server';
import { config } from '@/config';

export const runtime = 'nodejs';

/**
 * GET /login[?returnTo=<path>] — 302 to darth-auth's login (SPEC §4.2).
 *
 * The proxy already sends unauthenticated document navigations straight to
 * darth-auth; this route only serves old bookmarks and the client 401 guard
 * (`auth-refresh.ts`), which pass a same-origin `returnTo` path. returnTo is
 * rebuilt as an absolute URL on OUR public origin (never reflected as-is) so
 * darth-auth's same-site check accepts it and no open redirect exists here.
 */
export async function GET(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost';
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(/:$/, '');
  const origin = `${proto || 'https'}://${host}`;

  const raw = request.nextUrl.searchParams.get('returnTo') || '/';
  // Same-origin paths only: "/x?y" — anything with a scheme/host falls back to "/".
  const path = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

  const login = new URL('/login', config.auth.authUrl);
  login.searchParams.set('returnTo', new URL(path, origin).toString());
  return NextResponse.redirect(login, 302);
}
