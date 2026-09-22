/**
 * The fast lane's candidate QUERY (db-ops/calendar-event-cache
 * `listRecentlyEndedOccurrences`) over the fake postgres tag: the claims
 * that live in SQL rather than in lib/fast-lane's rules — per-user scoping,
 * Meet only, "ended" preferring the conference record's end, the index
 * bound, and the mute exclusions the full sweep applies.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let respond: (q: RenderedQuery) => unknown[] = () => [];

const sql: FakeSql = createFakeSql((q) => respond(q));
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));

const { listRecentlyEndedOccurrences } = await import('@/db-ops/calendar-event-cache');

const USER = '11111111-1111-5111-8111-111111111111';
const ENDED_AFTER = '2026-09-22T08:20:00.000Z'; // 16:20 SGT
const ENDED_BEFORE = '2026-09-22T10:20:00.000Z'; // 18:20 SGT

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = () => [];
});

async function run(limit?: number): Promise<RenderedQuery> {
  await listRecentlyEndedOccurrences(USER, {
    endedAfter: ENDED_AFTER,
    endedBefore: ENDED_BEFORE,
    ...(limit === undefined ? {} : { limit }),
  });
  return sql.executed.at(-1)!;
}

describe('listRecentlyEndedOccurrences', () => {
  test('it is scoped to the one account and never calls Google', async () => {
    const q = await run();
    expect(q.text).toContain('c.user_id = $');
    expect(q.params).toContain(USER);
    expect(sql.executed).toHaveLength(1);
  });

  test('only Meet occurrences — Teams codes and link-less events are out', async () => {
    const q = await run();
    expect(q.text).toContain('c.meeting_code IS NOT NULL');
    expect(q.text).toContain("c.meeting_code NOT LIKE 'teams-%'");
  });

  test('"ended" prefers the conference record end over the calendar slot', async () => {
    const q = await run();
    expect(q.text).toContain('COALESCE(g.conf_end, c.event_end, c.event_start) <= $');
    expect(q.text).toContain('COALESCE(g.conf_end, c.event_end, c.event_start) >= $');
    expect(q.params).toContain(ENDED_BEFORE);
    expect(q.params).toContain(ENDED_AFTER);
    // …and the conf_end it reads is the SAME occurrence's (±12h), not any
    // other run of the recurring code.
    expect(q.text).toContain('m.meeting_code = c.meeting_code');
    expect(q.text).toContain('m.conf_end IS NOT NULL');
    expect(q.params).toContain(43200);
  });

  test('the scan is bounded by (user_id, event_start) — 26h before the window', async () => {
    const q = await run();
    expect(q.text).toContain('c.event_start >= $');
    expect(q.params).toContain('2026-09-21T06:20:00.000Z');
  });

  test('the raw calendar start is recovered from the cache key, not the timestamp', async () => {
    // The reminder key the full sweep writes carries the user's tz offset;
    // re-deriving it from the timestamptz would mint a duplicate row.
    const q = await run();
    expect(q.text).toContain(
      "substr(c.event_key, position('|' in c.event_key) + 1) AS raw_start"
    );
  });

  test('an open reminder that already names an artifact is flagged', async () => {
    const q = await run();
    expect(q.text).toContain("r.kind = 'unimported'");
    expect(q.text).toContain('r.resolved_at IS NULL');
    expect(q.text).toContain('(r.has_recording OR r.has_transcript)');
    expect(q.text).toContain('AS reminded');
  });

  test('muted occurrences are excluded exactly as the full sweep excludes them', async () => {
    const q = await run();
    expect(q.text).toContain('gmeet_sync_skips');
    expect(q.text).toContain('s.event_key = c.meeting_code OR s.event_key = c.event_id');
    expect(q.text).toContain('calendar_event_mutes');
    expect(q.text).toContain("mu.kind = 'occurrence'");
    expect(q.text).toContain("mu.kind = 'series'");
    expect(q.text).toContain('COALESCE(c.recurring_event_id, c.event_id)');
  });

  test('newest-ended first, bounded', async () => {
    const q = await run();
    expect(q.text).toContain('ORDER BY COALESCE(g.conf_end, c.event_end, c.event_start) DESC');
    expect(q.params).toContain(40);
    expect((await run(5)).params).toContain(5);
  });

  test('rows come back as the fast lane reads them', async () => {
    respond = () => [
      {
        cal_event_key: 'ev1|2026-09-22T17:30:00+08:00',
        event_id: 'ev1',
        raw_start: '2026-09-22T17:30:00+08:00',
        meeting_code: 'weo-xgvy-uxb',
        conf_end: '2026-09-22T10:00:00.000Z',
        reminded: false,
      },
    ];
    const rows = await listRecentlyEndedOccurrences(USER, {
      endedAfter: ENDED_AFTER,
      endedBefore: ENDED_BEFORE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_start).toBe('2026-09-22T17:30:00+08:00');
  });
});
