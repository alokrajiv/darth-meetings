import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  verifyState,
  exchangeCode,
  encryptToken,
  invalidateServerToken,
  clientKeyForEmail,
} from '@/lib/server/google-oauth';
import { upsertGoogleAccount } from '@/db-ops/google-accounts';
import { config } from '@/config';

export const runtime = 'nodejs';

function doneRedirect(params: Record<string, string>, returnPath = '/settings'): NextResponse {
  const url = new URL(returnPath, config.google.appBaseUrl);
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
  const code = q.get('code');
  const state = q.get('state');
  const verified = state ? verifyState(state, user.userId) : { ok: false as const };
  if (q.get('error')) {
    return doneRedirect(
      { google: 'error', reason: q.get('error')! },
      verified.ok ? verified.returnPath : undefined
    );
  }
  if (!code || !verified.ok) {
    return doneRedirect({ google: 'error', reason: 'invalid_state' });
  }

  try {
    const clientKey = clientKeyForEmail(user.email);
    const tokens = await exchangeCode(code, clientKey);
    await upsertGoogleAccount({
      userId: user.userId,
      userEmail: user.email,
      googleEmail: tokens.email,
      refreshTokenEnc: encryptToken(tokens.refreshToken),
      scopes: tokens.scope,
      clientKey,
    });
    invalidateServerToken(user.userId);
    return doneRedirect({ google: 'connected' }, verified.returnPath);
  } catch (err) {
    console.error('[google-oauth] callback failed:', err);
    return doneRedirect({ google: 'error', reason: 'exchange_failed' }, verified.returnPath);
  }
});
