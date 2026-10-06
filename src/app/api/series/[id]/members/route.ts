import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { isMemberOf } from '@/db-ops/series';
import { listByTranscript } from '@/db-ops/transcript-shares';
import { SERIES_EDIT_DENIED } from '@/lib/series-permissions';
import { attachManually, detachFromSeries, seriesReaches } from '@/lib/server/curated-series';
import { parseSeriesId, seriesForCaller } from '@/lib/server/series-api';

export const runtime = 'nodejs';

const NOT_IN_REACH =
  "This meeting isn't one the series' owner can open, so it can't be in the series";

/**
 * POST /api/series/:id/members { transcriptId } — put a meeting in this
 * series by hand ('manual': it stays while the series' owner can open it,
 * even when the patterns stop matching). §11.6: the caller must OWN or EDIT
 * the SERIES (404 when they cannot see it, 403 when they only follow or
 * audit it), must be able to open the meeting (404 otherwise), and the
 * meeting must be in the series OWNER's reach (403). What the followers get
 * from it is still limited to what the owner may share (§11.4).
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!ctx.deco.permissions.edit) return NextResponse.json({ error: SERIES_EDIT_DENIED }, { status: 403 });

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

  const shares = await listByTranscript(access.row.id);
  const inReach = seriesReaches(
    {
      ownerUserId: ctx.series.owner_user_id,
      ownerEmail: ctx.series.owner_email,
      ownerIsAuditor: ctx.facts.ownerIsAuditor,
    },
    {
      ownerUserId: access.ownerUserId,
      shares: shares.map((s) => ({ email: s.shared_with_email.trim().toLowerCase(), access: s.access })),
    }
  );
  if (!inReach) return NextResponse.json({ error: NOT_IN_REACH }, { status: 403 });

  const ok = await attachManually(
    id,
    { id: access.row.id, user_id: access.ownerUserId, assemblyai_id: access.row.assemblyai_id },
    caller
  );
  if (!ok) {
    return NextResponse.json(
      { error: 'This meeting is already in another series (one series per meeting until migration 055)' },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
});

/**
 * DELETE /api/series/:id/members?transcriptId=…&remember=1 — take the meeting
 * out of THIS series (404 when it is not in it — the id in the path is the
 * scope). §11.6: allowed to the series' owner/editors, AND to the meeting's
 * owner/editors (their meeting — they may take it out of someone's series).
 * The caller must see the series (404) and open the meeting (404).
 * `remember=1` = "not this series": an exclusion the patterns never
 * override. A detach that costs followers their share is ledgered.
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const url = new URL(request.url);
  const transcriptId = url.searchParams.get('transcriptId');
  const remember = url.searchParams.get('remember') === '1';
  if (!transcriptId) {
    return NextResponse.json({ error: 'transcriptId is required' }, { status: 400 });
  }
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const access = await resolveAccess(user.userId, user.email, transcriptId);
  if (!access) return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
  const meetingEditor = access.access === 'owner' || access.access === 'edit';
  if (!ctx.deco.permissions.edit && !meetingEditor) {
    return NextResponse.json(
      { error: 'Only the owner or an editor of the series, or of the meeting, can take it out' },
      { status: 403 }
    );
  }
  // Scoped to :id — "not this series" for a series the meeting is not in is
  // still a valid answer when remembering (it pre-empts the patterns).
  if (!remember && !(await isMemberOf(id, access.row.id))) {
    return NextResponse.json({ error: 'This meeting is not in that series' }, { status: 404 });
  }
  await detachFromSeries(
    id,
    { id: access.row.id, assemblyai_id: access.row.assemblyai_id },
    { remember, userId: user.userId, email: user.email }
  );
  return NextResponse.json({ ok: true });
});
