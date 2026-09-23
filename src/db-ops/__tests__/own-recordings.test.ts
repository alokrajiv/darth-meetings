/**
 * `GET /api/recordings?mine=1` serves the caller's OWN recordings and nothing
 * else (invariant I2 — not even the existence of anyone else's). P6 made it
 * an endpoint; P7 (owner decision 2026-09-23) made it ONE cursor-paginated
 * list over three owner-scoped sources: standalone recordings, legacy bare /
 * temporary `transcripts` rows, and Darth Recorder rows still on a Mac.
 *
 * Over the fake postgres tag (helpers/fake-sql). The fake database answers
 * EVERY caller with the same rows, including other people's — i.e. it plays
 * the part of an owner predicate gone missing — so the tests prove both
 * halves: the SQL asks for the caller's rows only, and the fold drops any
 * row that is not the caller's even if the SQL were to hand it one.
 * (The real-Postgres half — paging across the three sources with no dupes or
 * gaps, a row older than 60 days, the SQL twin of the bare-title rule — is
 * the P7 scratch check, docs/recordings-meetings-series-design.md "As built —
 * P7/P8".)
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];

const A = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'Alok.Raj@trames.sg' };
const B = { userId: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'Bea.Tan@trames.sg' };

type Mod = typeof import('@/lib/server/own-recordings');
let mod: Mod;
let page: typeof import('@/lib/recordings-page');

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  mod = await import('@/lib/server/own-recordings');
  page = await import('@/lib/recordings-page');
});

function registryRow(id: string, userId: string, status = 'local') {
  return {
    id,
    device_id: 'mac-1',
    user_id: userId,
    email: userId === A.userId ? A.email : B.email,
    status,
    started_at: '2026-09-22T07:48:00.000Z',
    ended_at: '2026-09-22T08:30:00.000Z',
    duration_s: 2520,
    bytes: 1000,
    segments: null,
    call: { title: `call of ${id}`, app: 'Slack' },
    shares: null,
    matched: null,
    transcript_id: null,
    error: null,
    created_at: '2026-09-22T07:48:00.000Z',
    updated_at: '2026-09-22T08:30:00.000Z',
  };
}

function meetingRow(id: string, userId: string, over: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: userId,
    assemblyai_id: id,
    original_filename: `${id}.m4a`,
    title: `${id}.m4a`,
    status: 'completed',
    created_at: '2026-09-22T08:31:00.000Z',
    recorded_at: '2026-09-22T07:48:00.000Z',
    has_event: false,
    scratch: false,
    deleted_at: null,
    source: 'uploaded',
    provider: null,
    recorder_recording_id: null,
    ...over,
  };
}

function recordingRow(id: string, owner: string) {
  return {
    id,
    owner_user_id: owner,
    source_kind: 'recorder',
    started_at: '2026-09-22T07:48:00.000Z',
    duration_ms: 60_000,
    sha256: null,
    recorder_recording_id: null,
    active_transcription_id: 'tttttttt-0000-4000-8000-000000000001',
    created_at: '2026-09-22T08:31:00.000Z',
    updated_at: '2026-09-22T08:31:00.000Z',
    deleted_at: null,
    standalone: true,
    title: `rec ${id}`,
    expires_at: null,
    upload_state: { originalFilename: 'call.m4a', ownerEmail: 'someone@trames.sg' },
    ready_notified_at: null,
    txn_status: 'completed',
    txn_language_code: 'en',
    txn_speech_model: 'universal',
    txn_completed_at: '2026-09-22T08:40:00.000Z',
    provider_deleted_at: null,
    canonical_filename: `${id}.m4a`,
    canonical_bytes: 10,
    canonical_has_video: false,
    part_count: 0,
    live_clips: 0,
    all_clips: 0,
    recorder_matched: null,
    recorder_call: null,
  };
}

const REG_A = 'a2222222-0000-4000-8000-000000000001';
const REG_B = 'b2222222-0000-4000-8000-000000000001';
const RA = 'a1111111-0000-4000-8000-000000000001';
const RB = 'b1111111-0000-4000-8000-000000000001';

/** The same "database" for every caller: A's and B's rows alike. */
const WORLD = {
  keys: [
    { kind: 'recording', id: RA, section: 'uploaded', sort_us: '1758527280000003' },
    { kind: 'recording', id: RB, section: 'uploaded', sort_us: '1758527280000002' },
    { kind: 'meeting', id: 'a-bare', section: 'uploaded', sort_us: '1758527280000001' },
    { kind: 'meeting', id: 'b-bare', section: 'uploaded', sort_us: '1758527280000001' },
    { kind: 'meeting', id: 'a-tmp', section: 'temporary', sort_us: '1758527280000000' },
    { kind: 'registry', id: REG_A, section: 'mac', sort_us: '1758527279000000' },
    { kind: 'registry', id: REG_B, section: 'mac', sort_us: '1758527279000000' },
  ],
  counts: [
    { section: 'mac', n: 1 },
    { section: 'uploaded', n: 2 },
    { section: 'temporary', n: 1 },
  ],
  recordings: [recordingRow(RA, A.userId), recordingRow(RB, B.userId)],
  meetings: [
    meetingRow('a-bare', A.userId),
    meetingRow('a-tmp', A.userId, { scratch: true }),
    meetingRow('b-bare', B.userId),
  ],
  registry: [registryRow(REG_A, A.userId), registryRow(REG_B, B.userId)],
};

