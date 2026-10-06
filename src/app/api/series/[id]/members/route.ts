import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getMembership, getSeries } from '@/db-ops/series';
import { curatedSeriesReady, CURATED_SERIES_NOT_READY } from '@/db-ops/curated-series-schema';
import { attachManually, detachFromSeries } from '@/lib/server/curated-series';
import { parseSeriesId } from '@/lib/server/series-api';

export const runtime = 'nodejs';

const OWNER_OR_EDITOR =
  'Only the owner or an editor of the meeting can change its series';

/**
 * POST /api/series/:id/members { transcriptId } — put a meeting in this
 * series by hand ('manual': it stays even when the patterns stop matching).
 * Attaching a meeting to a followed series shares it with the followers, so
 * the caller must OWN or EDIT the meeting — a read share is not enough.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  if (!(await curatedSeriesReady())) {
    return NextResponse.json({ error: CURATED_SERIES_NOT_READY }, { status: 503 });
  }
  if (!(await getSeries(id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: { transcriptId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.transcriptId) {
    return NextResponse.json({ error: 'transcriptId is required' }, { status: 400 });
  }
  const access = await resolveAccess(user.userId, user.email, body.transcriptId);
  if (!access) return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
  if (access.access !== 'owner' && access.access !== 'edit') {
    return NextResponse.json({ error: OWNER_OR_EDITOR }, { status: 403 });
  }

  await attachManually(
    id,
    { id: access.row.id, user_id: access.ownerUserId, assemblyai_id: access.row.assemblyai_id },
    { userId: user.userId, email: user.email }
  );
  return NextResponse.json({ ok: true });
});

/**
 * DELETE /api/series/:id/members?transcriptId=…&remember=1 — take the meeting
 * out of THIS series (404 when it is not in it — the id in the path is the
 * scope, a stale tab cannot detach it from wherever it moved since).
 * `remember=1` = "not this series": an exclusion the patterns never
 * override. Owner or editor of the meeting only.
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  if (!(await curatedSeriesReady())) {
    return NextResponse.json({ error: CURATED_SERIES_NOT_READY }, { status: 503 });
  }

  const url = new URL(request.url);
  const transcriptId = url.searchParams.get('transcriptId');
  const remember = url.searchParams.get('remember') === '1';
  if (!transcriptId) {
    return NextResponse.json({ error: 'transcriptId is required' }, { status: 400 });
  }
  const access = await resolveAccess(user.userId, user.email, transcriptId);
  if (!access) return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
  if (access.access !== 'owner' && access.access !== 'edit') {
    return NextResponse.json({ error: OWNER_OR_EDITOR }, { status: 403 });
  }
  // Scoped to :id — "not this series" for a series the meeting is not in is
  // still a valid answer when remembering (it pre-empts the patterns).
  const membership = await getMembership(access.row.id);
  if (membership?.series_id !== id && !remember) {
    return NextResponse.json({ error: 'This meeting is not in that series' }, { status: 404 });
  }
  if (!(await getSeries(id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await detachFromSeries(
    id,
    { id: access.row.id, assemblyai_id: access.row.assemblyai_id },
    { remember, userId: user.userId }
  );
  return NextResponse.json({ ok: true });
});
