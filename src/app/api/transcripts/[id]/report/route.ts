import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { generateAutoReport } from '@/lib/server/auto-notes';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/report
 * (Re)generate the detailed AI report (the deep-dive tier next to the quick
 * summary). Editors only. Fire-and-forget: responds with status 'running';
 * the client refreshes via the live-events stream / polling until
 * auto_report_status settles. Optional body: { instructions?: string }.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  let instructions: string | undefined;
  let useVideo = true;
  try {
    const body = (await request.json()) as { instructions?: unknown; useVideo?: unknown };
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      instructions = body.instructions.trim().slice(0, 2000);
    }
    if (body.useVideo === false) useVideo = false;
  } catch {
    // no/invalid body — plain run
  }

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }
  if (access.row.status !== 'completed') {
    return NextResponse.json({ error: 'Transcript is not completed yet' }, { status: 409 });
  }

  void generateAutoReport(access.ownerUserId, id, {
    triggeredBy: { userId: user.userId, email: user.email },
    instructions,
    useVideo,
  });

  return NextResponse.json({ status: 'running' });
});
