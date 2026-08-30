import { NextResponse, type NextRequest } from 'next/server';
import { getMeetingById } from '@/db-ops/meetings';

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
  const { id } = await ctx.params;
  const home = new URL('/', request.nextUrl.origin);
  if (!UUID_RE.test(id)) return NextResponse.redirect(home);
  const meeting = await getMeetingById(id);
  if (!meeting) return NextResponse.redirect(home);
  return NextResponse.redirect(
    new URL(`/transcript/${meeting.transcript_id}`, request.nextUrl.origin)
  );
}
