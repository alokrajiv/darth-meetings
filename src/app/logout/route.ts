import { NextResponse, type NextRequest } from 'next/server';
import { config } from '@/config';

export const runtime = 'nodejs';

/**
 * GET /logout — 302 to darth-auth's logout, returning to the app root
 * (SPEC §3.7). darth-auth revokes the session row and clears the
 * `darth_session` cookie (it is scoped to `.darth-internal.trames.io`, so only
 * the issuer can clear it); nothing to clear locally.
 */
export async function GET(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost';
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(/:$/, '');
  const logout = new URL('/logout', config.auth.authUrl);
  logout.searchParams.set('returnTo', `${proto || 'https'}://${host}/`);
  return NextResponse.redirect(logout, 302);
}
