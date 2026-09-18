import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getSeries, mergeSeries, seriesManageVerdictFor, visibleSeriesIds } from '@/db-ops/series';
import { SERIES_NOT_MANAGER_MESSAGE } from '@/lib/series-owner';
import { retroAttachSweep } from '@/lib/server/series-attach';

export const runtime = 'nodejs';

/**
 * POST /api/series/:id/merge { fromSeriesId } — fold fromSeriesId into :id
 * (dupe repair: keys, members, exclusions move; the loser is deleted). Both
 * series must be caller-visible (404 otherwise) AND caller-manageable
 * (organiser of an attached occurrence or creator, lib/series-owner — 403
 * otherwise); the client shows a loud confirm and we log who did it. A
 * retro-attach sweep runs after the merge because the combined key bag may
 * now claim previously stray rows.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const intoId = Number((await params).id);
  if (!Number.isInteger(intoId) || intoId <= 0) {
    return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  }

  let body: { fromSeriesId?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const fromId = Number(body.fromSeriesId);
  if (!Number.isInteger(fromId) || fromId <= 0) {
    return NextResponse.json({ error: 'fromSeriesId is required' }, { status: 400 });
  }
  if (fromId === intoId) {
    return NextResponse.json({ error: 'Cannot merge a series into itself' }, { status: 400 });
  }

  // PRIVACY GATE (2026-08-24): both sides must be caller-visible — merging
  // pulls another series' members/keys under a series the caller can read.
  const visible = await visibleSeriesIds({ userId: user.userId, email: user.email });
  if (!visible.has(intoId) || !visible.has(fromId)) {
    return NextResponse.json({ error: 'Series not found' }, { status: 404 });
  }
  const [into, from] = await Promise.all([getSeries(intoId), getSeries(fromId)]);
  if (!into || !from) {
    return NextResponse.json({ error: 'Series not found' }, { status: 404 });
  }
  // OWNERSHIP GATE (tech-debt D4, 2026-09-18): a merge deletes the loser and
  // rewrites the winner's members/keys, so the caller must be able to manage
  // BOTH (organiser of an attached occurrence, or creator — lib/series-owner).
  const caller = { userId: user.userId, email: user.email };
  const [intoVerdict, fromVerdict] = await Promise.all([
    seriesManageVerdictFor(intoId, caller),
    seriesManageVerdictFor(fromId, caller),
  ]);
  if (!intoVerdict || !fromVerdict) {
    return NextResponse.json({ error: 'Series not found' }, { status: 404 });
  }
  if (!intoVerdict.ok || !fromVerdict.ok) {
    const which = !intoVerdict.ok ? `"${into.title}" (#${intoId})` : `"${from.title}" (#${fromId})`;
    return NextResponse.json(
      { error: `${SERIES_NOT_MANAGER_MESSAGE} — you cannot manage ${which}` },
      { status: 403 }
    );
  }

  const moved = await mergeSeries(intoId, fromId, user.userId);
  console.log(
    `[series] merge by ${user.email}: "${from.title}" (#${fromId}) → "${into.title}" (#${intoId}), ` +
      `${moved.movedMembers} members + ${moved.movedKeys} keys moved`
  );

  const sweep = await retroAttachSweep(user.email);
  return NextResponse.json({ ok: true, ...moved, retroAttached: sweep.attached });
});
