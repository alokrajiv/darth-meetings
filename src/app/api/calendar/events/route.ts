import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import { listCalendarWindow, type CalendarWindowRow } from '@/db-ops/calendar-event-cache';
import { getServerAccessToken, invalidateServerToken } from '@/lib/server/google-oauth';
import { CalendarListError, syncCalendarWindow } from '@/lib/server/meeting-discovery';
import { parseMeetingFilters } from '@/lib/server/meeting-filters';

export const runtime = 'nodejs';

/**
 * GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD[&tz=…][&sync=0][&filters]
 *
 * The caller's FULL calendar for a window — every timed event on their
 * primary Google calendar, past and future, imported or not, with or
 * without a meeting link — as an ascending agenda. Built for darth-cli
 * (`meetings calendar --view all`): the listing layers only ever show what
 * is NOT in the archive and only the past, which is the wrong shape for
 * "what is on my calendar next week" or "which of last month's calls did
 * we actually record".
 *
 * Unless `sync=0`, the window is first re-read live from Google under the
 * caller's own server-minted token (the ONE discovery service, which
 * writes back to their per-user calendar cache) — so future events beyond
 * the poller's +24h horizon and history from before the account was
 * connected are covered too. Google being unreachable degrades to "cache
 * only" with `sync.error` set; never-connected callers get their (usually
 * empty) cache + `connected:false`.
 *
 * Per row: import annotation (earliest live import of the occurrence —
 * id, status, whether the caller can open it), provider evidence
 * (recording / transcript / preparing, artifact cache + calendar
 * attachments) and the caller's mute. Same people/provider/q filters as the
 * other listing surfaces (lib/server/meeting-filters). Display-only: no
 * tokens, no file ids.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z0-9_/+-]{1,64}$/;
const MAX_SPAN_DAYS = 366;
const DEFAULT_BACK_DAYS = 7;
const DEFAULT_FORWARD_DAYS = 30;
const DEFAULT_SPAN_DAYS = 90;
const ROW_CAP = 5000;
const DAY_MS = 86_400_000;

export interface CalendarEventRow {
  key: string;
  eventId: string;
  recurringEventId: string | null;
  title: string | null;
  start: string;
  end: string | null;
  durationSecs: number | null;
  /** Local (tz) day the event starts on, YYYY-MM-DD. */
  day: string;
  upcoming: boolean;
  meetingCode: string | null;
  provider: 'gmeet' | 'teams' | null;
  organizerEmail: string | null;
  organizerSelf: boolean | null;
  attendeeCount: number | null;
  attendees: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  muted: boolean;
  evidence: {
    recording: boolean;
    transcript: boolean;
    preparing: boolean;
    geminiNotes: boolean;
    checkedAt: string | null;
  };
  imported: { id: string; status: string | null; accessible: boolean; mine: boolean } | null;
}

export interface CalendarEventsResponse {
  range: { from: string; to: string; tz: string };
  events: CalendarEventRow[];
  counts: { total: number; past: number; upcoming: number; imported: number; withEvidence: number };
  truncated: boolean;
  connected: boolean;
  sync: { ran: boolean; fetched: number | null; error: string | null };
}

function safeTz(raw: string | null): string {
  if (!raw || !TZ_RE.test(raw)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    return 'UTC';
  }
}

