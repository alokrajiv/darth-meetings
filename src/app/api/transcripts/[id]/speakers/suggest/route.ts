import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getContentCached, identifySpeakers } from '@/lib/server/auto-notes';
import { suggestSpeakersForTranscript } from '@/lib/server/voiceprint';
import { resolveMeetingContent } from '@/lib/server/recordings';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/speakers/suggest
 * Run voiceprint speaker matching on demand — the local embedding sidecar
 * (a few seconds), so this responds synchronously with the fresh suggestion
 * map. Also force-retriggers the speaker-ID AI pass in the background when
 * it previously errored or never ran, or always with body { "force": true }
 * (its results land via the usual suggestions polling; the response's
 * `speakerIdStatus` tells the page to poll). Editors only (suggestions persist on the owner's
 * row).
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  // { "force": true } re-runs the speaker-ID pass even when it completed
  // before (never while one is running) — a deliberate "look again".
  let force = false;
  try {
    const body = (await request.json()) as { force?: unknown };
    force = body?.force === true;
  } catch {
    // no body — the button's plain POST
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
  if (!access.row.local_audio_path) {
    return NextResponse.json(
      { error: 'No local audio stored for this transcript' },
      { status: 409 }
    );
  }

  try {
    const [content, resolved] = await Promise.all([
      getContentCached(access.ownerUserId, access.row),
      resolveMeetingContent(access.row),
    ]);
    const suggestions = await suggestSpeakersForTranscript(
      access.ownerUserId,
      id,
      resolved.media /* every file: a combined meeting embeds each recording's voices from ITS OWN file (mediaForSpeaker) */,
      content,
      { row: access.row }
    );
    // AI pass retry: only when it isn't already running/completed — a manual
    // "Guess names" click is the recovery path for errored/skipped passes.
    let speakerIdStatus = access.row.speaker_id_status;
    if (
      access.row.speaker_id_status !== 'running' &&
      (force || access.row.speaker_id_status !== 'completed')
    ) {
      void identifySpeakers(access.ownerUserId, id, {
        force: true,
        triggeredBy: { userId: user.userId, email: user.email },
      });
      speakerIdStatus = 'running';
    }
    return NextResponse.json({ suggestions, speakerIdStatus });
  } catch (err) {
    console.error('[speakers/suggest] failed:', err);
    return NextResponse.json(
      { error: 'Voiceprint matching failed', detail: String(err) },
      { status: 502 }
    );
  }
});
