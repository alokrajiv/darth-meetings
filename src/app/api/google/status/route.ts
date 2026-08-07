import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getGoogleAccount,
  deleteGoogleAccount,
} from '@/db-ops/google-accounts';
import {
  decryptToken,
  revokeToken,
  invalidateServerToken,
} from '@/lib/server/google-oauth';

export const runtime = 'nodejs';

/** Connection metadata for the settings card. Never includes token material. */
export const GET = withAuth(async ({ user, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  const account = await getGoogleAccount(user.userId);
  if (!account) return NextResponse.json({ connected: false });
  return NextResponse.json({
    connected: true,
    googleEmail: account.google_email ?? account.user_email,
    status: account.status,
    lastError: account.status === 'ok' ? null : account.last_error,
    connectedAt: account.connected_at,
    lastPollAt: account.last_poll_at,
  });
});

/** Disconnect: revoke at Google (best-effort), then delete our row. */
export const DELETE = withAuth(async ({ user, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  const account = await getGoogleAccount(user.userId);
  if (account) {
    try {
      await revokeToken(decryptToken(account.refresh_token_enc));
    } catch {
      // undecryptable blob (rotated key) — still delete the row
    }
    await deleteGoogleAccount(user.userId);
    invalidateServerToken(user.userId);
  }
  return NextResponse.json({ connected: false });
});
