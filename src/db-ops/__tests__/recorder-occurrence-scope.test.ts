/**
 * P1 (docs/recordings-meetings-series-design.md §5): the calendar fold keys
 * on the LINK, not the match.
 *
 * A recording is reachable by exactly two arms — (a) the caller owns it, or
 * (b) it is linked to a meeting the caller can already open. Involvement in
 * the occurrence is NOT an arm: that is what folded a private Slack huddle
 * onto eight invitees' calendar rows twice on 2026-09-22 (F1).
 *
 * These are SQL-shape assertions over the fake postgres tag
 * (helpers/fake-sql): what the two folds actually ASK. The end-to-end
 * two-user proof runs against a scratch cluster —
 * `tmp/recordings-p1/p1.check.ts`, see the As-built section of the design.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let respond: (q: RenderedQuery) => unknown[] = () => [];

const sql: FakeSql = createFakeSql((q) => respond(q));
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));
mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));

const { recordingsForOccurrences } = await import('@/db-ops/recorder');

const A = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'Alok.Raj@trames.sg' };
const OCC = { k: 'abc-defg-hij|2026-09-22T07:30:00.000Z', code: 'abc-defg-hij', instant: '2026-09-22T07:30:00.000Z' };

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = () => [];
});

/** The one query each fold runs. */
function emitted(): RenderedQuery {
  const q = sql.executed[sql.executed.length - 1];
  expect(q).toBeDefined();
  return q!;
}

describe('recordingsForOccurrences — the calendar fold', () => {
  test('a row survives only under arm (a) OR arm (b)', async () => {
    await recordingsForOccurrences(A, [OCC]);
    const q = emitted();
    // The two arms, ORed, as the outer filter. Nothing else lets a row out.
    expect(q.text).toContain('WHERE r.user_id = $');
    expect(q.text).toContain('OR linked.assemblyai_id IS NOT NULL');
    expect(q.params).toContain(A.userId);
  });

  test('arm (b) is the meetings predicate: owner OR a share on the caller’s email', async () => {
    await recordingsForOccurrences(A, [OCC]);
    const q = emitted();
    expect(q.text).toContain('transcript_shares');
    expect(q.text).toContain('LOWER(s.shared_with_email) = $');
    // Lower-cased, as every other caller-scoped layer keys it.
    expect(q.params).toContain(A.email.toLowerCase());
    expect(q.params).not.toContain(A.email);
  });

  test('arm (b) asks the MEETING’s own calendar keys, not the recorder’s guess', async () => {
    await recordingsForOccurrences(A, [OCC]);
    const q = emitted();
    const lateral = q.text.slice(q.text.indexOf('LEFT JOIN LATERAL'));
    expect(lateral).toContain("t.gmeet_context->>'meetingCode' = o.code");
    expect(lateral).toContain('t.deleted_at IS NULL');
    // The lateral joins the recording to its meeting by the PUBLIC id.
    expect(lateral).toContain('t.assemblyai_id = r.transcript_id');
    // …and never re-reads the match to decide the link.
    expect(lateral).not.toContain('matched');
  });

  test('the only CROSS-USER meeting id served is arm (b)’s', async () => {
    await recordingsForOccurrences(A, [OCC]);
    const q = emitted();
    const projection = q.text.slice(0, q.text.indexOf('FROM jsonb_to_recordset'));
    expect(projection).toContain('linked.assemblyai_id AS linked_transcript_id');
    // The pre-P1 projection handed out r.transcript_id for ANY owner.
    expect(projection).not.toContain('r.transcript_id');
  });

  test('arm (a) serves the OWNER their own meeting and its live suggestion', async () => {
    await recordingsForOccurrences(A, [OCC]);
    const q = emitted();
    const projection = q.text.slice(0, q.text.indexOf('FROM jsonb_to_recordset'));
    expect(projection).toContain('own.assemblyai_id AS own_transcript_id');
    expect(projection).toContain('own.suggested_event');
    const own = q.text.slice(q.text.lastIndexOf('LEFT JOIN LATERAL'));
    // Owner only, both on the registry row and on the meeting.
    expect(own).toContain('r.user_id = $');
    expect(own).toContain('t.user_id = $');
    expect(own).toContain('t.deleted_at IS NULL');
    // The suggestion is served only while it is live AND names THIS
    // occurrence — otherwise "Not this" would act on another row's guess.
    expect(own).toContain("(t.gmeet_context->'suggestedEvent'->>'dismissedAt') IS NULL");
    expect(own).toContain("(t.gmeet_context->>'eventId') IS NULL");
    expect(own).toContain("(t.gmeet_context->'suggestedEvent'->>'meetingCode') = o.code");
  });

  test('every row the fold returns is a CONFIDENT match — the gate is the join', async () => {
    await recordingsForOccurrences(A, [OCC]);
    const q = emitted();
    const join = q.text.slice(q.text.indexOf('JOIN "meeting_whisperer'), q.text.indexOf('LEFT JOIN'));
    expect(join).toContain("r.matched ? 'confident'");
    expect(join).toContain("(r.matched->>'provider_mismatch')::boolean");
  });

  test('an empty page asks nothing at all', async () => {
    const out = await recordingsForOccurrences(A, []);
    expect(out.size).toBe(0);
    expect(sql.executed.length).toBe(0);
  });
});
