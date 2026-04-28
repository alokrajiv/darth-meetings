import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * POST /api/public/auth/logout
 *
 * Best-effort local cookie clear. The real clear happens on the SSO side when
 * the client is subsequently redirected to login.trames.io; we just poison the
 * cookie for our domain here so a stale session can't be re-used against us
 * before that redirect lands.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set('trames-auth-session', '', {
    path: '/',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'lax',
  });
  return response;
}
