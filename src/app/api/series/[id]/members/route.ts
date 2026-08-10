import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { addKeys, addMember, getSeries, removeMember } from '@/db-ops/series';
import { keysFromContext } from '@/lib/series-keys';
import { publishEvent } from '@/lib/server/event-bus';

export const runtime = 'nodejs';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * POST /api/series/:id/members — attach a transcript the caller can access:
 * { transcriptId (assemblyai_id), how?: 'confirmed' | 'manual' }.
 * 'confirmed' = the user said yes to a guess (its keys strengthen the
 * series), 'manual' = attached by hand (keys also absorbed).
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  if (!(await getSeries(id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: { transcriptId?: string; how?: 'confirmed' | 'manual' };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.transcriptId) {
    return NextResponse.json({ error: 'transcriptId is required' }, { status: 400 });
  }
  const how = body.how === 'manual' ? 'manual' : 'confirmed';

  const access = await resolveAccess(user.userId, user.email, body.transcriptId);
  if (!access) {
    return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
  }

  await addKeys(
    id,
    keysFromContext(access.row.gmeet_context, access.row.title),
    'user',
    user.userId
  );
  await addMember(id, access.row.id, how, user.userId);
  publishEvent({ kind: 'meta', assemblyaiId: access.row.assemblyai_id });
  return NextResponse.json({ ok: true });
});

/**
 * DELETE /api/series/:id/members?transcriptId=…&remember=1 — detach.
 * `remember` writes an exclusion so this transcript is never re-suggested
 * for this series (the "no, and don't ask again" answer).
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const url = new URL(request.url);
  const transcriptId = url.searchParams.get('transcriptId');
  const remember = url.searchParams.get('remember') === '1';
  if (!transcriptId) {
    return NextResponse.json({ error: 'transcriptId is required' }, { status: 400 });
  }
  const access = await resolveAccess(user.userId, user.email, transcriptId);
  if (!access) {
    return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
  }

  await removeMember(access.row.id, {
    rememberExclusionFor: remember ? id : undefined,
    userId: user.userId,
  });
  publishEvent({ kind: 'meta', assemblyaiId: access.row.assemblyai_id });
  return NextResponse.json({ ok: true });
});
