import { NextResponse, type NextRequest } from 'next/server';
import { getMeetingById } from '@/db-ops/meetings';
import { getCurrentUser } from '@/lib/auth/session';
import { hasMeetingsAccess } from '@/lib/auth/cli-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { callerInvolvedCodes } from '@/db-ops/calendar-event-cache';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /m/<uuid> — the PERMANENT link for a meeting (T1, migration 031). Minted
 * the moment an import/upload is queued and stable across every provider-id
 * rename (defer-… → gmeet-…, up-… → AAI id, …). Just a redirect: access
 * control stays entirely with the transcript page/API it lands on, and the
 * SSO middleware gates this route like any other page.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  // Behind nginx request.url/nextUrl is localhost:<port> — build the origin
  // from the forwarded headers or the redirect sends users to localhost.
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost';
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const origin = `${proto}://${host}`;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.redirect(new URL('/', origin));
  // Verify the session + app access (the proxy already does both; this route
  // re-checks so it never depends on the matcher) and the
  // caller's access to the transcript before the Location header reveals the
  // uuid → transcript-id mapping (review finding). No session/access → home,
  // indistinguishable from an unknown uuid.
  const user = await getCurrentUser();
  if (!user || !hasMeetingsAccess(user)) return NextResponse.redirect(new URL('/', origin));
  const meeting = await getMeetingById(id);
  if (!meeting) return NextResponse.redirect(new URL('/', origin));
  if (!meeting.transcript_id) {
    // Pre-import occurrence row (migration 036): nobody imported it yet, so
    // "in" is the home listing with the import dialog focused on it. Gated
    // by the caller-involvement predicate (privacy audit 2026-08-24) — an
    // uninvolved caller gets the same plain home redirect as an unknown
    // uuid, so the Location header never leaks the meeting code/time.
    if (!meeting.provider_key) return NextResponse.redirect(new URL('/', origin));
    const involved = await callerInvolvedCodes(
      { userId: user.userId, email: user.email },
      [{ code: meeting.provider_key, instant: meeting.occ_start }]
    ).catch(() => new Set<string>());
    if (!involved.has(meeting.provider_key)) return NextResponse.redirect(new URL('/', origin));
    const target = new URL('/', origin);
    target.searchParams.set('import', meeting.provider_key);
    if (meeting.occ_start) target.searchParams.set('start', new Date(meeting.occ_start).toISOString());
    return NextResponse.redirect(target);
  }
  const access = await resolveAccess(user.userId, user.email, meeting.transcript_id);
  if (!access) return NextResponse.redirect(new URL('/', origin));
  return NextResponse.redirect(new URL(`/transcript/${meeting.transcript_id}`, origin));
}
