import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getActivitySummary } from '@/db-ops/transcript-activity';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/activity
 * Returns the activity summary for the transcript: recent events, last
 * edit, and unique recent viewers. Visible to anyone with access (owner,
 * editor, or read-only).
 */
export const GET = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(rawLimit ?? '50', 10) || 50, 1), 200);

  const summary = await getActivitySummary(access.row.id, limit);
  return NextResponse.json(summary);
});
