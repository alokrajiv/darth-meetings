import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { recordingRunInFlight, setRecordingActiveTranscription } from '@/db-ops/transcriptions';
import { isTranscriptionId } from '@/lib/server/merge-request';
import { ownedRecording, writeRefusal } from '@/lib/server/recording-transcriptions';
import type { ActivateTranscriptionResponse } from '@/lib/transcriptions';

export const runtime = 'nodejs';

/**
 * POST /api/recordings/:id/transcriptions/:tid/activate — "use this version"
 * for a recording that belongs to NO meeting (docs/transcription-merge-spec.md
 * §3c): `recordings.active_transcription_id` moves, and nothing else does —
 * without a meeting there are no edits or speaker names to set aside, so
 * `setAside` / `restored` are always zero. The OWNER only; 409
 * `{ error, meetingId }` once a meeting holds the recording.
 *
 * PRIVACY: owner only; everyone else 404, never 403. `tid` must be a
 * completed version of THIS recording.
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id, tid } = await params;
  const rec = await ownedRecording(user.userId, id);
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isTranscriptionId(tid)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const refusal = await writeRefusal(rec, { userId: user.userId, email: user.email });
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });
  if (await recordingRunInFlight(rec.id)) {
    return NextResponse.json(
      { error: 'A new transcription is running — wait for it to land before switching versions.' },
      { status: 409 }
    );
  }
  if (rec.active_transcription_id === tid) {
    const body: ActivateTranscriptionResponse = { error: 'That version is already the one being shown.' };
    return NextResponse.json(body, { status: 409 });
  }
  if (!(await setRecordingActiveTranscription(rec.id, tid))) {
    const body: ActivateTranscriptionResponse = {
      error: 'That is not a completed version of this recording.',
    };
    return NextResponse.json(body, { status: 409 });
  }
  const body: ActivateTranscriptionResponse = {
    ok: true,
    activeId: tid,
    setAside: { edits: 0, speakerNames: 0 },
    restored: { edits: 0, speakerNames: 0 },
  };
  return NextResponse.json(body);
});
