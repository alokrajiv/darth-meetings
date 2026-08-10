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
import {
  captureMeetActuals,
  findConferenceRecordName,
  utterancesFromEntries,
} from '@/lib/server/gmeet';
import { isOwnTenant, parseTeamsJoinLink, pickOccurrenceArtifacts } from '@/lib/teams-link';
import {
  isGraphConfigured,
  listRecordings,
  listTranscripts,
  resolveMeetingByJoinUrl,
} from '@/lib/server/ms-graph';
import type { GmeetAttendee, GmeetContext, MeetActuals } from '@/lib/format';

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
    /** Caller's Google token — enables the Meet API enrichment pass. */
    accessToken?: string;
    event?: {
      id?: string;
      title?: string;
      startTime?: string;
      endTime?: string;
      meetingCode?: string;
      /** Teams meetup-join link found on the event (raw is fine). */
      teamsUrl?: string;
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

  // Enrichment: if the event had a Meet and we hold a token, capture the
  // same "actuals" an import would — who actually joined (with directory
  // emails), real conference times, and the Meet transcript entries. The
  // entries become a notes cross-reference sidecar; timeline ALIGNMENT is
  // deliberately skipped here (an uploaded recording's t=0 is arbitrary, so
  // overlap voting against Meet's clock could misattribute speakers).
  let actuals: MeetActuals | null = null;
  if (typeof body.accessToken === 'string' && body.accessToken.length > 20 && event.meetingCode) {
    try {
      const recordName = await findConferenceRecordName(
        body.accessToken,
        event.meetingCode,
        event.startTime
      );
      if (recordName) actuals = await captureMeetActuals(body.accessToken, recordName);
    } catch (err) {
      console.warn('[link-event] actuals capture failed (continuing):', err);
    }
  }

  const patch: Partial<GmeetContext> = {
    eventId: event.id,
    eventTitle: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    meetingCode: event.meetingCode,
    attendees,
  };

  // Linked event is a Teams meeting → stamp provider + join facts so the
  // provider chip renders and fetch-recording-later (page effect + the
  // video-fetch sweeper) works on this row. Best-effort app-only resolve
  // pins the occurrence's recordingId; external tenants get the marker only.
  if (typeof event.teamsUrl === 'string') {
    const info = parseTeamsJoinLink(event.teamsUrl);
    if (info) {
      patch.provider = 'teams';
      patch.teams = {
        joinWebUrl: info.joinWebUrl,
        tenantId: info.tenantId,
        organizerOid: info.organizerOid,
        graphMeetingId: '',
      };
      if (isOwnTenant(info) && isGraphConfigured()) {
        try {
          const meeting = await resolveMeetingByJoinUrl(info.organizerOid, info.joinWebUrl);
          if (meeting) {
            const [transcripts, recordings] = await Promise.all([
              listTranscripts(info.organizerOid, meeting.id),
              listRecordings(info.organizerOid, meeting.id),
            ]);
            const windowStart = event.startTime ?? meeting.startDateTime;
            const windowEnd = event.endTime ?? meeting.endDateTime ?? windowStart;
            const picked =
              windowStart && windowEnd
                ? pickOccurrenceArtifacts(transcripts, recordings, windowStart, windowEnd)
                : { transcript: undefined, recording: undefined };
            patch.teams = {
              ...patch.teams,
              graphMeetingId: meeting.id,
              callId: picked.transcript?.callId ?? picked.recording?.callId,
              transcriptId: picked.transcript?.id,
              recordingId: picked.recording?.id,
            };
          }
        } catch (err) {
          console.warn('[link-event] teams resolution failed (continuing):', err);
        }
      }
    }
  }
  if (actuals) {
    patch.actuals = actuals;
    if (actuals.transcriptEntries && actuals.transcriptEntries.length > 0) {
      patch.meetTranscript = {
        attendees: (actuals.participants ?? []).map((p) => p.displayName),
        utterances: utterancesFromEntries(actuals.transcriptEntries),
      };
    }
  }
  await mergeGmeetContextForUser(access.ownerUserId, id, patch);

  const startIso = event.startTime ?? actuals?.conferenceStart;
  if (startIso && !Number.isNaN(Date.parse(startIso))) {
    await setRecordedAtForUser(access.ownerUserId, id, new Date(startIso));
  }

  // Fill an empty title from the event — never clobber an existing one.
  if (event.title && !access.row.title?.trim()) {
    await updateMetaForUser(access.ownerUserId, id, { title: event.title });
  }

  await registerPeopleFromMeeting(
    [
      ...attendees.map((a) => ({ email: a.email, name: a.name })),
      ...(actuals?.participants ?? [])
        .filter((p) => p.email)
        .map((p) => ({ email: p.email!, name: p.displayName })),
    ],
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
