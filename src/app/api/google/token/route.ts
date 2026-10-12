import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getServerAccessToken, invalidateServerToken } from '@/lib/server/google-oauth';
import { getGoogleAccount, isNotLinkedOnAuth } from '@/db-ops/google-accounts';

export const runtime = 'nodejs';

/**
 * Google access token for the browser (lib/google-token.ts). Only ever
 * returns the CALLER's own token, short-lived (~1h) and read-only scoped.
 * Since 2026-10-12 it is fetched from darth-auth, which holds the link
 * (lib/server/google-oauth.ts); 404 = no usable link.
 */
export const GET = withAuth(async ({ user, request, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  // ?force=1: the browser saw a 401 on this token — drop the server cache so
  // a fresh one gets minted instead of re-serving the dead token.
  if (request.nextUrl.searchParams.get('force')) {
    invalidateServerToken(user.userId);
  }
  const minted = await getServerAccessToken(user.userId);
  if (!minted) {
    const account = await getGoogleAccount(user.userId);
    const linked = !!account && !isNotLinkedOnAuth(account);
    return NextResponse.json(
      { connected: linked, status: linked ? account!.status : null },
      { status: 404 }
    );
  }
  return NextResponse.json({ accessToken: minted.token, expiresAt: minted.expiresAt });
});
