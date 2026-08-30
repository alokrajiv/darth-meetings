import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveMeetingByAnyTranscriptId } from '@/db-ops/meetings';
import { resolveAccess } from '@/db-ops/transcript-access';

export const runtime = 'nodejs';

/**
 * GET /api/meetings/resolve?any=<transcript-id> — map ANY id a meeting has
 * ever had (current or former: defer-…, up-…, gmeet-…, AAI uuid) to its
 * stable meeting uuid + CURRENT transcript id. This is the self-heal behind
 * stale /transcript/<old-id> links after a placeholder promotion.
 *
 * Caller-scoped (review finding: this must not be an existence oracle): the
 * mapping is only returned when the caller can access the CURRENT transcript
 * (owner or shared). No access → the same 404 as an unknown id, so a revoked
 * share can no longer confirm a meeting still exists or learn its new id.
 * The response stays ids-only — no title, no owner, no status.
 */
export const GET = withAuth(async ({ user, request }) => {
  const any = request.nextUrl.searchParams.get('any')?.trim();
  if (!any || any.length > 256) {
    return NextResponse.json({ error: 'any parameter required' }, { status: 400 });
  }
  const meeting = await resolveMeetingByAnyTranscriptId(any);
  if (!meeting) return NextResponse.json({ found: false }, { status: 404 });
  const access = await resolveAccess(user.userId, user.email, meeting.transcript_id);
  if (!access) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({
    found: true,
    meetingId: meeting.id,
    transcriptId: meeting.transcript_id,
    moved: meeting.transcript_id !== any,
  });
});
