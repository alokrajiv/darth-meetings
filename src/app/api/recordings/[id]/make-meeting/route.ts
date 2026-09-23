import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { standaloneColumnsExist } from '@/db-ops/standalone-recordings';
import { makeMeetingFromRecording } from '@/lib/server/recording-actions';

export const runtime = 'nodejs';

/**
 * `POST /api/recordings/:id/make-meeting { title }` — the OWNER makes a
 * standalone meeting of their recording (design Q5: a name makes a meeting).
 * Same transaction as Link, no calendar event, no share. 404 for a recording
 * that is not the caller's; 409 while it is still transcribing or already in
 * a meeting.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  if (!(await standaloneColumnsExist().catch(() => false))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const out = await makeMeetingFromRecording(user, id ?? '', body?.title);
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status });
  return NextResponse.json(out.body, { status: 201 });
});
