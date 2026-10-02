import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import {
  fromMeetingBlock,
  occurrenceCandidates,
  occurrenceKeyFromQuery,
} from '@/lib/server/occurrence-join';

export const runtime = 'nodejs';

/**
 * `GET /api/transcripts/:id/link-candidates?event=<key>` (or `?eventId=…
 * &startTime=…`) — owner and editors, the people who may link this meeting.
 *
 * The meeting twin of `/api/recordings/:id/link-candidates`, for the
 * transcript page's "Link a calendar event" dialog and the suggestion strip:
 * when this meeting is nothing but one of the caller's own recordings, and a
 * meeting of that occurrence already exists that the caller can open, the
 * link may FOLD this one into it (`POST …/link-event {mode:'join'}`). Each
 * candidate says whether that is possible and, if not, why (this meeting has
 * notes of its own, the recording is someone else's, …).
 *
 * PRIVACY: the candidates are caller-scoped in SQL; this meeting itself is
 * never one of them.
 */
export const GET = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id ?? '');
  if (!access || access.row.deleted_at) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  const key = await occurrenceKeyFromQuery(user.userId, request.nextUrl.searchParams);
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });
  const from = await fromMeetingBlock(user, access);
  const out = await occurrenceCandidates(user, key.key, {
    recordingId: from.recordingId,
    excludeTranscriptIds: [access.row.id],
    sourceBlock: from.code,
  });
  return NextResponse.json(out);
});
