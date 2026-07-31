import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { generateAutoNotes, getContentCached } from '@/lib/server/auto-notes';
import { suggestSpeakersForTranscript } from '@/lib/server/voiceprint';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/notes
 * (Re)generate the AI meeting notes for this transcript. Editors only.
 * Fire-and-forget: responds immediately with status 'running'; the client
 * polls GET /api/transcripts/:id until auto_notes_status settles.
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

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
    triggeredBy: { userId: user.userId, email: user.email },
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
