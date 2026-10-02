import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { searchMeetingsForPanel } from '@/db-ops/meeting-search';
import { identitiesForUsers } from '@/db-ops/transcript-activity';
import { hitFromRow, shapeMeetingSearch, type MeetingSearchResponse } from '@/lib/meeting-search';

export const runtime = 'nodejs';

/**
 * GET /api/search?q=<query> — the results panel's search (the Darth desktop
 * shell's band search, and the in-app search field inside the shell).
 *
 * Every whitespace-separated term must occur in the title, file name,
 * description, AI notes or transcript text (lib/meeting-search.ts). Up to 30
 * hits, title hits first, then newest; each carries title, date, owner
 * (null = the caller's own), duration, labels, the field it matched in and a
 * ~140-char snippet with bold ranges. Same auth + `meetings` module gate and
 * the same visibility (owned + shared, no trash, no temporary rows) as the
 * listing. A query with no usable term (every word < 2 chars) → no hits.
 */
export const GET = withAuth(async ({ user, request }) => {
  const q = (new URL(request.url).searchParams.get('q') ?? '').slice(0, 1000);
  const shaped = shapeMeetingSearch(q);
  if (!shaped) {
    const empty: MeetingSearchResponse = { q, terms: [], hits: [] };
    return NextResponse.json(empty);
  }
  const rows = await searchMeetingsForPanel(user.userId, user.email, shaped);
  const shared = rows.filter((r) => r.access !== 'owner');
  const ids =
    shared.length > 0
      ? await identitiesForUsers(shared.map((r) => r.user_id)).catch(
          () => new Map<string, { email: string; name: string | null }>()
        )
      : new Map<string, { email: string; name: string | null }>();
  const hits = rows.map((r) => {
    const id = ids.get(r.user_id);
    return hitFromRow(r, shaped.terms, id ? { email: id.email, name: id.name } : null);
  });
  const body: MeetingSearchResponse = { q, terms: shaped.terms, hits };
  return NextResponse.json(body);
});
