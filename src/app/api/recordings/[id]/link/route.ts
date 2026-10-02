import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { standaloneColumnsExist } from '@/db-ops/standalone-recordings';
import { linkRecording } from '@/lib/server/recording-actions';
import { isClipTextPolicy } from '@/lib/recording-clips';

export const runtime = 'nodejs';

/**
 * `POST /api/recordings/:id/link` — the OWNER links their recording
 * (design P7, rule 4: linking is a user action, never a machine match).
 *
 * Body: `{ event | eventRef | eventKey, title? }` → a NEW meeting linked to that
 * occurrence of the caller's calendar, holding this recording as its one
 * clip, in one transaction; its `/content` is the recording's transcript
 * verbatim. Or `{ meetingId, offsetMs?, textPolicy? }` → the recording is
 * added to a meeting the caller owns or can edit (Phase 3b, MW_COMBINE).
 *
 * A link to an event shares the new MEETING with the event's internal
 * invitees, exactly as a cloud import does (meeting policy, owner
 * 2026-10-02; stamped `origin='event-link'` so Unlink takes them back off).
 * The RECORDING is never shared: every `/api/recordings/*` route still
 * answers to its owner alone. Answers `{ meeting: {id, title}, recordingId,
 * shares }` (`shares` = how many invitees were shared; 0 for `meetingId`). 404 for a recording that is not the caller's;
 * 409 `not-ready` while it is still transcribing, `already-linked` when a
 * meeting already holds it.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  if (!(await standaloneColumnsExist().catch(() => false))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const out = await linkRecording(user, id ?? '', {
    event: body.event ?? null,
    eventRef: str(body.eventRef),
    eventKey: str(body.eventKey),
    meetingId: str(body.meetingId),
    title: str(body.title),
    offsetMs: typeof body.offsetMs === 'number' ? body.offsetMs : null,
    textPolicy: isClipTextPolicy(body.textPolicy) ? body.textPolicy : null,
  });
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status });
  return NextResponse.json(out.body, { status: 201 });
});
