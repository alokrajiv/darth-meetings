import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import {
  countCalendarMeetings,
  listCalendarMeetingsPage,
  type CalendarMeetingDbRow,
  type CalendarMeetingView,
} from '@/db-ops/calendar-event-cache';
import { findSeriesByRecurringBaseIds } from '@/db-ops/series';
import { recurringBaseId } from '@/lib/series-keys';

export const runtime = 'nodejs';

/**
 * GET /api/calendar-meetings?view=unimported|norec — the two calendar-backed
 * listing views:
 *
 *  - unimported: meetings whose recording/transcript exists at Google (or
 *    Microsoft) but nobody imported — from the global artifact cache.
 *  - norec: the caller's own past calendar events that left no artifacts at
 *    all — from their per-user calendar_event_cache sweep rows.
 *
 * Same from/to/tz/days/minRows/cursor semantics as the listing v2 endpoint:
 * whole-day buckets, newest first, a day is never split across pages.
 * Display-only rule: never returns tokens or file IDs — importing always
 * goes through the existing dialog flow (caller's own Google token).
 */

/** Row shape served to the frontend (workstream D `import type`s this). */
export interface CalendarMeetingRow {
  /** event_key of the underlying cache row. */
  key: string;
  meetingCode: string | null;
  title: string | null;
  eventStart: string;
  eventEnd: string | null;
  /** conf_end-conf_start or video_duration_ms/1000 when known. */
  durationSecs: number | null;
  hasRecording: boolean;
  hasTranscript: boolean;
  recordingCount: number;
  transcriptParseable: boolean | null;
  organizerEmail: string | null;
  organizerSelf: boolean | null;
  provider: 'gmeet' | 'teams';
  attendeeCount: number | null;
  /** norec rows: whether the event even had a Meet link. */
  hasMeet: boolean;
  muted: boolean;
  /** Calendar event id (unimported rows: from the caller's own calendar row
   * for the occurrence, when they have one). */
  eventId: string | null;
  /** Drive file id of the first recording — deep link for diagnosis.
   * Display-only: Google enforces access when the link is opened. */
  videoFileId: string | null;
  /** First transcript Google-Doc id — deep link for diagnosis. */
  transcriptDocId: string | null;
  /** Stable series id — the "Hide all + future" mute value. */
  recurringEventId: string | null;
  /** Cached occurrences of the series ("Hide all N…"); null = not recurring. */
  seriesCount: number | null;
  /** App-level series this occurrence belongs to (recurring-base-id match) —
   * renders the same member chip archive rows get; click opens SeriesDialog. */
  seriesId: number | null;
  seriesTitle: string | null;
}

export interface CalendarMeetingsResponse {
  days: Array<{ key: string; rows: CalendarMeetingRow[] }>;
  counts: { unimported: number; norec: number };
  nextCursor: string | null;
  hasMore: boolean;
  connected: boolean;
  /** First-sweep progress for the caller's Google account. `syncing` is true
   * from connect until the poller stamps last_poll_at — the UI shows a
   * "still syncing, events may be missing" banner while it holds. */
  sync: {
    connectedAt: string | null;
    lastPollAt: string | null;
    syncing: boolean;
  };
}

// Digits included so zones like 'Etc/GMT+8' pass — same allow-list as the
// listing v2 endpoint; the Intl check below rejects made-up names.
const TZ_RE = /^[A-Za-z0-9_/+-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeTz(raw: string | null): string {
  if (!raw || !TZ_RE.test(raw)) return 'UTC';
  try {
    // Same IANA database as Postgres — rejects made-up names before SQL does.
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    return 'UTC';
  }
}

function dayParam(raw: string | null): string | null {
  return raw && DAY_RE.test(raw) ? raw : null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isoOf(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toRow(
  r: CalendarMeetingDbRow,
  seriesByBase: Map<string, { series_id: number; title: string }>
): CalendarMeetingRow {
  const series = r.recurring_event_id
    ? (seriesByBase.get(recurringBaseId(r.recurring_event_id)) ?? null)
    : null;
  return {
    key: r.key,
    meetingCode: r.meeting_code,
    title: r.title,
    eventStart: isoOf(r.event_start),
    eventEnd: r.event_end == null ? null : isoOf(r.event_end),
    durationSecs: r.duration_secs == null ? null : Math.round(r.duration_secs),
    hasRecording: r.has_recording,
    hasTranscript: r.has_transcript,
    recordingCount: r.recording_count,
    transcriptParseable: r.transcript_parseable,
    organizerEmail: r.organizer_email,
    organizerSelf: r.organizer_self,
    provider: r.provider,
    attendeeCount: r.attendee_count,
    hasMeet: r.has_meet,
    muted: r.muted,
    eventId: r.event_id,
    videoFileId: r.video_file_id,
    transcriptDocId: r.transcript_doc_id,
    recurringEventId: r.recurring_event_id,
    seriesCount: r.series_count,
    seriesId: series?.series_id ?? null,
    seriesTitle: series?.title ?? null,
  };
}

export const GET = withAuth(async ({ user, request }) => {
  const params = request.nextUrl.searchParams;
  const view = params.get('view');
  if (view !== 'unimported' && view !== 'norec') {
    return NextResponse.json(
      { error: "Expected ?view=unimported|norec" },
      { status: 400 }
    );
  }
  const tz = safeTz(params.get('tz'));
  const range = { tz, from: dayParam(params.get('from')), to: dayParam(params.get('to')) };
  const caller = { userId: user.userId, email: user.email };

  const [account, counts, page] = await Promise.all([
    getGoogleAccount(user.userId),
    countCalendarMeetings(caller, range),
    listCalendarMeetingsPage(caller, view as CalendarMeetingView, {
      ...range,
      cursor: dayParam(params.get('cursor')),
      days: clampInt(params.get('days'), 14, 1, 60),
      minRows: clampInt(params.get('minRows'), 40, 1, 200),
    }),
  ]);

  // One batch lookup maps this page's recurring events onto app-level series.
  const baseIds = [
    ...new Set(
      page.days.flatMap((d) =>
        d.rows.flatMap((r) => (r.recurring_event_id ? [recurringBaseId(r.recurring_event_id)] : []))
      )
    ),
  ];
  const seriesByBase = await findSeriesByRecurringBaseIds(baseIds);

  const body: CalendarMeetingsResponse = {
    days: page.days.map((d) => ({ key: d.key, rows: d.rows.map((r) => toRow(r, seriesByBase)) })),
    counts,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    connected: !!account,
    sync: {
      connectedAt: account?.connected_at ?? null,
      lastPollAt: account?.last_poll_at ?? null,
      // No completed sweep since (re)connecting → the first sweep is still
      // running (or queued); calendar layers may be missing events.
      syncing:
        !!account &&
        (account.last_poll_at === null ||
          (account.connected_at !== null &&
            new Date(account.last_poll_at) < new Date(account.connected_at))),
    },
  };
  return NextResponse.json(body);
});
