import { NextResponse, type NextRequest } from 'next/server';
import { config } from '@/config';
import { publicUrl } from '@/lib/auth/public-origin';

export const runtime = 'nodejs';

/**
 * GET /logout — 302 to darth-auth's logout, returning to the app root
 * (SPEC §3.7). darth-auth revokes the session row and clears the
 * `darth_session` cookie (it is scoped to `.darth-internal.trames.io`, so only
 * the issuer can clear it); nothing to clear locally.
 */
export async function GET(request: NextRequest) {
  const logout = new URL('/logout', config.auth.authUrl);
  logout.searchParams.set('returnTo', publicUrl(request, '/'));
  return NextResponse.redirect(logout, 302);
}
