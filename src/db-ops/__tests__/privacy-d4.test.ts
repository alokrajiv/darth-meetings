/**
 * Tech-debt D4 (privacy holes) at the db-ops layer, over the fake postgres
 * tag (helpers/fake-sql): what the label catalog, the series delete/merge
 * gate and the unimported listing's series_count actually emit / return for
 * a LOW-INVOLVEMENT caller (jacqueline-style: sees one shared transcript,
 * organised nothing, created nothing).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

// D4_DUMP_SQL=<file>: write every executed query (text + params) as JSON so
// the rendered SQL can be replayed against a real database for a syntax /
// A-B check (no assertions depend on it).
afterAll(async () => {
  const out = process.env.D4_DUMP_SQL;
  if (out) await Bun.write(out, JSON.stringify(sql.executed, null, 2));
});

const jac = { userId: '19679081-a63f-4058-8ea4-dc5705744c75', email: 'Jacqueline.Ng@trames.sg' };

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];

beforeAll(() => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
});

describe('D4 #1 — /api/labels catalog hides Series/* the caller holds nothing under', () => {
  test('listLabelsWithCounts: series rows with count_visible 0 are not served', async () => {
    const { listLabelsWithCounts } = await import('@/db-ops/labels');
    const row = (id: number, path_key: string, count_visible: number) => ({
      id,
      parent_id: null,
      name: path_key,
      name_key: path_key,
      path: path_key,
      path_key,
      depth: 1,
      color: null,
      description: null,
      created_by: 'x',
      created_by_email: 'x@x',
      updated_by: null,
      created_at: '',
      updated_at: '',
      count_visible,
      count_direct: count_visible,
      __unlabelled: 0,
      __total: 1,
    });
    respond = (q) =>
      q.text.includes('count_visible')
        ? [
            row(1, 'series', 1),
            row(2, 'series/data scrum', 1),
            row(3, 'series/alok <> swaralee - lp', 0),
            row(4, 'clients', 0),
          ]
        : [];
    const res = await listLabelsWithCounts(jac.userId, jac.email);
    expect(res.labels.map((l) => l.id)).toEqual([1, 2, 4]);
    expect(res.total).toBe(1);
    // The visible set is the caller's own + shared rows, lower-cased email.
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('s.shared_with_email = $1');
    expect(q.params[0]).toBe('jacqueline.ng@trames.sg');
    expect(q.params[1]).toBe(jac.userId);
  });

  test('listLabels (no counts, the CLI path) carries the same gate in SQL', async () => {
    const { listLabels } = await import('@/db-ops/labels');
    respond = () => [];
    await listLabels(jac);
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('WITH vis AS MATERIALIZED');
    expect(q.text).toContain('t.deleted_at IS NULL');
    expect(q.params[0]).toBe('jacqueline.ng@trames.sg');
    expect(q.params[1]).toBe(jac.userId);
    // Series prefix predicate present on both sides (which rows are series
    // nodes, and which visible assignments count for them).
    expect(q.text).toMatch(/WHERE NOT \(l\.path_key = \$\d+ OR left\(l\.path_key, \$\d+\) = \$\d+\)/);
    expect(q.params).toContain('series');
    expect(q.params).toContain('series/');
    expect(q.text).toContain('OR EXISTS ( SELECT 1 FROM vis_keys vk');
  });
});

describe('D4 #4 — series delete/merge need ownership, not visibility', () => {
  test('a visible-but-uninvolved attendee is refused; organiser and creator pass', async () => {
    const { seriesManageVerdictFor } = await import('@/db-ops/series');
    respond = (q) =>
      q.text.includes('organizerEmail')
        ? [{ created_by: 'c478bf8e-1e50-4a0d-8841-db774fb3b2d2', organizers: ['swaralee@trames.sg'] }]
        : [];
    const v = await seriesManageVerdictFor(42, jac);
    expect(v?.ok).toBe(false);
    expect(await seriesManageVerdictFor(42, { userId: 'u', email: 'SWARALEE@trames.sg' })).toEqual({
      ok: true,
      via: 'organizer',
    });
    expect(
      await seriesManageVerdictFor(42, { userId: 'c478bf8e-1e50-4a0d-8841-db774fb3b2d2', email: 'a@x' })
    ).toEqual({ ok: true, via: 'creator' });
    // Facts come from LIVE members only, keyed by the series id.
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('t.deleted_at IS NULL');
    expect(q.text).toContain('WHERE s.id = $1');
    expect(q.params[0]).toBe(42);
  });

  test('a series with no organiser-bearing member: creator only', async () => {
    const { seriesManageVerdictFor } = await import('@/db-ops/series');
    respond = (q) =>
      q.text.includes('organizerEmail') ? [{ created_by: 'creator-1', organizers: null }] : [];
    expect((await seriesManageVerdictFor(7, jac))?.ok).toBe(false);
    expect((await seriesManageVerdictFor(7, { userId: 'creator-1', email: 'z@x' }))?.ok).toBe(true);
  });

  test('unknown series → null (route answers 404, not 403)', async () => {
    const { seriesManageVerdictFor } = await import('@/db-ops/series');
    respond = () => [];
    expect(await seriesManageVerdictFor(999, jac)).toBeNull();
  });
});

describe('D4 #3 — unimported rows: series_count only counts caller-involved occurrences', () => {
  test('the g2 subquery carries the same involvement arms as the outer row', async () => {
    const { listCalendarMeetingsPage } = await import('@/db-ops/calendar-event-cache');
    respond = (q) => (q.text.includes('GROUP BY 1') ? [{ key: '2026-09-18', n: 3 }] : []);
    const mark = sql.executed.length;
    await listCalendarMeetingsPage(jac, 'unimported', {
      tz: 'Asia/Singapore',
      days: 7,
      minRows: 20,
      from: null,
      to: null,
      cursor: null,
    });
    const rows = sql.executed.slice(mark).find((q) => q.text.includes('AS series_count'))!;
    expect(rows).toBeDefined();
    const start = rows.text.indexOf('g2.recurring_event_id = c.recurring_event_id');
    expect(start).toBeGreaterThan(0);
    const sub = rows.text.slice(start, rows.text.indexOf('END AS series_count'));
    // Arm 1: the caller's own calendar sweep captured the g2 occurrence.
    expect(sub).toMatch(/ce\.user_id = \$(\d+) AND ce\.meeting_code = "g2"\.meeting_code/);
    // Arm 2: the cache row says they organised it.
    expect(sub).toMatch(/lower\("g2"\.organizer_email\) = \$(\d+)/);
    // Arm 3: invitee on anyone's calendar row for the g2 occurrence.
    expect(sub).toMatch(/ce2\.meeting_code = "g2"\.meeting_code/);
    expect(sub).toMatch(/lower\(a->>'email'\) = \$(\d+)/);
    // The arms are bound to THIS caller (user id / lower-cased email), not
    // to whatever the outer row's params happened to be.
    const uid = sub.match(/ce\.user_id = \$(\d+)/)![1]!;
    const em = sub.match(/lower\("g2"\.organizer_email\) = \$(\d+)/)![1]!;
    expect(rows.params[Number(uid) - 1]).toBe(jac.userId);
    expect(rows.params[Number(em) - 1]).toBe('jacqueline.ng@trames.sg');
    // The outer row keeps its own (unaliased) gate.
    expect(rows.text).toMatch(/lower\(c\.organizer_email\) = \$\d+/);
  });
});
