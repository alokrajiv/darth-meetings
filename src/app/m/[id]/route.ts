import { NextResponse, type NextRequest } from 'next/server';
import { getMeetingById } from '@/db-ops/meetings';
import { getCurrentUser } from '@/lib/auth/sso-session';
import { resolveAccess } from '@/db-ops/transcript-access';

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
  // Verify the session (the edge proxy only checks cookie PRESENCE) and the
  // caller's access to the transcript before the Location header reveals the
  // uuid → transcript-id mapping (review finding). No session/access → home,
  // indistinguishable from an unknown uuid.
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL('/', origin));
  const meeting = await getMeetingById(id);
  if (!meeting) return NextResponse.redirect(new URL('/', origin));
  const access = await resolveAccess(user.userId, user.email, meeting.transcript_id);
  if (!access) return NextResponse.redirect(new URL('/', origin));
  return NextResponse.redirect(new URL(`/transcript/${meeting.transcript_id}`, origin));
}
