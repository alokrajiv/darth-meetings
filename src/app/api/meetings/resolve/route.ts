import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getMeetingById, resolveMeetingByAnyTranscriptId } from '@/db-ops/meetings';
import { resolveAccess } from '@/db-ops/transcript-access';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/meetings/resolve?any=<transcript-id> — map ANY id a meeting has
 * ever had (current or former: defer-…, up-…, gmeet-…, AAI uuid) to its
 * stable meeting uuid + CURRENT transcript id. This is the self-heal behind
 * stale /transcript/<old-id> links after a placeholder promotion.
 *
 * GET /api/meetings/resolve?m=<meeting-uuid> — the same answer for the uuid
 * of a /m/<uuid> permalink (aliases included). It is what /m/[id] does for a
 * browser, for callers that have a bearer token instead of a session:
 * darth-cli turns a pasted /m/ link into the transcript id every verb takes.
 *
 * Caller-scoped (review finding: this must not be an existence oracle): the
 * mapping is only returned when the caller can access the CURRENT transcript
 * (owner or shared). No access → the same 404 as an unknown id, so a revoked
 * share can no longer confirm a meeting still exists or learn its new id.
 * A pre-import occurrence row (no transcript yet) is a 404 too — /m/[id]
 * only reveals those to involved callers, and this route stays ids-only.
 * The response stays ids-only — no title, no owner, no status.
 */
export const GET = withAuth(async ({ user, request }) => {
  const params = request.nextUrl.searchParams;
  const m = params.get('m')?.trim();
  const any = params.get('any')?.trim();
  if (m !== undefined) {
    if (!UUID_RE.test(m)) return NextResponse.json({ error: 'm must be a meeting uuid' }, { status: 400 });
  } else if (!any || any.length > 256) {
    return NextResponse.json({ error: 'any parameter required' }, { status: 400 });
  }
  const meeting = m !== undefined ? await getMeetingById(m.toLowerCase()) : await resolveMeetingByAnyTranscriptId(any!);
  // Pre-import occurrence rows (transcript_id NULL) — same 404 as unknown.
  if (!meeting?.transcript_id) return NextResponse.json({ found: false }, { status: 404 });
  const access = await resolveAccess(user.userId, user.email, meeting.transcript_id);
  if (!access) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({
    found: true,
    meetingId: meeting.id,
    transcriptId: meeting.transcript_id,
    moved: m !== undefined ? false : meeting.transcript_id !== any,
  });
});
