import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getRunsForTranscript } from '@/db-ops/ai-runs';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/ai-runs
 * AI usage stats for this transcript: recent claude -p runs (cost, tokens,
 * duration, who triggered) plus lifetime totals. Anyone with access can read.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { runs, totals } = await getRunsForTranscript(access.row.id);
  return NextResponse.json({ runs, totals });
});
