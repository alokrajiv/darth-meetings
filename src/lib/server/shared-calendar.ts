import type { CalendarEventUpsert } from '@/db-ops/calendar-event-cache';
import type { MeetingFilters } from '@/lib/server/meeting-filters';
import type { CalendarEventRow } from '@/app/api/calendar/events/route';

/**
 * Other people's calendars in GET /api/calendar/events (`?calendar=<id>`,
 * general-defects #11, Option A). Pure — no DB, no fetch — so the rules
 * are unit-tested; the route does the Google calls.
 *
 * Why this is display-only: calendar_event_cache is keyed
 * (user_id, event_key) with no calendar column, and it feeds the norec /
 * unimported views and the poller. A colleague's events written there would
 * collide with the caller's own and show up as "your meetings that were
 * never recorded". So these rows are read live under the caller's own
 * token, shaped like a cache row, tagged `calendar`, and never persisted.
 *
 * Scope: `calendar.events.readonly` lets events.list read ANY calendar the
 * person can see (a colleague's primary calendar id is their email). It does
 * NOT allow calendarList.list, so the caller must name the calendars —
 * auto-enumerating "everything shared with me" (Option B) needs the
 * `calendar.calendarlist.readonly` scope and a re-consent, deferred to the
 * darth-auth token move.
 */

export const MAX_SHARED_CALENDARS = 5;
/** Emails, group ids (`…@group.calendar.google.com`), holiday calendars
 * (`en.singapore#holiday@group.v.calendar.google.com`). */
const CALENDAR_ID_RE = /^[A-Za-z0-9._%+#@-]{3,254}$/;

export type CalendarAccess = 'reader' | 'freeBusy';

export type ParsedCalendarIds = { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * `?calendar=` — repeatable and/or comma-separated. Trimmed, de-duplicated
 * case-insensitively; `primary` and the caller's own email are dropped (the
 * primary calendar is always in the answer, from the cache). More than
 * MAX_SHARED_CALENDARS or a malformed id → 400 (never silently narrowed).
 */
export function parseCalendarIds(sp: URLSearchParams, selfEmail: string): ParsedCalendarIds {
  const self = selfEmail.trim().toLowerCase();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of sp.getAll('calendar')) {
    for (const part of raw.split(',')) {
      const id = part.trim();
      if (!id) continue;
      const lc = id.toLowerCase();
      if (lc === 'primary' || lc === self || seen.has(lc)) continue;
      if (!CALENDAR_ID_RE.test(id)) {
        return { ok: false, error: `calendar: "${id.slice(0, 80)}" is not a calendar id (use the person's email)` };
      }
      seen.add(lc);
      ids.push(id);
    }
  }
  if (ids.length > MAX_SHARED_CALENDARS) {
    return { ok: false, error: `Too many calendars (${ids.length}) — max ${MAX_SHARED_CALENDARS} per call` };
  }
  return { ok: true, ids };
}

/** The plain per-calendar message for a failed listing. */
export function sharedCalendarError(id: string, status: number): string {
  if (status === 403 || status === 404) return `${id}: not shared with you or not found`;
  if (status === 401) return `${id}: Google session expired — reconnect Google in Settings`;
  return `${id}: Google calendar listing failed (${status})`;
}

/**
 * Google's accessRole for the caller on that calendar, when it came back;
 * otherwise a guess from the events: a free/busy-only share serves bare
 * time blocks (no title, organizer or attendees).
 */
export function calendarAccessOf(
  accessRole: string | undefined,
  rows: readonly Pick<CalendarEventUpsert, 'title' | 'organizerEmail' | 'attendeeCount'>[]
): CalendarAccess | null {
  if (accessRole === 'freeBusyReader') return 'freeBusy';
  if (accessRole === 'reader' || accessRole === 'writer' || accessRole === 'owner') return 'reader';
  if (rows.length === 0) return null;
  const bare = rows.every((r) => !r.title && !r.organizerEmail && !r.attendeeCount);
  return bare ? 'freeBusy' : 'reader';
}

/** Local calendar day (YYYY-MM-DD) of an instant in tz. */
export function dayIn(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/**
 * A live event from another calendar in the SAME row shape the cache path
 * serves, plus `calendar` / `calendarAccess`. Everything the cache joins
 * in (import annotation, /m uuid, series, provider evidence, mutes) is
 * empty: those are keyed to the caller's own calendar, and minting /m
 * uuids here would write the DB for someone else's calendar.
 */
export function sharedCalendarRow(
  u: CalendarEventUpsert,
  calendarId: string,
  access: CalendarAccess | null,
  tz: string,
  now: number
): CalendarEventRow {
  const start = new Date(u.eventStart);
  const endMs = u.eventEnd ? Date.parse(u.eventEnd) : NaN;
  return {
    key: `cal:${calendarId}|${u.eventKey}`,
    eventId: u.eventId,
    recurringEventId: u.recurringEventId,
    title: u.title,
    start: start.toISOString(),
    end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    durationSecs: Number.isFinite(endMs) ? Math.round((endMs - start.getTime()) / 1000) : null,
    day: dayIn(start, tz),
    upcoming: start.getTime() > now,
    meetingCode: u.meetingCode,
    provider: u.meetingCode ? (u.meetingCode.startsWith('teams-') ? 'teams' : 'gmeet') : null,
    organizerEmail: u.organizerEmail,
    organizerSelf: u.organizerSelf,
    attendeeCount: u.attendeeCount,
    attendees: u.attendees ?? [],
    description: u.description,
    location: u.location,
    calendarUrl: u.htmlLink,
    meetingUuid: null,
    meetingUrl: null,
    series: null,
    muted: false,
    evidence: { recording: false, transcript: false, preparing: false, geminiNotes: false, checkedAt: null },
    imported: null,
    calendar: calendarId,
    ...(access ? { calendarAccess: access } : {}),
  };
}

const has = (hay: string | null | undefined, terms: readonly string[]): boolean => {
  if (!hay) return false;
  const h = hay.toLowerCase();
  return terms.some((t) => h.includes(t.toLowerCase()));
};

/**
 * The in-memory twin of `norecFilterSql` (db-ops/meeting-filter-sql.ts) for
 * rows that never reach the table: participant = organizer or attendee
 * email / display name; organizer = organizer email; provider = the SQL's
 * CASE (a row with no meeting code counts as 'gmeet' there — mirrored, so a
 * merged answer filters the same way on both halves); q = title, organizer
 * or attendee. speaker is ignored (calendar rows have no speakers).
 */
export function matchesCalendarFilters(
  r: Pick<CalendarEventRow, 'title' | 'organizerEmail' | 'attendees' | 'meetingCode'>,
  f: MeetingFilters
): boolean {
  const attendeeHit = (terms: readonly string[]) =>
    r.attendees.some((a) => has(a.email, terms) || has(a.displayName, terms));
  if (f.participant.length > 0 && !(has(r.organizerEmail, f.participant) || attendeeHit(f.participant))) return false;
  if (f.organizer.length > 0 && !has(r.organizerEmail, f.organizer)) return false;
  if (f.provider.length > 0) {
    const p = r.meetingCode?.startsWith('teams-') ? 'teams' : 'gmeet';
    if (!(f.provider as string[]).includes(p)) return false;
  }
  if (f.q) {
    const q = [f.q];
    if (!(has(r.title, q) || has(r.organizerEmail, q) || attendeeHit(q))) return false;
  }
  return true;
}
