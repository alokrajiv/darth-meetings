import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { isOwnTenant, parseTeamsJoinLink } from '@/lib/teams-link';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import { GraphApiError, isGraphConfigured } from '@/lib/server/ms-graph';
import { probeTeamsEvidence } from '@/lib/server/teams-evidence';
import { chatVerdictFor } from '@/lib/server/teams-chat-evidence';
import { getMeetingCacheByMeetings, getTeamsJoinUrlByMeeting } from '@/db-ops/gmeet-meeting-cache';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import {
  getCalendarEvent,
  persistCalendarEvents,
  teamsUrlOf,
} from '@/lib/server/meeting-discovery';
import { hasCalendarOccurrence, callerInvolvedInOccurrence } from '@/db-ops/calendar-event-cache';
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
 * Every 200 also carries `chat` — the Teams chat verdict (was the call held /
 * recorded; lib/teams-chat-evidence TeamsChatEvidence) read via the caller's
 * Darth Tasks Microsoft link, cache-first with one live lookup at most; null
 * when never checked and not checkable (feature off / caller not linked and
 * plagueis unreachable). External-tenant occurrences get their cache row
 * created by this (raw.external = true) — chat evidence is all they have.
 *
 * 200 { external: true, tenantId, code, chat, checkedAt } — organized outside our tenant
 * 200 { external: false, code, chat, resolved, hasRecording, hasTranscript,
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
    // Organized outside our tenant: app-only Graph is blind, but the chat
    // thread isn't — the caller's Darth Tasks Microsoft link can read the
    // meeting chat's call events (held / recorded). Cache-first, one live
    // lookup at most, persisted on a row CREATED for the occurrence
    // (raw.external = true) — external occurrences had no cache row before.
    // `code` lets the listing hand the dialog the same key its rows carry.
    // Creation is gated on the occurrence actually existing in the caller's
    // calendar cache: the URL + startTime here are client-supplied, and an
    // ungated CREATE would let any authenticated caller mint one permanent
    // junk cache row (plus a plagueis→Graph call) per fabricated join URL.
    // The verdict itself is still returned either way; updates to an
    // existing row are always allowed.
    const extCode = teamsCacheCode(info.joinWebUrl);
    // PRIVACY GATE (2026-08-24): the URL is client-supplied — verdicts
    // (held / recorded) only for occurrences the caller is actually in.
    const extInvolved = await callerInvolvedInOccurrence(user, extCode, startTime).catch(
      () => false
    );
    if (!extInvolved) {
      return NextResponse.json(
        { error: "This meeting isn't on your calendar — Sync your calendar and try again." },
        { status: 403 }
      );
    }
    const allowCreate = await hasCalendarOccurrence(user.userId, extCode, startTime).catch(
      () => false
    );
    const chat = await chatVerdictFor({
      info,
      external: true,
      eventStart: startTime,
      eventEnd: endTime,
      email: user.email,
      event: eventMeta,
      capturedBy: user.userId,
      allowCreate,
    }).catch(() => null);
    return NextResponse.json({
      external: true as const,
      tenantId: info.tenantId,
      code: extCode,
      chat,
      checkedAt: new Date().toISOString(),
    });
  }
  if (!isGraphConfigured()) {
    return NextResponse.json(
      { error: 'Microsoft Graph is not configured on this server' },
      { status: 503 }
    );
  }

  const code = teamsCacheCode(info.joinWebUrl);
  // PRIVACY GATE (2026-08-24): the identity inputs are client-supplied and
  // the probe is app-only Graph + global-cache reads — refuse unless the
  // caller is involved in the occurrence (own calendar row, or organizer/
  // invitee on any user's cached row; the eventId path just persisted the
  // caller's own event, so it passes by construction).
  const involvedOk = await callerInvolvedInOccurrence(user, code, startTime).catch(() => false);
  if (!involvedOk) {
    return NextResponse.json(
      { error: "This meeting isn't on your calendar — Sync your calendar and try again." },
      { status: 403 }
    );
  }
  // Teams chat verdict (held / recorded) rides along with the artifact
  // probe — cache-first, else one live lookup through the caller's Darth
  // Tasks Microsoft link; persisted on the same cache row (raw.teamsChat).
  const chatP = chatVerdictFor({
    info,
    external: false,
    eventStart: startTime,
    eventEnd: endTime,
    email: user.email,
    event: eventMeta,
    capturedBy: user.userId,
  }).catch(() => null);
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
    const [[row], chat] = await Promise.all([
      getMeetingCacheByMeetings([{ code, startTime }]).catch(() => [null]),
      chatP,
    ]);
    return NextResponse.json({
      external: false as const,
      code,
      chat,
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
      const chat = await chatP;
      return NextResponse.json({
        external: false as const,
        code,
        chat,
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
