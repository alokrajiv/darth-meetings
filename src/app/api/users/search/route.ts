import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { searchPeople } from '@/db-ops/people';

export const runtime = 'nodejs';

/**
 * GET /api/users/search?q=<query>&limit=<n>
 *
 * Search the Trames directory (darth_plagueis.ppl) for users whose name,
 * slack handle, or any email matches the query. Used by the user picker in
 * the share dialog and speaker editor.
 */
export const GET = withAuth(async ({ request }) => {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  const limitRaw = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitRaw ?? '20', 10) || 20, 1), 50);

  const people = await searchPeople(q, limit);
  return NextResponse.json({ people });
});
