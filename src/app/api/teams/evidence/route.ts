import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { isOwnTenant, parseTeamsJoinLink } from '@/lib/teams-link';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import { GraphApiError, isGraphConfigured } from '@/lib/server/ms-graph';
import { probeTeamsEvidence } from '@/lib/server/teams-evidence';
import { getMeetingCacheByMeetings, getTeamsJoinUrlByMeeting } from '@/db-ops/gmeet-meeting-cache';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import {
  getCalendarEvent,
  persistCalendarEvents,
  teamsUrlOf,
} from '@/lib/server/meeting-discovery';
import { findImportedByTeamsMeetings } from '@/db-ops/teams-import';

export const runtime = 'nodejs';

/**
 * POST /api/teams/evidence — Teams twin of /api/meet/evidence: "what does
 * Microsoft hold for THIS occurrence?" — ONE live Graph probe through the
 * shared `probeTeamsEvidence` (the poller's code path), written back to the
 * artifact cache. The listing's "Check…" on a No-recording Teams row and the
 * dialog's "Check again" call this; /api/teams/check stays cache-only.
 *
 * Body (one of `url` / `meetingCode` / `eventId` identifies the meeting —
 * tried in that order):
 *   { url?: string            // raw Teams meetup-join link (dialog has it)
 *     meetingCode?: string    // `teams-<hash>` cache code (listing rows)
 *     eventId?: string        // caller's calendar event id — resolved live
 *                             //   through their own Google token when the
 *                             //   cache has no URL for the code
 *     startTime: string, endTime?: string,
 *     event?: { recurringEventId?, iCalUID?, organizerEmail? } }
 *
 * 200 { external: true, tenantId }                  — organized outside our tenant
 * 200 { external: false, code, resolved, hasRecording, hasTranscript,
 *       verdict: { hasRecording, hasTranscript, pending: false, importable },
 *       imported, checkFailed: false, checkedAt }
 * 200 { …, checkFailed: true, error }               — Graph refused (status/code in error)
 * 400 no usable identity / bad start; 404 Google not connected (eventId path);
 * 422 the event has no Teams link; 503 Graph not configured.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    url?: string;
    meetingCode?: string;
    eventId?: string;
    startTime?: string | null;
    endTime?: string | null;
    event?: {
      recurringEventId?: string | null;
      iCalUID?: string | null;
      organizerEmail?: string | null;
    } | null;
  } | null;
  const startTime =
    typeof body?.startTime === 'string' && !Number.isNaN(Date.parse(body.startTime))
      ? body.startTime
      : null;
  let endTime =
    typeof body?.endTime === 'string' && !Number.isNaN(Date.parse(body.endTime))
      ? body.endTime
      : null;
  const meetingCode =
    typeof body?.meetingCode === 'string' && /^teams-[0-9a-f]{12}$/.test(body.meetingCode)
      ? body.meetingCode
      : null;
  const eventId = typeof body?.eventId === 'string' && body.eventId.trim() ? body.eventId.trim() : null;
  let url = typeof body?.url === 'string' && body.url.trim() ? body.url.trim() : null;
  let eventMeta = body?.event ?? null;

  if (!url && !meetingCode && !eventId) {
    return NextResponse.json(
      { error: 'One of url / meetingCode / eventId is required' },
      { status: 400 }
    );
  }
  if (!startTime) {
    return NextResponse.json({ error: 'startTime (ISO) is required' }, { status: 400 });
  }

  // 1. The cache already knows the canonical URL for this code (any past
  //    probe of the series stashed it) — no Google round-trip needed.
  if (!url && meetingCode) {
    url = await getTeamsJoinUrlByMeeting(meetingCode, startTime).catch(() => null);
  }
  // 2. Else read the caller's own calendar event live (their server-minted
  //    token) — and persist it, which also rewrites the calendar-cache row's
  //    meeting_code to the canonical hash (legacy rows hashed the raw link).
  if (!url && eventId) {
    const minted = await getServerAccessToken(user.userId);
    if (!minted) {
      return NextResponse.json(
        { connected: false, error: 'Google account not connected' },
        { status: 404 }
      );
    }
    const ev = await getCalendarEvent(minted.token, eventId);
    if (!ev) {
      return NextResponse.json(
        { error: 'Calendar event not found (removed, or not on your primary calendar)' },
        { status: 404 }
      );
    }
    url = teamsUrlOf(ev);
    if (!url) {
      return NextResponse.json({ error: 'This event has no Teams link' }, { status: 422 });
    }
    endTime = endTime ?? ev.end?.dateTime ?? null;
    eventMeta = eventMeta ?? {
      recurringEventId: ev.recurringEventId ?? null,
      iCalUID: ev.iCalUID ?? null,
      organizerEmail: ev.organizer?.email ?? null,
    };
    await persistCalendarEvents(user.userId, [ev]);
  }
  if (!url) {
    return NextResponse.json(
      { error: 'Could not find the Teams link for this meeting — pass eventId or url' },
      { status: 400 }
    );
  }

  const info = parseTeamsJoinLink(url);
  if (!info) {
    return NextResponse.json({ error: 'Not a parseable Teams meetup-join link' }, { status: 422 });
  }
  if (!isOwnTenant(info)) {
    // `code` lets the listing hand the dialog the same key its rows carry.
    return NextResponse.json({
      external: true as const,
      tenantId: info.tenantId,
      code: teamsCacheCode(info.joinWebUrl),
    });
  }
  if (!isGraphConfigured()) {
    return NextResponse.json(
      { error: 'Microsoft Graph is not configured on this server' },
      { status: 503 }
    );
  }

  const code = teamsCacheCode(info.joinWebUrl);
  const importedP = findImportedByTeamsMeetings(
    [{ joinWebUrl: info.joinWebUrl, startTime }],
    { userId: user.userId, email: user.email }
  ).catch(() => [null]);

  try {
    const probe = await probeTeamsEvidence({
      info,
      eventStart: startTime,
      eventEnd: endTime ?? startTime,
      event: eventMeta,
      capturedBy: user.userId,
    });
    const [imported] = await importedP;
    const [row] = await getMeetingCacheByMeetings([{ code, startTime }]).catch(() => [null]);
    return NextResponse.json({
      external: false as const,
      code,
      resolved: probe.resolved,
      probed: probe.probed,
      hasRecording: probe.hasRecording,
      hasTranscript: probe.hasTranscript,
      verdict: {
        hasRecording: probe.hasRecording,
        hasTranscript: probe.hasTranscript,
        pending: false,
        importable: probe.hasRecording || probe.hasTranscript,
      },
      imported: imported
        ? {
            assemblyaiId: imported.accessible ? imported.assemblyai_id : null,
            title: imported.accessible ? imported.title : null,
            ownerEmail: imported.owner_email,
            accessible: imported.accessible,
            mine: imported.mine,
          }
        : null,
      meta: row
        ? {
            hasTranscript: row.transcript_parseable === true,
            hasRecording: row.ready_recording_count > 0,
            utteranceCount: row.utterance_count,
            wordCount: row.word_count,
            speakers: row.speakers,
            videoDurationMs: row.video_duration_ms,
            confStart: row.conf_start,
            confEnd: row.conf_end,
          }
        : null,
      checkFailed: false,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GraphApiError) {
      console.warn('[teams/evidence] Graph probe failed for', code, err.status, err.code ?? '');
      return NextResponse.json({
        external: false as const,
        code,
        resolved: false,
        probed: true,
        hasRecording: false,
        hasTranscript: false,
        verdict: { hasRecording: false, hasTranscript: false, pending: false, importable: false },
        imported: null,
        meta: null,
        checkFailed: true,
        error: `Microsoft didn’t answer (${err.status}${err.code ? ` ${err.code}` : ''})`,
        checkedAt: new Date().toISOString(),
      });
    }
    throw err;
  }
});
