import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { canRemoveFollower, SERIES_MANAGE_DENIED } from '@/lib/series-permissions';
import { followSeries, unfollowSeries } from '@/lib/server/curated-series';
import { isInternalEmail, parsePerson, parseSeriesId, seriesForCaller } from '@/lib/server/series-api';

export const runtime = 'nodejs';
// Adding a follower re-runs every member — a few hundred inserts at most.
export const maxDuration = 120;

/**
 * POST /api/series/:id/followers { email, name? } — follow: a read share
 * (origin 'series-follow') of every member the series' OWNER may share —
 * the meetings the owner owns or edits; every member of an auditor-owned
 * series (§11.4). Owner and editors add followers (§11.1); the reach rule
 * is the safety, so there is no auditor gate. 404 for a caller who cannot
 * see the series, 403 for a follower/auditor who cannot manage it. Company
 * addresses only. A person removed from a meeting before (the share-removal
 * ledger) is not given that meeting again.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!ctx.deco.permissions.manageFollowers) {
    return NextResponse.json({ error: SERIES_MANAGE_DENIED }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const p = parsePerson(body);
  if (!p || !isInternalEmail(p.email)) {
    return NextResponse.json({ error: 'a company email address is required' }, { status: 400 });
  }
  const r = await followSeries(id, p, caller);
  console.log(`[series] #${id} "${ctx.series.title}": ${user.email} added follower ${p.email} (${r.shares} share(s))`);
  return NextResponse.json({ ok: true, ...r });
});

/**
 * DELETE /api/series/:id/followers?email=… — unfollow: the follower's
 * 'series-follow' shares come off wherever no other series they follow still
 * gives them (a share someone made by hand, an invitee's or an auditor's
 * share is untouched). Owner/editors may remove anyone; a follower only
 * themselves. 404 for a caller who cannot see the series.
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const email = (new URL(request.url).searchParams.get('email') ?? '').trim().toLowerCase();
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (
    !canRemoveFollower(
      ctx.facts,
      { callerEmail: user.email, callerUserId: user.userId, callerIsAuditor: ctx.callerIsAuditor },
      email
    )
  ) {
    return NextResponse.json({ error: SERIES_MANAGE_DENIED }, { status: 403 });
  }
  const r = await unfollowSeries(id, email);
  if (!r.removed) return NextResponse.json({ error: 'Not a follower of this series' }, { status: 404 });
  console.log(`[series] #${id} "${ctx.series.title}": ${user.email} removed follower ${email} (${r.shares} share(s) off)`);
  return NextResponse.json({ ok: true, ...r });
});
