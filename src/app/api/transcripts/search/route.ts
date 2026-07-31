import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { searchVisibleTranscripts } from '@/db-ops/transcript-search';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/search?q=<query>
 * Deep search over everything visible to the caller: title, filename,
 * description, AI summary, and full transcript text. Returns per-row match
 * info + a snippet for content matches.
 */
export const GET = withAuth(async ({ user, request }) => {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  if (q.trim().length < 2) return NextResponse.json({ hits: [] });
  const hits = await searchVisibleTranscripts(user.userId, user.email, q);
  return NextResponse.json({ hits });
});
