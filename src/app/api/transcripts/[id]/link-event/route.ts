import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import {
  getForUser,
  mergeGmeetContextForUser,
  setRecordedAtForUser,
  setScratchForUser,
  updateMetaForUser,
} from '@/db-ops/transcripts';
import { logActivity } from '@/db-ops/transcript-activity';
import { registerPeopleFromMeeting } from '@/lib/server/import-helpers';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { identifySpeakers } from '@/lib/server/auto-notes';
import { getForUser as getSpeakerMappings } from '@/db-ops/speaker-mappings';
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
 * event it came from. Two callers:
 *   - the web link dialog browses the user's calendar with their own Google
 *     token and sends the picked `event` (+ `accessToken` for enrichment);
 *   - headless callers (darth-cli `link <id> <ref>`) send `meetingCode` or
 *     `eventKey` and the server resolves the event from the caller's own
 *     calendar cache, minting its backend Google token for enrichment.
 * Either way we merge the event into gmeet_context — which immediately
 * lights up share suggestions for the invitees — set the meeting date, fill
 * an empty title, register the attendees in the people directory and, when
 * the row is completed and nobody has confirmed speaker names yet, re-run
 * the speaker-ID pass with the attendee list as hints (a scratch upload's
 * first pass ran blind). Linking also clears the temporary flag (migration
 * 042): a transcript tied to a calendar event is a real meeting and belongs
 * in the archive. Owner and editors.
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
    /** Headless form: resolve the event server-side from the caller's
     * calendar cache. Either one; `event` wins when also present. */
    meetingCode?: string;
    eventKey?: string;
    event?: {
      id?: string;
      title?: string;
      startTime?: string;
      endTime?: string;
      meetingCode?: string;
      /** Teams meetup-join link found on the event (raw is fine). */
      teamsUrl?: string;
      recurringEventId?: string;
      iCalUID?: string;
      organizerEmail?: string;
      attendees?: GmeetAttendee[];
    };
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  let event: NonNullable<typeof body.event>;
  if (body.event && typeof body.event === 'object') {
    event = body.event;
  } else {
    const ref =
      typeof body.eventKey === 'string' && body.eventKey.trim()
        ? body.eventKey
        : typeof body.meetingCode === 'string' && body.meetingCode.trim()
          ? body.meetingCode
          : null;
    if (!ref) {
      return NextResponse.json(
        { error: 'event (object) or meetingCode / eventKey (reference) is required' },
        { status: 400 }
      );
    }
    const resolved = await resolveLinkedEventRef(user.userId, ref);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    event = {
      id: resolved.event.id,
      title: resolved.event.title,
      startTime: resolved.event.startTime,
      endTime: resolved.event.endTime,
      meetingCode: resolved.event.meetingCode,
      teamsUrl: resolved.event.teamsUrl,
      recurringEventId: resolved.event.recurringEventId,
      iCalUID: resolved.event.iCalUID,
      organizerEmail: resolved.event.organizerEmail,
      attendees: resolved.event.attendees.map((a) => ({
        email: a.email,
        name: a.name,
        responseStatus: a.responseStatus,
      })),
    };
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
  const isTeams = !!event.meetingCode?.startsWith('teams-') || typeof event.teamsUrl === 'string';
  let accessToken: string | null =
    typeof body.accessToken === 'string' && body.accessToken.length > 20 ? body.accessToken : null;
  if (!accessToken && event.meetingCode && !isTeams) {
    // Headless caller: the backend Google link stands in for the browser
    // token (best-effort — no link, no enrichment, still a valid link).
    try {
      accessToken = (await getServerAccessToken(user.userId))?.token ?? null;
    } catch (err) {
      console.warn('[link-event] server token mint failed (continuing):', err);
    }
  }
  if (accessToken && event.meetingCode && !isTeams) {
    try {
      const recordName = await findConferenceRecordName(
        accessToken,
        event.meetingCode,
        event.startTime
      );
      if (recordName) actuals = await captureMeetActuals(accessToken, recordName);
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
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.iCalUID ? { iCalUID: event.iCalUID } : {}),
    ...(event.organizerEmail ? { organizerEmail: event.organizerEmail } : {}),
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
  // Temporary → permanent: linking says "this is a real meeting".
  if (access.row.scratch) {
    await setScratchForUser(access.ownerUserId, id, false);
  }

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
    details: {
      linkedEvent: event.title ?? event.id ?? true,
      ...(access.row.scratch ? { scratch: false } : {}),
    },
  });

  // Speaker re-guess: a scratch upload's ID pass ran with no attendee hints.
  // Now that the audience is known, run it again — but only while nobody
  // has confirmed names (a human's review must never be overwritten) and
  // no pass is in flight. Fire-and-forget; results land in the usual
  // suggestions map (GET /speakers).
  let reguessing = false;
  if (
    attendees.length > 0 &&
    access.row.status === 'completed' &&
    access.row.local_audio_path &&
    access.row.speaker_id_status !== 'running'
  ) {
    const mappings = await getSpeakerMappings(access.ownerUserId, id);
    const confirmed = (mappings?.speaker_labels ?? []).some((l) => l.customName?.trim());
    if (!confirmed) {
      reguessing = true;
      void identifySpeakers(access.ownerUserId, id, {
        force: true,
        triggeredBy: { userId: user.userId, email: user.email },
      });
    }
  }

  const updated = await getForUser(access.ownerUserId, id);
  return NextResponse.json({
    transcript: updated
      ? { ...updated, access: access.access, owner_email: null, owner_name: null }
      : null,
    event: {
      id: event.id ?? null,
      title: event.title ?? null,
      startTime: event.startTime ?? null,
      endTime: event.endTime ?? null,
      meetingCode: event.meetingCode ?? null,
      provider: isTeams ? 'teams' : event.meetingCode ? 'gmeet' : null,
      attendees: attendees.length,
      enriched: !!actuals,
    },
    reguessing,
  });
});
