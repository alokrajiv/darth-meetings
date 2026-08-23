import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { searchVisibleTranscripts } from '@/db-ops/transcript-search';
import { parseMeetingFilters } from '@/lib/server/meeting-filters';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/search?q=<query>
 * Deep search over everything visible to the caller: title, filename,
 * description, AI summary, and full transcript text. Returns per-row match
 * info + a snippet for content matches. Accepts the shared people/provider
 * filters (participant / organizer / provider / speaker — see
 * lib/server/meeting-filters) ANDed onto the text match; bad provider → 400.
 */
export const GET = withAuth(async ({ user, request }) => {
  const params = new URL(request.url).searchParams;
  const parsed = parseMeetingFilters(params);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  // Same "< 2 chars → no hits" rule as always; the parser trims and strips
  // NUL bytes (which Postgres would reject with a 500).
  const q = parsed.filters.q;
  if (!q) return NextResponse.json({ hits: [] });
  const hits = await searchVisibleTranscripts(user.userId, user.email, q, 50, parsed.filters);
  return NextResponse.json({ hits });
});