/** Local calendar day (YYYY-MM-DD) of an instant in tz. */
function dayIn(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Midnight of a YYYY-MM-DD day in tz, as an instant. Two-pass: read the
 * tz offset at the UTC-midnight guess, correct, re-read (DST edges). */
function midnightIn(day: string, tz: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const offsetAt = (d: Date): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return asUtc - d.getTime();
  };
  let inst = new Date(guess.getTime() - offsetAt(guess));
  inst = new Date(guess.getTime() - offsetAt(inst));
  return inst;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function toRow(r: CalendarWindowRow, tz: string, now: number): CalendarEventRow {
  const start = new Date(r.event_start);
  return {
    key: r.key,
    eventId: r.event_id,
    recurringEventId: r.recurring_event_id,
    title: r.title,
    start: start.toISOString(),
    end: r.event_end == null ? null : new Date(r.event_end).toISOString(),
    durationSecs: r.duration_secs == null ? null : Math.round(r.duration_secs),
    day: dayIn(start, tz),
    upcoming: start.getTime() > now,
    meetingCode: r.meeting_code,
    provider: r.provider,
    organizerEmail: r.organizer_email,
    organizerSelf: r.organizer_self,
    attendeeCount: r.attendee_count,
    attendees: r.attendees ?? [],
    muted: r.muted,
    evidence: {
      recording: r.has_recording,
      transcript: r.has_transcript,
      preparing: r.recording_preparing || r.transcript_preparing,
      geminiNotes: r.gemini_notes,
      checkedAt: r.evidence_checked_at == null ? null : new Date(r.evidence_checked_at).toISOString(),
    },
    imported: r.imported_id
      ? {
          id: r.imported_id,
          status: r.imported_status,
          accessible: r.imported_accessible === true,
          mine: r.imported_mine === true,
        }
      : null,
  };
}

export const GET = withAuth(async ({ user, request }) => {
  const sp = request.nextUrl.searchParams;
  const tz = safeTz(sp.get('tz'));
  const fromRaw = sp.get('from');
  const toRaw = sp.get('to');
  if ((fromRaw && !DAY_RE.test(fromRaw)) || (toRaw && !DAY_RE.test(toRaw))) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 });
  }
  const today = dayIn(new Date(), tz);
  // Defaults: last week + next month; one bound given → a 90-day span
  // anchored on it.
  const from = fromRaw ?? (toRaw ? addDays(toRaw, -DEFAULT_SPAN_DAYS) : addDays(today, -DEFAULT_BACK_DAYS));
  const to = toRaw ?? (fromRaw ? addDays(fromRaw, DEFAULT_SPAN_DAYS) : addDays(today, DEFAULT_FORWARD_DAYS));
  if (to < from) return NextResponse.json({ error: 'to must not be before from' }, { status: 400 });
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (spanDays > MAX_SPAN_DAYS) {
    return NextResponse.json({ error: `window too large (max ${MAX_SPAN_DAYS} days)` }, { status: 400 });
  }
  const parsed = parseMeetingFilters(sp);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const fromIso = midnightIn(from, tz).toISOString();
  const toIso = midnightIn(addDays(to, 1), tz).toISOString();
  const wantSync = sp.get('sync') !== '0';

  const account = await getGoogleAccount(user.userId);
  const sync: CalendarEventsResponse['sync'] = { ran: false, fetched: null, error: null };
  if (wantSync && account) {
    const minted = await getServerAccessToken(user.userId);
    if (!minted) {
      sync.error = account.status === 'revoked'
        ? 'Google access was revoked — reconnect Google in Settings.'
        : 'Could not mint a Google token — served from cache.';
    } else {
      try {
        // 250 events per page; 8 pages cover a busy year.
        const events = await syncCalendarWindow(user.userId, minted.token, { from: fromIso, to: toIso, maxPages: 8 });
        sync.ran = true;
        sync.fetched = events.length;
      } catch (err) {
        if (err instanceof CalendarListError) {
          if (err.status === 401) invalidateServerToken(user.userId);
          sync.error = err.status === 401
            ? 'Google session expired — reconnect Google in Settings. Served from cache.'
            : `Google calendar listing failed (${err.status}) — served from cache.`;
        } else {
          throw err;
        }
      }
    }
  }

  const rows = await listCalendarWindow(
    { userId: user.userId, email: user.email },
    { fromIso, toIso, filters: parsed.filters, limit: ROW_CAP + 1 }
  );
  const truncated = rows.length > ROW_CAP;
  const now = Date.now();
  const events = rows.slice(0, ROW_CAP).map((r) => toRow(r, tz, now));
  const body: CalendarEventsResponse = {
    range: { from, to, tz },
    events,
    counts: {
      total: events.length,
      past: events.filter((e) => !e.upcoming).length,
      upcoming: events.filter((e) => e.upcoming).length,
      imported: events.filter((e) => e.imported).length,
      withEvidence: events.filter((e) => e.evidence.recording || e.evidence.transcript).length,
    },
    truncated,
    connected: !!account,
    sync,
  };
  return NextResponse.json(body);
});
