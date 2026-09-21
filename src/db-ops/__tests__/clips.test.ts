/**
 * The clips db-ops over the fake postgres tag (helpers/fake-sql): what the
 * sibling query actually asks, what the gate ANDs together, and what the clip
 * mirror writes. No socket, no cluster — the end-to-end proof lives in
 * `tmp/recordings-clips/clips.check.ts`.
 *
 * The sibling test is the privacy one (spec §API,
 * feedback_privacy_caller_scoping_gate): a person shared only the split-off
 * half must never learn that the meeting it came from exists.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let respond: (q: RenderedQuery) => unknown[] = () => [];

/** The migration probes, answered as a schema with 044–046 applied. */
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
// NOTHING else is mocked. `mock.module` is process-wide in `bun test`, and
// `@/db-ops/transcriptions` / `@/db-ops/aai-job-id` are imported by half the
// server — a partial stub of either takes the whole run down (it did). The
// two migration probes the gate ANDs with are answered through the fake tag
// instead, which is also a better test: it proves what they ask.

const { clipsEnabled, clipsFlagOn, setClipMirror, listMeetingClips, purgeMeetingAnnotations } =
  await import('@/db-ops/clips');
const { listSiblingMeetingsForRecordings } = await import('@/db-ops/recordings');

const REC = '11111111-1111-5111-8111-111111111111';

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = (q) => migrationProbe(q) ?? [];
  process.env.MW_CLIPS = '1';
  process.env.MW_RECORDINGS_WRITE = '1';
});

describe('the MW_CLIPS gate', () => {
  test('both flags, and in that order', () => {
    expect(clipsFlagOn()).toBe(true);
    for (const v of [undefined, '0', 'false', 'FALSE', '']) {
      if (v === undefined) delete process.env.MW_CLIPS;
      else process.env.MW_CLIPS = v;
      expect(clipsFlagOn()).toBe(false);
    }
    process.env.MW_CLIPS = '1';
    // A clip lives on the recording graph: without the dual-write the very
    // next sync would heal the split away.
    delete process.env.MW_RECORDINGS_WRITE;
    expect(clipsFlagOn()).toBe(false);
    process.env.MW_RECORDINGS_WRITE = '0';
    expect(clipsFlagOn()).toBe(false);
  });

  test('the flag off short-circuits: not even a migration probe is sent', async () => {
    delete process.env.MW_CLIPS;
    expect(await clipsEnabled()).toBe(false);
    expect(sql.executed).toHaveLength(0);
  });

  test('on a schema with 044\u2013046 applied it is on', async () => {
    expect(await clipsEnabled()).toBe(true);
    // The probes it AND-ed with — both cached for the rest of the process,
    // which is why "tables missing" is proved in the scratch check instead.
    const asked = sql.executed.map((q) => q.text).join(' ');
    expect(asked).toContain('information_schema');
  });
});

describe('siblings are CALLER-scoped in SQL (the privacy gate)', () => {
  test('the predicate is owner-or-share, on the caller’s lower-cased email', async () => {
    await listSiblingMeetingsForRecordings([REC], 42, {
      userId: 'user-1',
      email: '  Jacqueline.Ng@Trames.SG ',
    });
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain('JOIN');
    expect(q.text).toContain('transcript_shares');
    // Both halves of the predicate, and nothing that could widen it.
    expect(q.text).toMatch(/t\.user_id = \$\d+ OR s\.id IS NOT NULL/);
    expect(q.text).toMatch(/c\.transcript_id <> \$\d+/);
    expect(q.params).toContain('user-1');
    // Lower-cased and trimmed — the share table stores it that way.
    expect(q.params).toContain('jacqueline.ng@trames.sg');
  });

  test('no recordings ⇒ no query at all', async () => {
    const out = await listSiblingMeetingsForRecordings([], 42, { userId: 'u', email: 'e@x' });
    expect(out).toEqual([]);
    expect(sql.executed).toHaveLength(0);
  });

  test('a caller with neither ownership nor a share gets NOTHING — not a count, not an id', async () => {
    // The database answers the caller-scoped query with no rows, which is the
    // whole mechanism: there is no second, unscoped path to the same table.
    respond = (q) => migrationProbe(q) ?? [];
    const out = await listSiblingMeetingsForRecordings([REC], 42, {
      userId: 'stranger',
      email: 'stranger@trames.sg',
    });
    expect(out).toEqual([]);
  });

  test('trashed siblings come back flagged (they still hold the bytes alive)', async () => {
    respond = (q) =>
      migrationProbe(q) ?? [
      {
        transcript_id: 9,
        assemblyai_id: 'abc',
        title: 'Podcast',
        from_ms: 0,
        to_ms: 760_000,
        duration: 760,
        trashed: true,
        split_from: null,
      },
    ];
    const out = await listSiblingMeetingsForRecordings([REC], 42, { userId: 'u', email: 'e@x' });
    expect(out[0]!.trashed).toBe(true);
  });
});

describe('the clip mirror on the row', () => {
  test('writing windows sets gmeet_context.clips', async () => {
    await setClipMirror('owner', 'meeting-1', {
      clips: [{ ord: 0, recordingId: REC, fromMs: 0, toMs: 760_000, offsetMs: 0 }],
    });
    const q = sql.executed.at(-1)!;
    expect(q.text).toContain("jsonb_set(COALESCE(gmeet_context, '{}'::jsonb), '{clips}'");
    expect(q.text).not.toContain("- 'clips'");
  });

  test('a meeting that is whole again LOSES the key, not just its contents', async () => {
    // Leaving an empty mirror behind would keep `deriveRecordingGraph` in
    // "this row is clipped" mode for ever and its payload would never be
    // copied onto the transcription again.
    await setClipMirror('owner', 'meeting-1', { clips: null });
    expect(sql.executed.at(-1)!.text).toContain("COALESCE(gmeet_context, '{}'::jsonb) - 'clips'");
  });

  test('splitFrom rides along, and null clears it', async () => {
    await setClipMirror('owner', 'meeting-1', { clips: null, splitFrom: null });
    expect(sql.executed.at(-1)!.text).toContain("- 'splitFrom'");
    await setClipMirror('owner', 'meeting-1', {
      clips: [{ ord: 0, recordingId: REC, fromMs: 1, toMs: 2, offsetMs: 0 }],
      splitFrom: { meetingId: 'src' },
    });
    expect(sql.executed.at(-1)!.text).toContain("'{splitFrom}'");
  });
});

describe('reads', () => {
  test('a meeting’s clips are scoped to that meeting and ordered by ord', async () => {
    await listMeetingClips(7);
    const q = sql.executed.at(-1)!;
    expect(q.text).toMatch(/WHERE transcript_id = \$\d+ ORDER BY ord/);
    expect(q.params).toContain(7);
  });

  test('purging a destroyed meeting takes EVERY user’s annotations', async () => {
    await purgeMeetingAnnotations('meeting-1');
    const texts = sql.executed.map((q) => q.text);
    expect(texts.some((t) => t.includes('transcript_edits') && t.includes('DELETE'))).toBe(true);
    expect(texts.some((t) => t.includes('speaker_mappings') && t.includes('DELETE'))).toBe(true);
    // No `user_id =` anywhere: the meeting is going, all of it.
    expect(texts.every((t) => !t.includes('user_id ='))).toBe(true);
  });
});
