import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount, isNotLinkedOnAuth } from '@/db-ops/google-accounts';
import { connectionsUrl, DARTH_AUTH_CONNECTIONS_URL } from '@/lib/server/google-oauth';
import { syncOneGoogleAccountFromAuth } from '@/lib/server/google-link-sync';

export const runtime = 'nodejs';

/**
 * Connection metadata for the settings card + the connect nudge. Never
 * includes token material. The link lives on darth-auth (since 2026-10-12):
 * the caller's row is re-mirrored from auth first, so a person who just
 * linked (or unlinked) on Connections sees it here at once — when auth does
 * not answer, the row we have is shown as-is.
 */
export const GET = withAuth(async ({ user, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  await syncOneGoogleAccountFromAuth(user.userId, user.email).catch((err) => {
    console.warn('[google-status] auth sync failed:', err instanceof Error ? err.message : err);
  });
  const links = { manageUrl: DARTH_AUTH_CONNECTIONS_URL, connectUrl: connectionsUrl('/settings') };
  const account = await getGoogleAccount(user.userId);
  // A row that auth says is not linked any more reads as not connected — the
  // row itself stays (its poll history survives a relink).
  if (!account || isNotLinkedOnAuth(account)) {
    return NextResponse.json({ connected: false, ...links });
  }
  return NextResponse.json({
    connected: true,
    googleEmail: account.google_email ?? account.user_email,
    status: account.status,
    lastError: account.status === 'ok' ? null : account.last_error,
    connectedAt: account.connected_at,
    lastPollAt: account.last_poll_at,
    ...links,
  });
});

/** Disconnect happens on darth-auth's Connections page now — no revoke and
 * no delete here (a Google revoke would also kill auth's copy of the grant). */
export const DELETE = withAuth(async ({ cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  return NextResponse.json(
    { error: 'Disconnect Google on the Connections page', manageUrl: DARTH_AUTH_CONNECTIONS_URL },
    { status: 410 }
  );
});
