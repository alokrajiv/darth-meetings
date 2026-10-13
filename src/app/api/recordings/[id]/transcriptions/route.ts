import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { recordingHasMeeting } from '@/db-ops/transcriptions';
import { ownedRecording, recordingTranscriptions } from '@/lib/server/recording-transcriptions';

export const runtime = 'nodejs';

/**
 * GET /api/recordings/:id/transcriptions — the OWNER's view of every version
 * of a recording (docs/transcription-merge-spec.md §3c). Same
 * `TranscriptionsResponse` as the meeting route. Readable whether or not a
 * meeting holds the recording; `canEdit` is false once one does (the
 * meeting's routes own the writes then).
 *
 * PRIVACY: owner only (`getStandaloneForOwner`); everyone else 404, never 403.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const rec = await ownedRecording(user.userId, id);
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = await recordingTranscriptions(rec, await recordingHasMeeting(rec.id));
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
});
