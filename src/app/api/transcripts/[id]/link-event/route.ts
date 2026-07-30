import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import {
  getForUser,
  mergeGmeetContextForUser,
  setRecordedAtForUser,
  updateMetaForUser,
} from '@/db-ops/transcripts';
import { logActivity } from '@/db-ops/transcript-activity';
import { registerPeopleFromMeeting } from '@/lib/server/import-helpers';
import type { GmeetAttendee } from '@/lib/format';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/link-event
 *
 * Retro-link a transcript (typically an uploaded recording) to the calendar
 * event it came from. The client browses the user's calendar with their own
 * Google token and sends the picked event; we merge it into gmeet_context —
 * which immediately lights up share suggestions for the invitees — set the
 * meeting date, fill an empty title, and register the attendees in the
 * people directory. Owner and editors.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  let body: {
    event?: {
      id?: string;
      title?: string;
      startTime?: string;
      endTime?: string;
      meetingCode?: string;
      attendees?: GmeetAttendee[];
    };
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const event = body.event;
  if (!event || typeof event !== 'object') {
    return NextResponse.json({ error: 'event is required' }, { status: 400 });
  }

  const attendees: GmeetAttendee[] = Array.isArray(event.attendees)
    ? event.attendees
        .filter((a) => a && typeof a.email === 'string')
        .map((a) => ({ email: a.email, name: a.name, responseStatus: a.responseStatus }))
    : [];

  await mergeGmeetContextForUser(access.ownerUserId, id, {
    eventId: event.id,
    eventTitle: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    meetingCode: event.meetingCode,
    attendees,
  });

  if (event.startTime && !Number.isNaN(Date.parse(event.startTime))) {
    await setRecordedAtForUser(access.ownerUserId, id, new Date(event.startTime));
  }

  // Fill an empty title from the event — never clobber an existing one.
  if (event.title && !access.row.title?.trim()) {
    await updateMetaForUser(access.ownerUserId, id, { title: event.title });
  }

  await registerPeopleFromMeeting(
    attendees.map((a) => ({ email: a.email, name: a.name })),
    user.userId
  );

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'edit_meta',
    details: { linkedEvent: event.title ?? event.id ?? true },
  });

  const updated = await getForUser(access.ownerUserId, id);
  return NextResponse.json({
    transcript: updated
      ? { ...updated, access: access.access, owner_email: null, owner_name: null }
      : null,
  });
});
