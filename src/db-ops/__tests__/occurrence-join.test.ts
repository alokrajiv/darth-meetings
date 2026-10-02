/**
 * The SQL half of "this occurrence already has a meeting — add my recording
 * to it" (db-ops/occurrence-join.ts), over the fake postgres tag.
 *
 * The candidate lookup is the PRIVACY one (feedback_privacy_caller_scoping_gate):
 * "a meeting the caller cannot open is never a candidate" and "a trashed or
 * temporary meeting never counts" are claims about the SQL, so they are
 * checked against the SQL. Only `@/lib/db`, `server-only` and the event bus
 * are stubbed, as the other db-ops tests do.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let respond: (q: RenderedQuery) => unknown[] = () => [];
const sql: FakeSql = createFakeSql((q) => respond(q));
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));
mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
mock.module('@/lib/server/event-bus', () => ({ publishEvent: () => {} }));

const ops = await import('@/db-ops/occurrence-join');

const IVAN = { userId: 'user-ivan', email: 'Ivan@Trames.SG' };
const REC = '22222222-2222-4222-8222-222222222222';
const KEY = {
  eventId: 'ev-weekly_20261002T060000Z',
  iCalUID: 'uid@google.com',
  meetingCode: 'teams-0a1b2c3d4e5f',
  joinWebUrl: null,
  startTime: '2026-10-02T06:00:00.000Z',
};

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = () => [];
});

const lastExecuted = () => sql.executed[sql.executed.length - 1]!;

describe('PRIVACY — the candidate lookup is caller-scoped in SQL', () => {
  test('owner OR a share on the lower-cased email; trashed and temporary rows excluded', async () => {
    await ops.findOccurrenceMeetings(IVAN, KEY);
    const q = lastExecuted();
    expect(q.text).toMatch(
      /LEFT JOIN "[a-z_]+"\.transcript_shares s ON s\.transcript_id = t\.id AND s\.shared_with_email = \$\d+/
    );
    expect(q.text).toMatch(/AND \(t\.user_id = \$\d+ OR s\.id IS NOT NULL\)/);
    expect(q.text).toContain('t.deleted_at IS NULL');
    expect(q.text).toContain('NOT t.scratch');
    expect(q.params).toContain('ivan@trames.sg');
    expect(q.params).not.toContain('Ivan@Trames.SG');
    expect(q.params).toContain(IVAN.userId);
    // The caller's access is reported per row, so a read share can be told apart.
    expect(q.text).toMatch(/CASE WHEN t\.user_id = \$\d+ THEN 'owner' ELSE COALESCE\(s\.access, 'read'\) END AS access/);
    // The caller's own meetings rank first, then the earliest.
    expect(q.text).toMatch(/ORDER BY \(t\.user_id = \$\d+\) DESC, t\.created_at ASC/);
  });

  test('only the arms with values, each on its own indexed key; iCalUID only as a last resort', async () => {
    await ops.findOccurrenceMeetings(IVAN, KEY);
    let q = lastExecuted();
    expect(q.text).toContain("t.gmeet_context->>'eventId' = $");
    expect(q.text).toContain("t.gmeet_context->>'meetingCode' = $");
    expect(q.text).not.toContain("t.gmeet_context->'teams'->>'joinWebUrl' = $");
    expect(q.text).not.toContain("t.gmeet_context->>'iCalUID' = $");
    expect(q.params).toContain(KEY.eventId);
    expect(q.params).toContain(KEY.meetingCode);

    await ops.findOccurrenceMeetings(IVAN, { ...KEY, eventId: null, meetingCode: null });
    q = lastExecuted();
    expect(q.text).toContain("t.gmeet_context->>'iCalUID' = $");

    const before = sql.executed.length;
    const none = await ops.findOccurrenceMeetings(IVAN, {
      eventId: null,
      iCalUID: null,
      meetingCode: null,
      joinWebUrl: null,
      startTime: KEY.startTime,
    });
    expect(none).toEqual([]);
    expect(sql.executed.length).toBe(before); // nothing asked
  });

  test('the meeting being folded in is never its own candidate', async () => {
    await ops.findOccurrenceMeetings(IVAN, KEY, { excludeTranscriptIds: [77] });
    const q = lastExecuted();
    expect(q.text).toMatch(/AND NOT \(t\.id = ANY\(\$\d+\)\)/);
    expect(q.params).toContainEqual([77]);
  });

  test('clip facts come from meeting_clips: count and the recordings already in it', async () => {
    await ops.findOccurrenceMeetings(IVAN, KEY);
    const q = lastExecuted();
    expect(q.text).toContain('AS clip_count');
    expect(q.text).toContain('array_agg(DISTINCT c.recording_id::text)');
    // "Is the caller on the meeting's invite?" — the read→edit question.
    expect(q.text).toContain("lower(a->>'email') = $");
  });
});

describe('one recording, one meeting', () => {
  test('link state: live meetings holding it, and a waiting-combine reservation', async () => {
    respond = () => [{ live: 1, reserved: 'm-kawen' }];
    expect(await ops.recordingLinkState(REC)).toEqual({ liveMeetings: 1, reservedIn: 'm-kawen' });
    const q = lastExecuted();
    expect(q.text).toContain('t.deleted_at IS NULL');
    expect(q.text).toContain("->>'text' = 'waiting-combine'");
    respond = () => [];
    expect(await ops.recordingLinkState(REC)).toEqual({ liveMeetings: 0, reservedIn: null });
  });
});

describe('the marker', () => {
  test('set writes one recording’s entry into occurrenceJoins', async () => {
    await ops.setOccurrenceJoinMarker(42, 'm-kawen', REC, {
      at: '2026-10-02T06:40:00.000Z',
      byUserId: IVAN.userId,
      by: 'ivan@trames.sg',
      how: 'link',
      text: 'pending',
      alignment: 'unaligned',
    });
    const q = lastExecuted();
    expect(q.text).toContain("'{occurrenceJoins}'");
    expect(q.text).toContain('WHERE id = $');
    expect(q.params).toContain(REC);
    expect(q.params).toContain(42);
  });

  test('patch is a CLAIM when given the states it may move from', async () => {
    respond = () => [{ id: 42 }];
    expect(await ops.patchOccurrenceJoinMarker(42, REC, { text: 'merging' }, ['pending', 'failed'])).toBe(true);
    const q = lastExecuted();
    expect(q.text).toMatch(/->>'text' = ANY\(\$\d+\)/);
    expect(q.params).toContainEqual(['pending', 'failed']);
    respond = () => [];
    expect(await ops.patchOccurrenceJoinMarker(42, REC, { text: 'merging' }, ['pending'])).toBe(false);
  });

  test('the backstop lists only OPEN markers, so finished joins never crowd out pending ones', async () => {
    await ops.listOccurrenceJoins(null);
    const q = lastExecuted();
    expect(q.text).toContain("j.value->>'text' IN ('pending', 'failed', 'waiting-combine')");
    expect(q.text).toContain('t.deleted_at IS NULL');
    await ops.listOccurrenceJoins(REC);
    expect(lastExecuted().params).toContain(REC);
  });
});
