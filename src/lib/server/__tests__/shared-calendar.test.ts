/**
 * general-defects #11 (Option A): `GET /api/calendar/events?calendar=<id>`
 * reads a calendar SHARED with the caller, live and display-only. These pin
 * the pure half: the `?calendar=` parser, the per-calendar error line, the
 * free/busy vs reader detection, the row adapter (Google event →
 * toCalendarUpsert → the route's row shape + `calendar`), and the in-memory
 * twin of norecFilterSql that filters those rows.
 */
import { describe, expect, mock, test } from 'bun:test';
import { EMPTY_MEETING_FILTERS, parseMeetingFilters } from '@/lib/server/meeting-filters';
import {
  MAX_SHARED_CALENDARS,
  calendarAccessOf,
  matchesCalendarFilters,
  parseCalendarIds,
  sharedCalendarError,
  sharedCalendarRow,
} from '@/lib/server/shared-calendar';

mock.module('server-only', () => ({}));
const { toCalendarUpsert } = await import('@/lib/server/meeting-discovery');

const qs = (s: string) => new URLSearchParams(s);
const NOW = Date.parse('2026-09-23T04:00:00Z');

// What events.list serves on a freeBusyReader share: bare time blocks.
const FREE_BUSY_EVENT = {
  id: 'fb1',
  start: { dateTime: '2026-09-23T10:00:00+08:00' },
  end: { dateTime: '2026-09-23T10:30:00+08:00' },
};
// What it serves on a reader share: the full invite.
const READER_EVENT = {
  id: 'rd1',
  summary: 'LP Global QBR',
  htmlLink: 'https://www.google.com/calendar/event?eid=rd1',
  organizer: { email: 'alice@trames.sg' },
  start: { dateTime: '2026-09-24T14:00:00+08:00' },
  end: { dateTime: '2026-09-24T15:00:00+08:00' },
  attendees: [
    { email: 'alice@trames.sg', displayName: 'Alice', responseStatus: 'accepted' },
    { email: 'nicolas@lp-global.com', displayName: 'Nicolas Montero', responseStatus: 'tentative' },
    { email: 'room-1@resource.calendar.google.com', resource: true },
  ],
  conferenceData: { conferenceId: 'abc-defg-hij', conferenceSolution: { key: { type: 'hangoutsMeet' } } },
};

describe('parseCalendarIds', () => {
  test('repeatable and comma-separated, trimmed, de-duped case-insensitively', () => {
    const r = parseCalendarIds(qs('calendar=alice@trames.sg, bob@trames.sg&calendar=ALICE@trames.sg'), 'me@trames.sg');
    expect(r).toEqual({ ok: true, ids: ['alice@trames.sg', 'bob@trames.sg'] });
  });
  test('primary and the caller’s own email are dropped (always served from the cache)', () => {
    expect(parseCalendarIds(qs('calendar=primary,Me@Trames.sg'), 'me@trames.sg')).toEqual({ ok: true, ids: [] });
  });
  test('group and holiday calendar ids are accepted', () => {
    const r = parseCalendarIds(qs('calendar=c_123abc@group.calendar.google.com,en.singapore%23holiday@group.v.calendar.google.com'), 'me@x.com');
    expect(r.ok && r.ids.length).toBe(2);
  });
  test(`more than ${MAX_SHARED_CALENDARS} → error, a malformed id → error`, () => {
    const six = Array.from({ length: 6 }, (_, i) => `p${i}@x.com`).join(',');
    expect(parseCalendarIds(qs(`calendar=${six}`), 'me@x.com').ok).toBe(false);
    expect(parseCalendarIds(qs('calendar=a/b@x.com'), 'me@x.com').ok).toBe(false);
  });
  test('no param → no ids', () => {
    expect(parseCalendarIds(qs(''), 'me@x.com')).toEqual({ ok: true, ids: [] });
  });
});

describe('sharedCalendarError', () => {
  test('403 and 404 read as "not shared with you or not found"', () => {
    expect(sharedCalendarError('bob@trames.sg', 403)).toBe('bob@trames.sg: not shared with you or not found');
    expect(sharedCalendarError('bob@trames.sg', 404)).toBe('bob@trames.sg: not shared with you or not found');
  });
  test('other statuses keep the code', () => {
    expect(sharedCalendarError('bob@trames.sg', 500)).toBe('bob@trames.sg: Google calendar listing failed (500)');
  });
});

