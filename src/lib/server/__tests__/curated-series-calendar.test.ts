/**
 * Curated series over CALENDAR occurrences (docs/curated-series-spec.md §7,
 * v2 §11), over the fake postgres tag:
 *
 *   - the occurrence sweep reads the caller's OWN calendar_event_cache rows
 *     and keeps the ones THIS series' patterns match (v2: no competition — a
 *     lower-priority series matching too takes nothing away);
 *   - its imported cross-reference is the series' members: a member the
 *     caller cannot open still marks its occurrence imported (no re-import)
 *     but carries no id or title, and is never folded in as a row;
 *   - seriesOwnerFor = the first matching series BY PRIORITY that has an
 *     auto-import setting;
 *   - seriesForOccurrences (the calendar chips) names only series the CALLER
 *     may see (§11.6), and reads invitees only from the caller's own rows,
 *     only when some visible series has an invite rule.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';
import type { SeriesPattern } from '@/lib/series-patterns';
import { seriesWorldResponder } from './helpers/series-world';

const CALLER = { userId: 'bf547379-4c7e-4e17-932e-0246e50bfe54', email: 'alok@trames.sg' };

let sql: FakeSql;
let series: Array<{ id: number; title: string; patterns: SeriesPattern[]; priority: number; auto_import: unknown }>;
let calRows: Array<Record<string, unknown>>;
let members: Array<Record<string, unknown>>;
let ownAttendees: Array<Record<string, unknown>>;

const cal = (eventId: string, title: string, start: string) => ({
  event_key: `${eventId}|${start}`,
  event_id: eventId,
  recurring_event_id: 'base_R20260101T010000',
  ical_uid: null,
  title,
  event_start: start,
  event_end: start.replace('T01', 'T02'),
  meeting_code: 'abc-defg-hij',
  organizer_email: 'alok@trames.sg',
  attendees: [{ email: 'eli@trames.sg' }],
  html_link: null,
  attachment_video_count: 0,
  attachment_video_file_id: null,
  attachment_transcript_doc_id: `doc-${eventId}`,
  attachment_gemini_notes: false,
});

const member = (id: number, eventId: string | null, accessible: boolean, start: string) => ({
  id,
  assemblyai_id: `m-${id}`,
  title: `secret title ${id}`,
  recorded_at: start,
  created_at: start,
  occurrence_start: start,
  drive_file_id: null,
  event_id: eventId,
  transcript_doc_id: null,
  video_file_id: null,
  teams_call_id: null,
  meeting_code: null,
  status: 'completed',
  accessible,
  is_member: true,
});

// Every series is owned by the caller (an auditor), unless a test says
// otherwise — visibility (§11.6) is evaluated by the world helper.
let owners: Record<number, { email: string; userId: string; followers?: string[] }> = {};
const world = () => ({
  ready053: true,
  ready054: true,
  auditors: [CALLER.email],
  identities: {},
  transcripts: [],
  series: series.map((s) => ({
    ...s,
    owner_email: owners[s.id]?.email ?? CALLER.email,
    owner_user_id: owners[s.id]?.userId ?? CALLER.userId,
    editors: [],
    followers: owners[s.id]?.followers ?? [],
    rules: [],
  })),
});

function respond(q: RenderedQuery): unknown[] {
  const t = q.text;
  if (/FROM "[a-z_]+"\.calendar_event_cache/.test(t) && t.includes('attachment_gemini_notes')) {
    return calRows;
  }
  if (t.includes('AS attendee_emails') || t.includes('AS emails')) return ownAttendees;
  if (t.includes('AS is_member')) return members;
  return seriesWorldResponder(world())(q) ?? [];
}

function resetCaches() {
  const g = globalThis as Record<string, unknown>;
  g.__mwCuratedSeriesCache = undefined;
  g.__mwCuratedSeries053 = undefined;
  g.__mwSeries054 = undefined;
  g.__mwAuditors = undefined;
  (g.__mwSeriesSweepCache as Map<string, unknown> | undefined)?.clear();
}

type Occ = typeof import('@/lib/server/series-occurrences');
type Plan = typeof import('@/lib/server/auto-import-plan');
type Engine = typeof import('@/lib/server/curated-series');
let occ: Occ;
let plan: Plan;
let engine: Engine;

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  occ = await import('@/lib/server/series-occurrences');
  plan = await import('@/lib/server/auto-import-plan');
  engine = await import('@/lib/server/curated-series');
});

beforeEach(() => {
  series = [
    { id: 1, title: 'AI - Daily', patterns: [{ kind: 'title', regex: '^AI - Daily' }], priority: 100, auto_import: null },
    { id: 2, title: 'Data Cadence', patterns: [{ kind: 'title', regex: '^Data Cadence' }], priority: 100, auto_import: null },
  ];
  calRows = [
    cal('ev1_20261001T010000Z', 'AI - Daily', '2026-10-01T01:00:00.000Z'),
    cal('ev2_20261002T010000Z', 'Data Cadence', '2026-10-02T01:00:00.000Z'),
    cal('ev3_20261003T010000Z', 'AI - Daily', '2026-10-03T01:00:00.000Z'),
  ];
  members = [];
  ownAttendees = [];
  owners = {};
  sql.executed.length = 0;
  resetCaches();
});

afterAll(() => resetCaches());

describe('sweepSeriesOccurrences — own calendar through the matcher', () => {
  test('only the caller’s own rows, only the ones this series wins', async () => {
    const r = await occ.sweepSeriesOccurrences(1, CALLER);
    expect(r?.occurrences.map((o) => o.eventId).sort()).toEqual([
      'ev1_20261001T010000Z',
      'ev3_20261003T010000Z',
    ]);
    const q = sql.executed.find((x) => x.text.includes('attachment_gemini_notes'))!;
    expect(q.text).toContain('WHERE user_id = $1');
    expect(q.params[0]).toBe(CALLER.userId);
    // The cached attachments make the occurrence importable as a transcript.
    expect(r?.occurrences.every((o) => o.hasTranscript)).toBe(true);
  });

  test('v2: another (higher-priority) series matching too takes NOTHING away — no competition', async () => {
    series.push({ id: 3, title: 'AM', patterns: [{ kind: 'title', regex: 'Daily' }], priority: 50, auto_import: null });
    const r = await occ.sweepSeriesOccurrences(1, CALLER);
    expect(r?.occurrences).toHaveLength(2);
  });

  test('members: an inaccessible one marks its occurrence imported with no id/title, and is never folded in', async () => {
    members = [
      member(11, 'ev1_20261001T010000Z', false, '2026-10-01T01:00:00.000Z'), // someone else's import of ev1
      member(12, 'ev3_20261003T010000Z', true, '2026-10-03T01:00:00.000Z'), // the caller's own import of ev3
      member(13, null, true, '2026-09-01T01:00:00.000Z'), // caller-visible, on no calendar row
      member(14, null, false, '2026-09-02T01:00:00.000Z'), // NOT visible, on no calendar row
    ];
    const r = (await occ.sweepSeriesOccurrences(1, CALLER))!;
    const ev1 = r.occurrences.find((o) => o.eventId === 'ev1_20261001T010000Z')!;
    expect(ev1.imported).toEqual([{ assemblyai_id: '', title: null, accessible: false, queued: false, failed: false }]);
    const ev3 = r.occurrences.find((o) => o.eventId === 'ev3_20261003T010000Z')!;
    expect(ev3.imported[0]!.assemblyai_id).toBe('m-12');
    const folded = r.occurrences.filter((o) => o.source === 'imported');
    expect(folded.map((o) => o.key)).toEqual(['imp-m-13']);
    expect(JSON.stringify(r)).not.toContain('m-11');
    expect(JSON.stringify(r)).not.toContain('m-14');
    expect(JSON.stringify(r)).not.toContain('secret title 11');
    // The cross-reference is the membership, keyed by this series.
    const q = sql.executed.find((x) => x.text.includes('AS is_member'))!;
    expect(q.text).toContain('WHERE m.series_id = $');
  });
});

describe('seriesOwnerFor — the matcher decides who owns an occurrence', () => {
  const on = { enabled: true, byUserId: CALLER.userId, byEmail: CALLER.email, mode: 'both', report: 'detailed-video', since: '2026-08-01T00:00:00Z' };
  test('the first matching series with a setting owns it', async () => {
    series[0]!.auto_import = on;
    const s = await plan.seriesOwnerFor({ title: 'AI - Daily', attendees: [], organizerEmail: null });
    expect(s?.id).toBe(1);
  });
  test('v2: a matching series WITHOUT a setting no longer blocks one that has a setting', async () => {
    series.push({ id: 3, title: 'All dailies', patterns: [{ kind: 'title', regex: 'Daily' }], priority: 200, auto_import: on });
    const s = await plan.seriesOwnerFor({ title: 'AI - Daily', attendees: [] });
    expect(s?.id).toBe(3);
  });
  test('two with a setting: priority decides', async () => {
    series[0]!.auto_import = on;
    series.push({ id: 3, title: 'All dailies', patterns: [{ kind: 'title', regex: 'Daily' }], priority: 20, auto_import: on });
    expect((await plan.seriesOwnerFor({ title: 'AI - Daily', attendees: [] }))?.id).toBe(3);
  });
  test('no match → no owner', async () => {
    series[0]!.auto_import = on;
    expect(await plan.seriesOwnerFor({ title: 'Lunch' })).toBeNull();
  });
});

describe('seriesForOccurrences — calendar chips name only series the CALLER may see (§11.6)', () => {
  const RADHIKA = { userId: 'cccccccc-0000-4000-8000-00000000000d', email: 'radhika@trames.sg' };
  test('PRIVACY: a stranger to the series gets no chip — the series is never named', async () => {
    owners = { 1: { email: 'kawen.koh@trames.sg', userId: 'kawen-id' }, 2: { email: 'kawen.koh@trames.sg', userId: 'kawen-id' } };
    const m = await engine.seriesForOccurrences(RADHIKA, [
      { key: 'k1', title: 'AI - Daily' },
      { key: 'k2', title: 'Data Cadence' },
    ]);
    expect(m.size).toBe(0);
    const q = sql.executed.find((x) => /^SELECT s\.id FROM/.test(x.text))!;
    expect(q.text).toContain('owner_email = $');
    expect(q.text).toContain('ed.email = $');
    expect(q.text).toContain('fo.email = $');
    expect(q.params).toContain(RADHIKA.email);
  });
  test('a follower sees the chip; the first VISIBLE match by priority wins', async () => {
    owners = { 1: { email: 'kawen.koh@trames.sg', userId: 'kawen-id', followers: [RADHIKA.email] }, 2: { email: 'kawen.koh@trames.sg', userId: 'kawen-id' } };
    series.push({ id: 3, title: 'Hidden dailies', patterns: [{ kind: 'title', regex: 'Daily' }], priority: 1, auto_import: null });
    owners[3] = { email: 'kawen.koh@trames.sg', userId: 'kawen-id' };
    const m = await engine.seriesForOccurrences(RADHIKA, [{ key: 'k1', title: 'AI - Daily' }]);
    expect(m.get('k1')?.id).toBe(1); // #3 has a better priority but she cannot see it
  });
});

describe('seriesForOccurrences — invitees only from the caller’s own calendar', () => {
  test('no invite rule anywhere → no attendee lookup at all', async () => {
    const m = await engine.seriesForOccurrences(CALLER, [
      { key: 'k1', title: 'AI - Daily', code: 'abc-defg-hij', startIso: '2026-10-01T01:00:00.000Z' },
    ]);
    expect(m.get('k1')?.id).toBe(1);
    expect(sql.executed.some((q) => q.text.includes('AS emails'))).toBe(false);
  });
  test('an invite rule reads the caller’s own row for the missing invitees', async () => {
    series.push({
      id: 4,
      title: 'AM Briefing: Jacq',
      patterns: [{ kind: 'invite', all: ['ivan@trames.sg', 'jacqueline.ng@trames.sg'], maxPeople: 2 }],
      priority: 50,
      auto_import: null,
    });
    ownAttendees = [
      {
        meeting_code: 'xyz-1',
        event_start: '2026-10-01T01:00:00.000Z',
        emails: ['ivan@trames.sg', 'jacqueline.ng@trames.sg'],
      },
    ];
    const m = await engine.seriesForOccurrences(CALLER, [
      { key: 'k1', title: 'Catch-up', code: 'xyz-1', startIso: '2026-10-01T01:00:00.000Z' },
      { key: 'k2', title: 'Catch-up', attendees: ['ivan@trames.sg'] },
    ]);
    expect(m.get('k1')?.id).toBe(4);
    expect(m.has('k2')).toBe(false);
    const q = sql.executed.find((x) => x.text.includes('AS emails'))!;
    expect(q.text).toContain('WHERE user_id = $');
    expect(q.params[0]).toBe(CALLER.userId);
  });
});
