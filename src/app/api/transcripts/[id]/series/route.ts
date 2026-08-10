import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getMembership, suggestSeriesForTranscript } from '@/db-ops/series';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/series — the transcript's series membership (if
 * any) plus candidate series guessed from its evidence keys, for the badge
 * popover's "is this part of …?" flow.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [membership, candidates] = await Promise.all([
    getMembership(access.row.id),
    suggestSeriesForTranscript(access.row.id, access.row.gmeet_context, access.row.title),
  ]);
  return NextResponse.json({
    membership,
    candidates: membership
      ? candidates.filter((c) => c.series_id !== membership.series_id)
      : candidates,
  });
});