describe('calendarAccessOf', () => {
  const fb = toCalendarUpsert(FREE_BUSY_EVENT);
  const rd = toCalendarUpsert(READER_EVENT);
  test("Google's accessRole wins", () => {
    expect(calendarAccessOf('freeBusyReader', [rd])).toBe('freeBusy');
    expect(calendarAccessOf('reader', [fb])).toBe('reader');
    expect(calendarAccessOf('writer', [])).toBe('reader');
  });
  test('without it: bare time blocks → freeBusy, any detail → reader, nothing → null', () => {
    expect(calendarAccessOf(undefined, [fb])).toBe('freeBusy');
    expect(calendarAccessOf(undefined, [fb, rd])).toBe('reader');
    expect(calendarAccessOf(undefined, [])).toBeNull();
  });
});

describe('sharedCalendarRow', () => {
  test('a free/busy block: times only, tagged, nothing invented', () => {
    const row = sharedCalendarRow(toCalendarUpsert(FREE_BUSY_EVENT), 'bob@trames.sg', 'freeBusy', 'Asia/Singapore', NOW);
    expect(row).toMatchObject({
      key: 'cal:bob@trames.sg|fb1|2026-09-23T10:00:00+08:00',
      eventId: 'fb1',
      title: null,
      start: '2026-09-23T02:00:00.000Z',
      end: '2026-09-23T02:30:00.000Z',
      durationSecs: 1800,
      day: '2026-09-23',
      upcoming: false,
      provider: null,
      organizerEmail: null,
      attendeeCount: 0,
      attendees: [],
      imported: null,
      meetingUuid: null,
      series: null,
      muted: false,
      calendar: 'bob@trames.sg',
      calendarAccess: 'freeBusy',
    });
    expect(row.evidence).toEqual({ recording: false, transcript: false, preparing: false, geminiNotes: false, checkedAt: null });
  });
  test('a reader event: full invite, rooms dropped, meet code + provider, never a /m link', () => {
    const row = sharedCalendarRow(toCalendarUpsert(READER_EVENT), 'alice@trames.sg', 'reader', 'Asia/Singapore', NOW);
    expect(row.title).toBe('LP Global QBR');
    expect(row.upcoming).toBe(true);
    expect(row.meetingCode).toBe('abc-defg-hij');
    expect(row.provider).toBe('gmeet');
    expect(row.attendeeCount).toBe(2);
    expect(row.attendees.map((a) => a.email)).toEqual(['alice@trames.sg', 'nicolas@lp-global.com']);
    expect(row.calendarUrl).toBe(READER_EVENT.htmlLink);
    expect(row.meetingUrl).toBeNull();
    expect(row.calendarAccess).toBe('reader');
    expect(row.key.startsWith('cal:alice@trames.sg|rd1|')).toBe(true);
  });
  test('access unknown → no calendarAccess key at all', () => {
    const row = sharedCalendarRow(toCalendarUpsert(READER_EVENT), 'alice@trames.sg', null, 'UTC', NOW);
    expect('calendarAccess' in row).toBe(false);
  });
});

describe('matchesCalendarFilters (twin of norecFilterSql)', () => {
  const rd = sharedCalendarRow(toCalendarUpsert(READER_EVENT), 'alice@trames.sg', 'reader', 'UTC', NOW);
  const fb = sharedCalendarRow(toCalendarUpsert(FREE_BUSY_EVENT), 'bob@trames.sg', 'freeBusy', 'UTC', NOW);
  const f = (s: string) => {
    const p = parseMeetingFilters(qs(s));
    if (!p.ok) throw new Error(p.error);
    return p.filters;
  };
  test('no filters → everything', () => {
    expect(matchesCalendarFilters(rd, EMPTY_MEETING_FILTERS)).toBe(true);
    expect(matchesCalendarFilters(fb, EMPTY_MEETING_FILTERS)).toBe(true);
  });
  test('participant: organizer, attendee email or display name; comma = OR', () => {
    expect(matchesCalendarFilters(rd, f('participant=@LP-global.com'))).toBe(true);
    expect(matchesCalendarFilters(rd, f('participant=montero'))).toBe(true);
    expect(matchesCalendarFilters(rd, f('participant=zed,alice'))).toBe(true);
    expect(matchesCalendarFilters(rd, f('participant=zed'))).toBe(false);
    expect(matchesCalendarFilters(fb, f('participant=alice'))).toBe(false);
  });
  test('organizer, q, provider', () => {
    expect(matchesCalendarFilters(rd, f('organizer=alice@'))).toBe(true);
    expect(matchesCalendarFilters(rd, f('organizer=nicolas'))).toBe(false);
    expect(matchesCalendarFilters(rd, f('q=qbr'))).toBe(true);
    expect(matchesCalendarFilters(fb, f('q=qbr'))).toBe(false);
    expect(matchesCalendarFilters(rd, f('provider=teams'))).toBe(false);
    expect(matchesCalendarFilters(rd, f('provider=gmeet'))).toBe(true);
    // Mirrors the SQL CASE: no meeting code counts as 'gmeet'.
    expect(matchesCalendarFilters(fb, f('provider=gmeet'))).toBe(true);
  });
});
