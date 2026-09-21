import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { transcriptionVersionsEnabled } from '@/db-ops/transcriptions';
import { activateTranscription } from '@/lib/server/transcription-runs';
import type { ActivateTranscriptionResponse } from '@/lib/transcriptions';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/transcripts/:id/transcriptions/:tid/activate — editors only.
 *
 * "Use this version": the meeting's text becomes `tid`'s, the edits and
 * speaker names of the version being left are parked with it, and whatever
 * was parked with `tid` comes back (docs/recordings-phase2-spec.md "Model").
 * Instant and reversible — the one sentence the UI shows afterwards is built
 * from `setAside` / `restored`.
 *
 * Refuses a version that is still running or that failed: there is no payload
 * to put on the meeting, and archiving the user's annotations against nothing
 * would lose them.
 *
 * PRIVACY: `resolveAccess` on the MEETING, editors only, and `tid` is proven
 * to belong to that meeting's recording inside `activateTranscription` — a
 * uuid from another meeting answers 404, not somebody else's transcript
 * (feedback_privacy_caller_scoping_gate).
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id, tid } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }
  if (!tid || !UUID_RE.test(tid)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!(await transcriptionVersionsEnabled())) {
    return NextResponse.json(
      { error: 'Transcription versions are not available on this server.' },
      { status: 409 }
    );
  }
  if (access.row.gmeet_context?.retranscribing) {
    return NextResponse.json(
      { error: 'A new transcription is running — wait for it to land before switching versions.' },
      { status: 409 }
    );
  }

  const out = await activateTranscription({
    ownerUserId: access.ownerUserId,
    assemblyaiId: access.row.assemblyai_id,
    targetTranscriptionId: tid,
  });
  if (!out.ok) {
    const body: ActivateTranscriptionResponse = { error: out.error };
    return NextResponse.json(body, { status: out.status });
  }
  const body: ActivateTranscriptionResponse = {
    ok: true,
    activeId: out.activeId,
    setAside: out.setAside,
    restored: out.restored,
  };
  return NextResponse.json(body);
});
