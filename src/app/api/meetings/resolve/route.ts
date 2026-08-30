import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveMeetingByAnyTranscriptId } from '@/db-ops/meetings';

export const runtime = 'nodejs';

/**
 * GET /api/meetings/resolve?any=<transcript-id> — map ANY id a meeting has
 * ever had (current or former: defer-…, up-…, gmeet-…, AAI uuid) to its
 * stable meeting uuid + CURRENT transcript id. This is the self-heal behind
 * stale /transcript/<old-id> links after a placeholder promotion.
 *
 * Deliberately returns ONLY the id mapping — no title, no owner, no status
 * ("display-only metadata" is not a defense; see the caller-scoping-gate
 * rule). Knowing one opaque id of a meeting yields its other opaque ids;
 * content access is still enforced by the transcript API the caller lands on.
 */
export const GET = withAuth(async ({ request }) => {
  const any = request.nextUrl.searchParams.get('any')?.trim();
  if (!any || any.length > 256) {
    return NextResponse.json({ error: 'any parameter required' }, { status: 400 });
  }
  const meeting = await resolveMeetingByAnyTranscriptId(any);
  if (!meeting) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({
    found: true,
    meetingId: meeting.id,
    transcriptId: meeting.transcript_id,
    moved: meeting.transcript_id !== any,
  });
});
