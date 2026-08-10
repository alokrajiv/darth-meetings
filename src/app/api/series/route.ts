import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { addKeys, addMember, createSeries, listSeries } from '@/db-ops/series';
import { keysFromContext } from '@/lib/series-keys';
import { publishEvent } from '@/lib/server/event-bus';

export const runtime = 'nodejs';

/** GET /api/series — all series with member counts (org-global). */
export const GET = withAuth(async () => {
  return NextResponse.json({ series: await listSeries() });
});

/**
 * POST /api/series — create a series, optionally seeded from a transcript:
 * { title, fromTranscriptId? } where fromTranscriptId is an assemblyai_id
 * the caller can access. Seeding attaches the transcript as a manual member
 * and claims its evidence keys.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: { title?: string; fromTranscriptId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const series = await createSeries(user.userId, title);

  if (body.fromTranscriptId) {
    const access = await resolveAccess(user.userId, user.email, body.fromTranscriptId);
    if (!access) {
      return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
    }
    await addKeys(
      series.id,
      keysFromContext(access.row.gmeet_context, access.row.title),
      'user',
      user.userId
    );
    await addMember(series.id, access.row.id, 'manual', user.userId);
    publishEvent({ kind: 'meta', assemblyaiId: access.row.assemblyai_id });
  }

  return NextResponse.json({ series });
});
