/**
 * darth-admin › Recorder db-ops: SQL-shape assertions over the fake postgres
 * tag (helpers/fake-sql) — what each operator query actually asks.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let respond: (q: RenderedQuery) => unknown[] = () => [];

const sql: FakeSql = createFakeSql((q) => respond(q));
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));
mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));

const {
  listRecorderDevicesForAdmin,
  recordingProgressForAdmin,
  recentRecordingsForAdmin,
  listRecorderEventsForAdmin,
} = await import('@/db-ops/recorder');

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = () => [];
});

function last(): RenderedQuery {
  const q = sql.executed[sql.executed.length - 1];
  expect(q).toBeDefined();
  return q!;
}

describe('listRecorderDevicesForAdmin', () => {
  test('one query over ALL users’ trays, newest heartbeat first, no user filter', async () => {
    await listRecorderDevicesForAdmin();
    expect(sql.executed).toHaveLength(1);
    const q = last();
    expect(q.text).toMatch(/FROM "meeting_whisperer_[a-z]+".recorder_devices d/);
    expect(q.text).toContain('ORDER BY d.last_seen DESC');
    expect(q.text).not.toContain('user_id =');
  });

  test('every events LATERAL is keyed on the device (index-backed) and time-bounded where it filters by kind', async () => {
    await listRecorderDevicesForAdmin();
    const q = last();
    const laterals = q.text.split('LEFT JOIN LATERAL').slice(1);
    expect(laterals).toHaveLength(4);
    for (const l of laterals) expect(l).toContain('e.device_id = d.device_id');
    expect(laterals[0]).toContain('ORDER BY e.ts DESC LIMIT 1');
    for (const l of laterals.slice(1)) expect(l).toMatch(/e\.ts > now\(\) - interval/);
    expect(q.params).toContainEqual(['recording_started', 'recording_stopped', 'recording_cancelled']);
    expect(q.params).toContainEqual(['unclean_exit', 'crash_report']);
    expect(q.text).toContain("interval '7 days'");
  });
});

describe('recordingProgressForAdmin', () => {
  test('no in-flight recordings → no query', async () => {
    expect(await recordingProgressForAdmin([])).toEqual([]);
    expect(sql.executed).toHaveLength(0);
  });

  test('one batched query, ids lower-cased, events from the start on, joined to the registry row', async () => {
    await recordingProgressForAdmin([
      { device_id: 'd1', recording_id: 'ABC', since: '2026-10-02T05:00:00.000Z' },
      { device_id: 'd2', recording_id: 'def', since: null },
    ]);
    expect(sql.executed).toHaveLength(1);
    const q = last();
    const batch = q.params[0] as Array<{ device_id: string; recording_id: string; since: string }>;
    expect(batch[0]).toEqual({ device_id: 'd1', recording_id: 'abc', since: '2026-10-02T05:00:00.000Z' });
    expect(typeof batch[1]!.since).toBe('string');
    expect(q.text).toContain('e.device_id = x.device_id');
    expect(q.text).toContain("lower(e.payload->>'recording_id') = x.recording_id");
    expect(q.text).toContain("e.kind = 'segment_closed'");
    expect(q.text).toContain('recorder_recordings r ON r.id::text = x.recording_id');
  });
});

describe('recentRecordingsForAdmin', () => {
  test('top-5 per device in one query', async () => {
    await recentRecordingsForAdmin(['d1', 'd2']);
    const q = last();
    expect(q.text).toContain('row_number() OVER (PARTITION BY r.device_id');
    expect(q.text).toContain("r.call->>'app' AS call_app");
    expect(q.params).toContainEqual(['d1', 'd2']);
    expect(q.params).toContain(5);
  });

  test('no devices → no query', async () => {
    expect(await recentRecordingsForAdmin([])).toEqual([]);
    expect(sql.executed).toHaveLength(0);
  });
});

describe('listRecorderEventsForAdmin', () => {
  test('default: the samplers are excluded, newest first, limited', async () => {
    await listRecorderEventsForAdmin('d1', { limit: 50, kinds: null, excludeKinds: ['resource_sample', 'process_sample'] });
    const q = last();
    expect(q.text).toContain('NOT (e.kind = ANY(');
    expect(q.params).toContainEqual(['resource_sample', 'process_sample']);
    expect(q.text).toContain('ORDER BY e.ts DESC, e.id DESC');
    expect(q.params).toContain('d1');
    expect(q.params).toContain(50);
  });

  test('kinds named → exactly those', async () => {
    await listRecorderEventsForAdmin('d1', { limit: 10, kinds: ['resource_sample'], excludeKinds: ['resource_sample'] });
    const q = last();
    expect(q.text).toContain('AND e.kind = ANY(');
    expect(q.text).not.toContain('NOT (e.kind');
    expect(q.params).toContainEqual(['resource_sample']);
  });
});
