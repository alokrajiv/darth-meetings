import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getContentCached } from '@/lib/server/auto-notes';
import { suggestSpeakersForTranscript } from '@/lib/server/voiceprint';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/speakers/suggest
 * Run voiceprint speaker matching on demand — no Claude involved, just the
 * local embedding sidecar (a few seconds), so this responds synchronously
 * with the fresh suggestion map. Editors only (suggestions persist on the
 * owner's row).
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
  if (!access.row.local_audio_path) {
    return NextResponse.json(
      { error: 'No local audio stored for this transcript' },
      { status: 409 }
    );
  }

  try {
    const content = await getContentCached(access.ownerUserId, access.row);
    const suggestions = await suggestSpeakersForTranscript(
      access.ownerUserId,
      id,
      access.row.local_audio_path,
      content
    );
    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error('[speakers/suggest] failed:', err);
    return NextResponse.json(
      { error: 'Voiceprint matching failed', detail: String(err) },
      { status: 502 }
    );
  }
});
