/**
 * Phase 3b (docs/recordings-phase3b-combine-spec.md) — the db half, over the
 * fake postgres tag: what the CANDIDATE query actually asks, what the
 * `MW_COMBINE` gate ANDs together, and what a clip write sends.
 *
 * The candidate test is the privacy one (spec §Privacy,
 * feedback_privacy_caller_scoping_gate): "every list of candidate recordings
 * is caller-scoped" is a claim about SQL, so it is checked against the SQL.
 *
 * `mock.module` is process-wide in `bun test`: only `@/lib/db`, `server-only`
 * and the event bus are stubbed here, exactly as `clips.test.ts` does, and the
 * migration probes are answered through the fake tag rather than mocked away.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let respond: (q: RenderedQuery) => unknown[] = () => [];

function migrationProbe(q: RenderedQuery): unknown[] | null {
  if (q.text.includes("table_name IN ('recordings'")) return [{ tables: 4, columns: 2 }];
  if (q.text.includes("column_name = 'aai_job_id'")) return [{ n: 1 }];
  return null;
}

const sql: FakeSql = createFakeSql((q) => respond(q));
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));
mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
mock.module('@/lib/server/event-bus', () => ({ publishEvent: () => {} }));

const {
  combineEnabled,
  combineFlagOn,
  listAddableRecordings,
  recordingDetailsFor,
  upsertMeetingClip,
  deleteMeetingClip,
  clippedMeetingsOnRecordingExcept,
} = await import('@/db-ops/clips');

const REC = '11111111-1111-5111-8111-111111111111';
const CALLER = { userId: 'user-alok', email: 'Alok@Trames.SG' };

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = (q) => migrationProbe(q) ?? [];
  process.env.MW_COMBINE = '1';
  process.env.MW_CLIPS = '1';
  process.env.MW_RECORDINGS_WRITE = '1';
});

describe('the MW_COMBINE gate', () => {
  test('it is MW_COMBINE AND the whole clips gate under it', async () => {
    expect(combineFlagOn()).toBe(true);
    expect(await combineEnabled()).toBe(true);

    for (const v of [undefined, '0', 'false', 'FALSE', '']) {
      if (v === undefined) delete process.env.MW_COMBINE;
      else process.env.MW_COMBINE = v;
      expect(combineFlagOn()).toBe(false);
      expect(await combineEnabled()).toBe(false);
    }

    // Combining writes a second clip row and materialises the merged payload
    // onto the meeting: without clips there is nothing to read it.
    process.env.MW_COMBINE = '1';
    delete process.env.MW_CLIPS;
    expect(combineFlagOn()).toBe(false);
    process.env.MW_CLIPS = '1';
    delete process.env.MW_RECORDINGS_WRITE;
    expect(combineFlagOn()).toBe(false);
  });

  // The migration half of the gate is `clipsEnabled`'s and is proved in
  // clips.test.ts — it is probed once per process, so re-proving it here
  // would only assert on the cache.
});

describe('PRIVACY: the candidate list is caller-scoped in SQL', () => {
  test('a recording reaches the list only by ownership or an editable meeting', async () => {
    await listAddableRecordings(CALLER);
    const q = sql.executed.at(-1)!;

    // Route (b): the caller owns it.
    expect(q.text).toContain('r.owner_user_id = $');
    // Route (a): through a meeting — and EDIT, not merely read. A read-only
    // reader is never offered somebody's recording.
    expect(q.text).toContain('mt.can_edit IS TRUE');
    expect(q.text).toContain("s.access IS DISTINCT FROM 'read'");
    // The share predicate is the same one resolveAccess uses, on the
    // lower-cased email.
    expect(q.params).toContain('alok@trames.sg');
    expect(q.params).toContain('user-alok');
    expect(q.text).toContain('s.shared_with_email = $');
    // Trashed meetings and deleted recordings contribute nothing.
    expect(q.text).toContain('t.deleted_at IS NULL');
    expect(q.text).toContain('r.deleted_at IS NULL');
  });

  test('a meeting the caller cannot open never contributes its title', async () => {
    await listAddableRecordings(CALLER);
    const q = sql.executed.at(-1)!;
    // The meeting columns come from ONE lateral, and that lateral carries the
    // caller predicate itself — so a row that is visible by ownership alone
    // still cannot borrow someone else's meeting title.
    const lateral = q.text.slice(q.text.indexOf('LEFT JOIN LATERAL'));
    expect(lateral).toContain('t.user_id = $');
    expect(lateral).toContain('s.id IS NOT NULL');
    expect(lateral).toContain('t.title');
    // …and the outer SELECT reads the title only through that lateral.
    expect(q.text).toContain('mt.title AS meeting_title');
  });

  test('a single-recording probe is the same query, narrowed', async () => {
    await listAddableRecordings(CALLER, { recordingId: REC });
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('AND r.id = $');
    expect(q.params).toContain(REC);
    // Still caller-scoped: this is what the add route asks to decide between
    // 404 (cannot reach it) and 403 (can reach it, does not own it).
    expect(q.text).toContain('r.owner_user_id = $');
  });
});

describe('recording details', () => {
  test('transcribed means a COMPLETED transcription with a payload', async () => {
    await recordingDetailsFor([REC]);
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain("rt.status = 'completed'");
    expect(q.text).toContain('rt.payload IS NOT NULL');
    // The filename a person recognises, not the uuid on disk.
    expect(q.text).toContain("source_ref->>'originalFilename'");
    expect(q.text).toContain("m.kind = 'canonical'");
  });

  test('no ids means no query at all', async () => {
    const out = await recordingDetailsFor([]);
    expect(out.size).toBe(0);
    expect(sql.executed).toHaveLength(0);
  });
});

describe('writing one clip', () => {
  test('an add touches ONLY its own ord', async () => {
    await upsertMeetingClip({
      transcriptId: 7,
      ord: 1,
      recordingId: REC,
      fromMs: 0,
      toMs: null,
      offsetMs: 6_600_000,
      textPolicy: 'gap_fill',
      createdBy: 'combine:alok@trames.sg',
    });
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('INSERT INTO');
    expect(q.text).toContain('ON CONFLICT (transcript_id, ord) DO UPDATE');
    // The whole reason this is not `applyMeetingClips`: that one DELETEs
    // every ord the caller did not name, which would take the meeting's
    // existing clips with it.
    expect(q.text).not.toContain('DELETE');
    expect(q.params).toContain('gap_fill');
    expect(q.params).toContain(6_600_000);
  });

  test('un-combine deletes one clip and names the recording it freed', async () => {
    respond = () => [{ recording_id: REC }];
    const freed = await deleteMeetingClip(7, 1);
    expect(freed).toBe(REC);
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('DELETE FROM');
    expect(q.text).toContain('transcript_id = $');
    expect(q.text).toContain('ord = $');
    // No recording, no media, no file is touched — a clip is a pointer.
    expect(q.text).not.toContain('recordings');
    expect(q.text).not.toContain('recording_media');
  });
});

describe('playable now, text later', () => {
  test('the completion sweep finds the OTHER clipped meetings on a recording', async () => {
    respond = () => [{ transcript_id: 9 }];
    const ids = await clippedMeetingsOnRecordingExcept(REC, 7);
    expect(ids).toEqual([9]);
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('c.transcript_id <> $');
    // Un-clipped meetings are skipped: their row already IS the payload.
    expect(q.text).toContain("t.gmeet_context ? 'clips'");
  });
});
