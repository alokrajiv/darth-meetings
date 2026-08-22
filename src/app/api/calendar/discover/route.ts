import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import { getServerAccessToken, invalidateServerToken } from '@/lib/server/google-oauth';
import { CalendarListError, discoverWindow } from '@/lib/server/meeting-discovery';
import type { DiscoverWindowResponse } from '@/lib/meeting-discovery-types';

export const runtime = 'nodejs';

const MAX_WINDOW_MS = 45 * 86_400_000;

/**
 * GET /api/calendar/discover?from=<ISO>&to=<ISO>[&meetOnly=1]
 *
 * The import dialog's day / sync view, served by the ONE discovery service:
 * calendar events in the window (written back to the caller's calendar
 * cache) joined with the Meet conferences that actually happened in it
 * (each inventoried + written back to the artifact cache). Runs under the
 * caller's own server-minted Google token — the same token the browser used
 * to get for this, so the own-token rule is unchanged; only the place the
 * call is made moved, and now the answer feeds the listing and the poller.
 *
 * 404 { connected:false } when the caller never connected Google (the
 * dialog shows its Connect pitch); 502 when Google refused the calendar
 * listing (the dialog shows the error instead of an empty day).
 */
export const GET = withAuth(async ({ user, request }) => {
  const sp = request.nextUrl.searchParams;
  const from = sp.get('from');
  const to = sp.get('to');
  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    return NextResponse.json({ error: 'from/to must be ISO instants, to > from' }, { status: 400 });
  }
  if (toMs - fromMs > MAX_WINDOW_MS) {
    return NextResponse.json({ error: 'window too large (max 45 days)' }, { status: 400 });
  }
  const minted = await getServerAccessToken(user.userId);
  if (!minted) {
    const account = await getGoogleAccount(user.userId);
    return NextResponse.json(
      { connected: !!account, status: account?.status ?? null, error: 'Google account not connected' },
      { status: 404 }
    );
  }
  try {
    const result = await discoverWindow(user.userId, minted.token, {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      meetOnly: sp.get('meetOnly') === '1',
    });
    const body: DiscoverWindowResponse = {
      rows: result.rows,
      meetChecked: result.meetChecked,
      checkedAt: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof CalendarListError) {
      // The minted token may be revoked — drop the ~1h cache so the next
      // call re-mints instead of replaying a dead token.
      if (err.status === 401) invalidateServerToken(user.userId);
      return NextResponse.json(
        { error: err.status === 401 ? 'Google session expired — reconnect Google.' : err.message, googleStatus: err.status },
        { status: 502 }
      );
    }
    throw err;
  }
});
