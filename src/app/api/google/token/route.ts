import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { getGoogleAccount } from '@/db-ops/google-accounts';

export const runtime = 'nodejs';

/**
 * Server-minted Google access token for the browser. Lets connected users
 * skip the GIS popup entirely — google-token.ts tries this before falling
 * back to the popup. Only ever returns the CALLER's own token; short-lived
 * (~1h) and read-only scoped, same as what the popup would have minted.
 */
export const GET = withAuth(async ({ user, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  const minted = await getServerAccessToken(user.userId);
  if (!minted) {
    const account = await getGoogleAccount(user.userId);
    return NextResponse.json(
      { connected: !!account, status: account?.status ?? null },
      { status: 404 }
    );
  }
  return NextResponse.json({ accessToken: minted.token, expiresAt: minted.expiresAt });
});
