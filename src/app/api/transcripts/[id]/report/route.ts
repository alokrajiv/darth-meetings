import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { setAutoReportForUser } from '@/db-ops/transcripts';
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

/**
 * PUT /api/transcripts/:id/report
 * Set the report markdown directly — no AI run. darth-cli write-back path,
 * mirror of PUT …/notes. Editors only. Body: { markdown: string }.
 */
export const PUT = withAuth(async ({ user, request, cliScope }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  let markdown: string;
  try {
    const body = (await request.json()) as { markdown?: unknown };
    if (typeof body.markdown !== 'string' || !body.markdown.trim()) {
      return NextResponse.json({ error: 'Body must be { markdown: string } (non-empty)' }, { status: 400 });
    }
    if (body.markdown.length > 512 * 1024) {
      return NextResponse.json({ error: 'markdown too large (512KB max)' }, { status: 400 });
    }
    markdown = body.markdown;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  await setAutoReportForUser(access.ownerUserId, id, {
    status: 'completed',
    report: markdown,
    error: null,
  });

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'set_report',
    details: cliScope ? { via: 'darth-cli' } : undefined,
  });

  return NextResponse.json({ status: 'completed' });
});
