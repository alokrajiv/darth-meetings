import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getSeries } from '@/db-ops/series';
import { curatedSeriesReady, CURATED_SERIES_NOT_READY } from '@/db-ops/curated-series-schema';
import { isAuditorEmail } from '@/lib/auditor-policy';
import { canRemoveFollower, SERIES_FOLLOWERS_AUDITOR_ONLY } from '@/lib/series-permissions';
import { followSeries, unfollowSeries } from '@/lib/server/curated-series';
import { parseSeriesId } from '@/lib/server/series-api';

export const runtime = 'nodejs';
// Adding a follower shares every member — a few hundred inserts at most.
export const maxDuration = 120;

/**
 * POST /api/series/:id/followers { email, name? } — follow: a read share
 * (origin 'series-follow') of every meeting in the series, past and future.
 * Following grants read access to other people's meetings, so ONLY AN
 * AUDITOR may add a follower (spec §6) — anyone else gets 403, including for
 * themselves. A person removed from a meeting before (the share-removal
 * ledger) is not given that meeting again.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  if (!(await curatedSeriesReady())) {
    return NextResponse.json({ error: CURATED_SERIES_NOT_READY }, { status: 503 });
  }
  if (!isAuditorEmail(user.email)) {
    return NextResponse.json({ error: SERIES_FOLLOWERS_AUDITOR_ONLY }, { status: 403 });
  }
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: { email?: unknown; name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  const r = await followSeries(id, { email, name }, { userId: user.userId, email: user.email });
  console.log(`[series] #${id} "${series.title}": ${user.email} added follower ${email} (${r.shares} share(s))`);
  return NextResponse.json({ ok: true, ...r });
});

/**
 * DELETE /api/series/:id/followers?email=… — unfollow: the follower's
 * 'series-follow' shares on this series' meetings come off (a share someone
 * made by hand, an invitee's or an auditor's share is untouched). An auditor
 * may remove anyone; any follower may remove THEMSELVES.
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  if (!(await curatedSeriesReady())) {
    return NextResponse.json({ error: CURATED_SERIES_NOT_READY }, { status: 503 });
  }
  const email = (new URL(request.url).searchParams.get('email') ?? '').trim().toLowerCase();
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  if (!canRemoveFollower(caller, email)) {
    return NextResponse.json({ error: SERIES_FOLLOWERS_AUDITOR_ONLY }, { status: 403 });
  }
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const r = await unfollowSeries(id, email);
  if (!r.removed) return NextResponse.json({ error: 'Not a follower of this series' }, { status: 404 });
  console.log(`[series] #${id} "${series.title}": ${user.email} removed follower ${email} (${r.shares} share(s) off)`);
  return NextResponse.json({ ok: true, ...r });
});
