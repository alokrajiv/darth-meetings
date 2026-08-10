import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { setAutoNotesForUser } from '@/db-ops/transcripts';
import { generateAutoNotes, getContentCached } from '@/lib/server/auto-notes';
import { suggestSpeakersForTranscript } from '@/lib/server/voiceprint';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/notes
 * (Re)generate the AI meeting notes for this transcript. Editors only.
 * Fire-and-forget: responds immediately with status 'running'; the client
 * polls GET /api/transcripts/:id until auto_notes_status settles.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  // Optional body: { instructions?: string, fromReport?: boolean } —
  // free-form steering, and/or "distill from the detailed-report session"
  // (the top-up path when a report exists: reuses the frames/context that
  // session already verified).
  let instructions: string | undefined;
  let fromReport = false;
  try {
    const body = (await request.json()) as { instructions?: unknown; fromReport?: unknown };
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      instructions = body.instructions.trim().slice(0, 2000);
    }
    if (body.fromReport === true) fromReport = true;
  } catch {
    // no/invalid body — plain regeneration
  }

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }
  if (access.row.status !== 'completed') {
    return NextResponse.json(
      { error: 'Transcript is not completed yet' },
      { status: 409 }
    );
  }

  void generateAutoNotes(access.ownerUserId, id, {
    force: true,
    fromReport,
    triggeredBy: { userId: user.userId, email: user.email },
    instructions,
  });

  // Also refresh voiceprint suggestions — lets older transcripts (completed
  // before the feature shipped) pick up speaker auto-detection on demand.
  void (async () => {
    const content = await getContentCached(access.ownerUserId, access.row);
    await suggestSpeakersForTranscript(
      access.ownerUserId,
      id,
      access.row.local_audio_path,
      content
    );
  })().catch((err) => console.warn('[notes POST] suggest failed:', err));

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'generate_notes',
  });

  return NextResponse.json({ status: 'running' });
});

/**
 * PUT /api/transcripts/:id/notes
 * Set the notes markdown directly — no AI run. This is the darth-cli
 * write-back path: an external agent computes a summary with its own tokens
 * and pushes the result here. Editors only. Body: { markdown: string }.
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

  await setAutoNotesForUser(access.ownerUserId, id, {
    status: 'completed',
    notes: markdown,
    error: null,
  });

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'set_notes',
    details: cliScope ? { via: 'darth-cli' } : undefined,
  });

  return NextResponse.json({ status: 'completed' });
});
