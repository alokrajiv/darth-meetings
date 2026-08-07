import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { mintState, buildAuthUrl } from '@/lib/server/google-oauth';
import { config } from '@/config';

export const runtime = 'nodejs';

/**
 * Kick off the Google auth-code flow: signed state → Google consent screen.
 * Browser navigation target (window.location), not a fetch.
 */
export const GET = withAuth(async ({ user, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Google connect requires a browser session' }, { status: 403 });
  }
  if (!config.google.clientId || !config.google.clientSecret) {
    return NextResponse.json({ error: 'Google OAuth is not configured on the server' }, { status: 500 });
  }
  return NextResponse.redirect(buildAuthUrl(mintState(user.userId)));
});
