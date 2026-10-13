import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { transcriptionVersionsEnabled } from '@/db-ops/transcriptions';
import { meetingVersionContent } from '@/lib/server/transcription-content';
import { isTranscriptionId } from '@/lib/server/merge-request';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/transcriptions/:tid/content — readers
 * (docs/transcription-merge-spec.md §3b).
 *
 * One version's utterances — the active one or any other completed version of
 * the meeting's recording — so an agent can read a helper pass before
 * deciding to merge or switch. `TranscriptionContentResponse` in
 * lib/transcriptions.ts. Speaker names apply only where the version shares
 * the active version's labels; the rules are in lib/server/transcription-content.ts.
 *
 * PRIVACY: `resolveAccess` on the MEETING first; `tid` from another recording
 * is a 404, the same as a missing one.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id, tid } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isTranscriptionId(tid)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await transcriptionVersionsEnabled())) {
    return NextResponse.json(
      { error: 'Transcription versions are not available on this server.' },
      { status: 409 }
    );
  }
  const out = await meetingVersionContent(access.row, access.ownerUserId, tid);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out.body, { headers: { 'Cache-Control': 'private, no-store' } });
});
