import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { findCalendarEventForImport } from '@/db-ops/calendar-event-cache';
import { getTeamsJoinUrlByMeeting } from '@/db-ops/gmeet-meeting-cache';
import { resolveMeetingByAnyTranscriptId } from '@/db-ops/meetings';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { executeGmeetImport } from '@/lib/server/gmeet-import-core';
import { executeTeamsImport } from '@/lib/server/teams-import-core';
import type { CalendarEventAttendee } from '@/db-ops/calendar-event-cache';

export const runtime = 'nodejs';
export const maxDuration = 600;

const MODES = ['transcript', 'video', 'both'] as const;
type Mode = (typeof MODES)[number];

/**
 * POST /api/meetings/import — headless import-by-reference (T3: the CLI's
 * `meetings import` verb; any client without a browser Google token).
 *
 * Body: { meetingCode?: string; eventKey?: string; mode?: 'transcript' |
 * 'video' | 'both' (default 'transcript') }
 *
 * The occurrence is resolved from the CALLER'S OWN calendar cache (per-user
 * rows from their own sweeps — involvement is implicit, same privacy stance
 * as the calendar layers). Google imports run under the caller's
 * server-minted token (backend OAuth); Teams runs app-only off the join URL
 * a past probe stashed. Both paths go through the same execute cores as the
 * dialog with defer+background on, so not-ready artifacts queue instead of
 * failing and heavy pulls never block the request.
 *
 * Response mirrors the core outcome (201 imported / 202 queued / 409 dupe /
 * 4xx) plus `meetingId`/`meetingUrl` — the stable /m/<uuid> handle that
 * survives placeholder promotion (T1).
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: {
    meetingCode?: unknown;
    eventKey?: unknown;
    mode?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const meetingCode =
    typeof body.meetingCode === 'string' && body.meetingCode.trim().length > 0
      ? body.meetingCode.trim()
      : undefined;
  const eventKey =
    typeof body.eventKey === 'string' && body.eventKey.trim().length > 0
      ? body.eventKey.trim()
      : undefined;
  if (!meetingCode && !eventKey) {
    return NextResponse.json({ error: 'meetingCode or eventKey required' }, { status: 400 });
  }
  const mode: Mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : 'transcript';

  const row = await findCalendarEventForImport(user.userId, { meetingCode, eventKey });
  if (!row) {
    return NextResponse.json(
      {
        error:
          'No such meeting in your calendar cache. It must be a (past) occurrence from your own calendar — check `calendar` for the [meeting-code], or open the web app and Sync first.',
      },
      { status: 404 }
    );
  }
  if (!row.meeting_code) {
    return NextResponse.json(
      { error: 'That calendar event has no Meet/Teams meeting attached — nothing to import.' },
      { status: 422 }
    );
  }

  const importUser = { userId: user.userId, email: user.email };
  const event = {
    id: row.event_id,
    title: row.title ?? undefined,
    startTime: row.event_start,
    endTime: row.event_end ?? undefined,
    meetingCode: row.meeting_code,
    recurringEventId: row.recurring_event_id ?? undefined,
    iCalUID: row.ical_uid ?? undefined,
    organizerEmail: row.organizer_email ?? undefined,
    attendees: (row.attendees ?? undefined) as CalendarEventAttendee[] | undefined,
  };

  let outcome: { status: number; body: Record<string, unknown> };
  if (row.meeting_code.startsWith('teams-')) {
    const url = await getTeamsJoinUrlByMeeting(row.meeting_code, row.event_start);
    if (!url) {
      return NextResponse.json(
        {
          error:
            'No Teams join URL known for this occurrence yet — open it in the web app once (Check…) so the probe can resolve it, then retry.',
        },
        { status: 409 }
      );
    }
    outcome = await executeTeamsImport(importUser, {
      url,
      mode,
      defer: true,
      background: true,
      event,
    });
  } else {
    const minted = await getServerAccessToken(user.userId);
    if (!minted) {
      return NextResponse.json(
        {
          error:
            'Google is not connected for your account — connect it once in the web app (Settings), then imports work from anywhere.',
          connected: false,
        },
        { status: 409 }
      );
    }
    outcome = await executeGmeetImport(importUser, {
      accessToken: minted.token,
      mode,
      videoFileId: row.attachment_video_file_id ?? undefined,
      transcriptDocId: row.attachment_transcript_doc_id ?? undefined,
      defer: true,
      background: true,
      event,
    });
  }

  // Attach the stable handle (T1) so callers can hold one id through
  // placeholder promotion.
  const transcript = outcome.body.transcript as { assemblyai_id?: string } | undefined;
  let meetingId: string | null = null;
  if (transcript?.assemblyai_id) {
    const m = await resolveMeetingByAnyTranscriptId(transcript.assemblyai_id).catch(() => null);
    meetingId = m?.id ?? null;
  }
  return NextResponse.json(
    { ...outcome.body, meetingId, meetingUrl: meetingId ? `/m/${meetingId}` : null },
    { status: outcome.status }
  );
});
