import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { transcriptionVersionsEnabled } from '@/db-ops/transcriptions';
import { isTranscriptionId } from '@/lib/server/merge-request';
import { ownedRecording } from '@/lib/server/recording-transcriptions';
import { recordingVersionContent } from '@/lib/server/transcription-content';

export const runtime = 'nodejs';

/**
 * GET /api/recordings/:id/transcriptions/:tid/content — one version of the
 * OWNER's recording, active or not (docs/transcription-merge-spec.md §3c).
 * Same `TranscriptionContentResponse` as the meeting route; speakers are the
 * diarization labels (names belong to meetings). Readable whether or not a
 * meeting holds the recording.
 *
 * PRIVACY: owner only; everyone else 404, never 403.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id, tid } = await params;
  const rec = await ownedRecording(user.userId, id);
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isTranscriptionId(tid)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await transcriptionVersionsEnabled())) {
    return NextResponse.json(
      { error: 'Transcription versions are not available on this server.' },
      { status: 409 }
    );
  }
  const out = await recordingVersionContent(rec.id, rec.active_transcription_id, tid);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out.body, { headers: { 'Cache-Control': 'private, no-store' } });
});
