import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { connectionsUrl } from '@/lib/server/google-oauth';

export const runtime = 'nodejs';

/**
 * "Connect Google" — since 2026-10-12 the link is made on darth-auth, not
 * here: 302 to auth's Connections page with `?return=` back to the caller's
 * page (relative `?return=` made absolute on APP_BASE_URL; default
 * /settings). Kept as a route so old links and bookmarks still land right.
 * Browser navigation target (window.location), not a fetch.
 */
export const GET = withAuth(async ({ request, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Google connect requires a browser session' }, { status: 403 });
  }
  const ret = request.nextUrl.searchParams.get('return');
  // App-relative only — never bounce through auth to someone else's site.
  const returnPath = ret && ret.startsWith('/') && !ret.startsWith('//') ? ret : '/settings';
  return NextResponse.redirect(connectionsUrl(returnPath));
});
