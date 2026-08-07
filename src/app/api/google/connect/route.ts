import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  mintState,
  buildAuthUrl,
  clientKeyForEmail,
  isClientConfigured,
} from '@/lib/server/google-oauth';

export const runtime = 'nodejs';

/**
 * Kick off the Google auth-code flow: signed state → Google consent screen.
 * Browser navigation target (window.location), not a fetch.
 */
export const GET = withAuth(async ({ user, request, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Google connect requires a browser session' }, { status: 403 });
  }
  const clientKey = clientKeyForEmail(user.email);
  if (!isClientConfigured(clientKey)) {
    return NextResponse.json(
      { error: `Google OAuth client for your workspace ('${clientKey}') is not configured` },
      { status: 500 }
    );
  }
  const returnPath = request.nextUrl.searchParams.get('return') ?? undefined;
  return NextResponse.redirect(buildAuthUrl(mintState(user.userId, returnPath), clientKey));
});
