import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  verifyState,
  exchangeCode,
  encryptToken,
  invalidateServerToken,
} from '@/lib/server/google-oauth';
import { upsertGoogleAccount } from '@/db-ops/google-accounts';
import { config } from '@/config';

export const runtime = 'nodejs';

function settingsRedirect(params: Record<string, string>): NextResponse {
  const url = new URL('/settings', config.google.appBaseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/**
 * Google redirects here after consent. The SSO cookie rides along (same
 * origin), so withAuth still identifies the user — the state must have been
 * minted for exactly that user, which is what makes the flow CSRF-safe.
 */
export const GET = withAuth(async ({ user, request, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Google connect requires a browser session' }, { status: 403 });
  }
  const q = request.nextUrl.searchParams;
  if (q.get('error')) {
    return settingsRedirect({ google: 'error', reason: q.get('error')! });
  }
  const code = q.get('code');
  const state = q.get('state');
  if (!code || !state || !verifyState(state, user.userId)) {
    return settingsRedirect({ google: 'error', reason: 'invalid_state' });
  }

  try {
    const tokens = await exchangeCode(code);
    await upsertGoogleAccount({
      userId: user.userId,
      userEmail: user.email,
      googleEmail: tokens.email,
      refreshTokenEnc: encryptToken(tokens.refreshToken),
      scopes: tokens.scope,
    });
    invalidateServerToken(user.userId);
    return settingsRedirect({ google: 'connected' });
  } catch (err) {
    console.error('[google-oauth] callback failed:', err);
    return settingsRedirect({ google: 'error', reason: 'exchange_failed' });
  }
});
