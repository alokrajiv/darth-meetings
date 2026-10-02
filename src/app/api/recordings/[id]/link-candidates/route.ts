import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getStandaloneForOwner, standaloneColumnsExist } from '@/db-ops/standalone-recordings';
import { occurrenceCandidates, occurrenceKeyFromQuery } from '@/lib/server/occurrence-join';

export const runtime = 'nodejs';

/**
 * `GET /api/recordings/:id/link-candidates?event=<key>` (or `?eventId=…
 * &startTime=…[&meetingCode=…]`) — OWNER ONLY.
 *
 * "Does this occurrence already have a meeting I can see?" — asked by the
 * link dialog before it links, so it can offer "Add my recording to it /
 * Keep mine separate" (lib/occurrence-join.ts `joinChoiceCopy`). Answers
 * `LinkCandidatesResponse`: `candidate` = the meeting a default link would
 * join (null = none, the link makes a meeting of its own), `candidates` =
 * every meeting of the occurrence the caller can open, each with whether this
 * recording may join it and the sentence why not.
 *
 * PRIVACY: a recording that is not the caller's is 404 (I2), and the meetings
 * listed are caller-scoped in SQL — only ones the caller can already open.
 */
export const GET = withAuth(async ({ user, request }, { params }) => {
  if (!(await standaloneColumnsExist().catch(() => false))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id } = await params;
  const rec = await getStandaloneForOwner(user.userId, id ?? '');
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const key = await occurrenceKeyFromQuery(user.userId, request.nextUrl.searchParams);
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });
  const out = await occurrenceCandidates(user, key.key, { recordingId: rec.id });
  return NextResponse.json(out);
});
