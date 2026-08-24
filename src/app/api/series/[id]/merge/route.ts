import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getSeries, mergeSeries } from '@/db-ops/series';
import { retroAttachSweep } from '@/lib/server/series-attach';

export const runtime = 'nodejs';

/**
 * POST /api/series/:id/merge { fromSeriesId } — fold fromSeriesId into :id
 * (dupe repair: keys, members, exclusions move; the loser is deleted). Open
 * to any authed user like the rest of the series surface — the client shows
 * a loud confirm and we log who did it. A retro-attach sweep runs after the
 * merge because the combined key bag may now claim previously stray rows.
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

  const [into, from] = await Promise.all([getSeries(intoId), getSeries(fromId)]);
  if (!into || !from) {
    return NextResponse.json({ error: 'Series not found' }, { status: 404 });
  }

  const moved = await mergeSeries(intoId, fromId, user.userId);
  console.log(
    `[series] merge by ${user.email}: "${from.title}" (#${fromId}) → "${into.title}" (#${intoId}), ` +
      `${moved.movedMembers} members + ${moved.movedKeys} keys moved`
  );

  const sweep = await retroAttachSweep(user.email);
  return NextResponse.json({ ok: true, ...moved, retroAttached: sweep.attached });
});