beforeEach(() => {
  // Process-wide probe caches (another test file may have cached "absent").
  const g = globalThis as { __mwStandaloneColumns?: unknown; __mwAaiJobIdColumn?: unknown };
  g.__mwStandaloneColumns = undefined;
  g.__mwAaiJobIdColumn = undefined;
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = (q) => {
    if (q.text.includes('information_schema.columns')) return [{ n: 6 }];
    if (q.text.includes('GROUP BY i.section')) return WORLD.counts;
    if (q.text.includes('ORDER BY i.sort_us DESC')) return WORLD.keys;
    if (q.text.includes('.recordings r') && q.text.includes('r.id = ANY')) {
      return WORLD.recordings;
    }
    if (q.text.includes('t.assemblyai_id = ANY')) return WORLD.meetings;
    if (q.text.includes('recorder_recordings') && q.text.includes('id = ANY')) return WORLD.registry;
    return [];
  };
});

const params = (qs: string) => new URLSearchParams(qs);

describe('parseRecordingsPageQuery', () => {
  test('mine=1 is required — there is no other listing', () => {
    expect(page.parseRecordingsPageQuery(params('')).ok).toBe(false);
    expect(page.parseRecordingsPageQuery(params('mine=0')).ok).toBe(false);
    expect(page.parseRecordingsPageQuery(params('mine=1')).ok).toBe(true);
  });

  test('sections: section= wins; the old flags still select; neither = all three', () => {
    const s = (qs: string) => {
      const r = page.parseRecordingsPageQuery(params(qs));
      return r.ok ? r.query.sections : null;
    };
    expect(s('mine=1')).toEqual(['mac', 'uploaded', 'temporary']);
    expect(s('mine=1&unlinked=1')).toEqual(['mac', 'uploaded']);
    expect(s('mine=1&temporary=1')).toEqual(['temporary']);
    expect(s('mine=1&unlinked=1&temporary=1')).toEqual(['mac', 'uploaded', 'temporary']);
    expect(s('mine=1&section=mac&temporary=1')).toEqual(['mac']);
    expect(page.parseRecordingsPageQuery(params('mine=1&section=trash')).ok).toBe(false);
  });

  test('limit: default 50, 0 = counts only, max 200', () => {
    const l = (qs: string) => {
      const r = page.parseRecordingsPageQuery(params(qs));
      return r.ok ? r.query.limit : 'error';
    };
    expect(l('mine=1')).toBe(50);
    expect(l('mine=1&limit=0')).toBe(0);
    expect(l('mine=1&limit=200')).toBe(200);
    expect(l('mine=1&limit=201')).toBe('error');
    expect(l('mine=1&limit=-1')).toBe('error');
    expect(l('mine=1&limit=2.5')).toBe('error');
  });

  test('cursor round-trips exactly (microseconds as a string); junk is a 400', () => {
    const c = { sortUs: '1758527280123456', kind: 'meeting' as const, id: 'a-bare' };
    const raw = page.encodeRecordingsCursor(c);
    const r = page.parseRecordingsPageQuery(params(`mine=1&cursor=${raw}`));
    expect(r.ok && r.query.cursor).toEqual(c);
    expect(page.parseRecordingsPageQuery(params('mine=1&cursor=zzz')).ok).toBe(false);
    expect(page.decodeRecordingsCursor(page.encodeRecordingsCursor({ ...c, kind: 'nope' as never }))).toBeNull();
  });

  test('q is trimmed and NUL-stripped; regex only with a q; a bad tz falls back to UTC', () => {
    const r = page.parseRecordingsPageQuery(params('mine=1&q=%20zoom%00%20&regex=1&tz=Not/AZone'));
    expect(r.ok && r.query.q).toBe('zoom');
    expect(r.ok && r.query.regex).toBe(true);
    expect(r.ok && r.query.tz).toBe('UTC');
    const n = page.parseRecordingsPageQuery(params('mine=1&regex=1'));
    expect(n.ok && n.query.regex).toBe(false);
  });

  test('ilikePattern takes the caller’s % and _ literally', () => {
    expect(page.ilikePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('the page SQL asks for the caller’s rows only', () => {
  const run = async (qs = 'mine=1') => {
    const parsed = page.parseRecordingsPageQuery(params(qs));
    if (!parsed.ok) throw new Error(parsed.error);
    return mod.listOwnRecordingsSurface(A, parsed.query);
  };

  test('each source carries its owner predicate, bound to the caller; no share join; no day window', async () => {
    await run();
    const pageSql = sql.executed.find((q) => q.text.includes('ORDER BY i.sort_us DESC'))!;
    expect(pageSql).toBeDefined();
    expect(pageSql.text).toContain('r.owner_user_id = $');
    expect(pageSql.text).toContain('t.user_id = $');
    expect(pageSql.text).toContain('rr.user_id = $');
    expect(pageSql.text).not.toContain('transcript_shares');
    expect(pageSql.text).not.toMatch(/interval|days/i);
    // every bound user id is the caller's
    const ids = pageSql.params.filter((p) => typeof p === 'string' && /^[ab]{8}-/.test(p as string));
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids)).toEqual(new Set([A.userId]));
    // hydration re-asks the owner, too
    const hydrate = sql.executed.filter((q) => q.text.includes('= ANY('));
    expect(hydrate.length).toBeGreaterThanOrEqual(3);
    for (const h of hydrate) {
      expect(h.params).toContain(A.userId);
      expect(h.params).not.toContain(B.userId);
    }
  });

  test('limit=0 asks for counts only — no page, no hydration', async () => {
    const out = await run('mine=1&limit=0');
    expect(sql.executed.some((q) => q.text.includes('ORDER BY i.sort_us DESC'))).toBe(false);
    expect(sql.executed.some((q) => q.text.includes('= ANY('))).toBe(false);
    expect(out.items).toEqual([]);
    expect(out.counts).toEqual({ mac: 1, uploaded: 2, temporary: 1 });
  });

  test('a search binds q as a parameter (ILIKE, or ~* under regex=1)', async () => {
    await run('mine=1&q=50%25');
    const p1 = sql.executed.find((q) => q.text.includes('ORDER BY i.sort_us DESC'))!;
    expect(p1.text).toContain('ILIKE $');
    expect(p1.params).toContain('%50\\%%');
    sql.executed.length = 0;
    await run('mine=1&q=^rec&regex=1');
    const p2 = sql.executed.find((q) => q.text.includes('ORDER BY i.sort_us DESC'))!;
    expect(p2.text).toContain('~* $');
    expect(p2.params).toContain('^rec');
  });
});

describe('two users, one database — each sees only their own', () => {
  test('A: own recording, own bare + temporary upload, own Mac row — in page order', async () => {
    const parsed = page.parseRecordingsPageQuery(params('mine=1'));
    if (!parsed.ok) throw new Error('parse');
    const out = await mod.listOwnRecordingsSurface(A, parsed.query);
    expect(
      out.items.map((i) =>
        i.kind === 'recording' ? i.recording.id : i.kind === 'meeting' ? i.row.assemblyai_id : i.registry.id
      )
    ).toEqual([RA, 'a-bare', 'a-tmp', REG_A]);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(RB);
    expect(wire).not.toContain('b-bare');
    expect(wire).not.toContain(REG_B);
    expect(wire).not.toContain(B.userId);
    expect(wire).not.toContain('someone@trames.sg'); // the DM address never leaves the server
  });

  test('B: the mirror image — nothing of A’s, not even its existence', async () => {
    const parsed = page.parseRecordingsPageQuery(params('mine=1'));
    if (!parsed.ok) throw new Error('parse');
    const out = await mod.listOwnRecordingsSurface(B, parsed.query);
    expect(
      out.items.map((i) =>
        i.kind === 'recording' ? i.recording.id : i.kind === 'meeting' ? i.row.assemblyai_id : i.registry.id
      )
    ).toEqual([RB, 'b-bare', REG_B]);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(RA);
    expect(wire).not.toContain('a-bare');
    expect(wire).not.toContain('a-tmp');
    expect(wire).not.toContain(A.userId);
  });

  test('a page one longer than the limit yields a next_cursor at the last kept key', async () => {
    const parsed = page.parseRecordingsPageQuery(params('mine=1&limit=2'));
    if (!parsed.ok) throw new Error('parse');
    const out = await mod.listOwnRecordingsSurface(A, parsed.query);
    expect(out.next_cursor).not.toBeNull();
    expect(page.decodeRecordingsCursor(out.next_cursor)).toEqual({
      sortUs: '1758527280000002',
      kind: 'recording',
      id: RB,
    });
  });

  test('a caller with nothing gets an empty page and zero counts, not an error', async () => {
    respond = (q) => (q.text.includes('information_schema.columns') ? [{ n: 6 }] : []);
    const parsed = page.parseRecordingsPageQuery(params('mine=1'));
    if (!parsed.ok) throw new Error('parse');
    const out = await mod.listOwnRecordingsSurface(A, parsed.query);
    expect(out).toEqual({ items: [], next_cursor: null, counts: { mac: 0, uploaded: 0, temporary: 0 } });
  });
});
