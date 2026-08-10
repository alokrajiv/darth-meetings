import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { sweepSeriesOccurrences } from '@/lib/server/series-occurrences';

export const runtime = 'nodejs';
// Sweeping calendar pages + Graph artifact lists can take a moment.
export const maxDuration = 120;

/**
 * GET /api/series/:id/occurrences — every occurrence we can see for this
 * series (calendar + Graph merged), with artifact presence and
 * already-imported cross-references. The external sweep is cached ~6h per
 * user; `?refresh=1` forces a fresh one. Imported state is always fresh.
 */
export const GET = withAuth(async ({ user, request }, { params }) => {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  }
  const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
  const result = await sweepSeriesOccurrences(
    id,
    { userId: user.userId, email: user.email },
    { forceRefresh }
  );
  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(result);
});
