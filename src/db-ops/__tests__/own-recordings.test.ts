/**
 * P6 (docs/recordings-meetings-series-design.md §4.1): `GET /api/recordings
 * ?mine=1` serves the caller's OWN recordings and nothing else (invariant I2
 * — not even the existence of anyone else's).
 *
 * Over the fake postgres tag (helpers/fake-sql). The fake database answers
 * EVERY caller with the same rows, including other people's — i.e. it plays
 * the part of an owner predicate gone missing — so the tests prove both
 * halves: the SQL asks for the caller's rows only, and the fold drops any
 * row that is not the caller's even if the SQL were to hand it one.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];

const A = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'Alok.Raj@trames.sg' };
const B = { userId: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'Bea.Tan@trames.sg' };

type Mod = typeof import('@/lib/server/own-recordings');
let mod: Mod;

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  mod = await import('@/lib/server/own-recordings');
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

/** A raw row of the listing-v2 page query (what listPagedForUser maps). */
function pageRow(
  id: string,
  userId: string,
  access: 'owner' | 'edit' | 'read',
  over: Record<string, unknown> = {}
) {
  return {
    id: Math.floor(Math.random() * 1e6),
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
    __access: access,
    __total_days: 1,
    __page_days: 1,
    day_key: '2026-09-22',
    matched_in: null,
    snippet: null,
    ...over,
  };
}

/** The same "database" for every caller: A's and B's rows alike. */
const WORLD = {
  registry: [registryRow('reg-a', A.userId), registryRow('reg-b', B.userId), registryRow('reg-a-del', A.userId, 'deleted')],
  // The `mine` page. A real `mine` page never carries another user's row;
  // these are here to prove the fold does not trust that.
  mine: [
    pageRow('a-bare', A.userId, 'owner'),
    pageRow('a-named', A.userId, 'owner', { title: 'Triton next steps!' }),
    pageRow('a-linked', A.userId, 'owner', { has_event: true }),
    pageRow('b-bare-shared-edit', B.userId, 'edit'),
    pageRow('b-bare-shared-read', B.userId, 'read'),
    pageRow('b-bare', B.userId, 'owner'),
  ],
  // The `scratch` page IS owned + shared in real life (the old Temporary tab).
  scratch: [
    pageRow('a-tmp', A.userId, 'owner', { scratch: true }),
    pageRow('b-tmp-shared-with-a', B.userId, 'read', { scratch: true }),
    pageRow('b-tmp', B.userId, 'owner', { scratch: true }),
  ],
};

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = (q) => {
    if (q.text.includes('recorder_recordings')) return WORLD.registry;
    if (q.text.includes('WITH base AS')) {
      return q.text.includes('AND t.scratch') ? WORLD.scratch : WORLD.mine;
    }
    return [];
  };
});

describe('parseOwnRecordingsQuery', () => {
  test('mine=1 is required — there is no other listing', () => {
    expect(mod.parseOwnRecordingsQuery(new URLSearchParams('')).ok).toBe(false);
    expect(mod.parseOwnRecordingsQuery(new URLSearchParams('unlinked=1')).ok).toBe(false);
    expect(mod.parseOwnRecordingsQuery(new URLSearchParams('mine=0')).ok).toBe(false);
  });
  test('section flags: neither = both; one = that one', () => {
    const q = (s: string) => {
      const r = mod.parseOwnRecordingsQuery(new URLSearchParams(s));
      if (!r.ok) throw new Error(r.error);
      return r.query;
    };
    expect(q('mine=1')).toMatchObject({ unlinked: true, temporary: true });
    expect(q('mine=1&unlinked=1')).toMatchObject({ unlinked: true, temporary: false });
    expect(q('mine=1&temporary=1')).toMatchObject({ unlinked: false, temporary: true });
    expect(q('mine=1&unlinked=1&temporary=1')).toMatchObject({ unlinked: true, temporary: true });
  });
  test('a bad tz falls back to UTC', () => {
    const r = mod.parseOwnRecordingsQuery(new URLSearchParams('mine=1&tz=Foo/Bar'));
    expect(r.ok && r.query.tz).toBe('UTC');
    const r2 = mod.parseOwnRecordingsQuery(new URLSearchParams("mine=1&tz=';drop"));
    expect(r2.ok && r2.query.tz).toBe('UTC');
  });
});

describe('listOwnRecordingsSurface — the SQL asks for the caller’s rows only', () => {
  test('registry: WHERE user_id = caller', async () => {
    await mod.listOwnRecordingsSurface(A, { unlinked: true, temporary: false, tz: 'UTC' });
    const reg = sql.executed.find((q) => q.text.includes('recorder_recordings'));
    expect(reg?.text).toContain('WHERE user_id = $');
    expect(reg?.params).toContain(A.userId);
    expect(reg?.params).not.toContain(B.userId);
  });

  test('uploads: the listing’s `mine` predicate (AND t.user_id = caller)', async () => {
    await mod.listOwnRecordingsSurface(A, { unlinked: true, temporary: false, tz: 'UTC' });
    const page = sql.executed.find((q) => q.text.includes('WITH base AS'));
    expect(page?.text).toContain('AND t.user_id = $');
    expect(page?.text).toContain('NOT t.scratch');
    // Temporary rows are not asked for unless requested.
    expect(sql.executed.some((q) => q.text.includes('WITH base AS') && q.text.includes('AND t.scratch'))).toBe(false);
  });

  test('temporary only: no registry and no uploads query', async () => {
    const out = await mod.listOwnRecordingsSurface(A, { unlinked: false, temporary: true, tz: 'UTC' });
    expect(sql.executed.some((q) => q.text.includes('recorder_recordings'))).toBe(false);
    expect(out.registry).toBeUndefined();
    expect(out.unlinked).toBeUndefined();
    expect(out.temporary?.map((r) => r.assemblyai_id)).toEqual(['a-tmp']);
  });
});

describe('two users, one database — each sees only their own', () => {
  test('A: own registry (not deleted), own bare upload, own temporary', async () => {
    const out = await mod.listOwnRecordingsSurface(A, { unlinked: true, temporary: true, tz: 'UTC' });
    expect(out.registry?.map((r) => r.id)).toEqual(['reg-a']);
    // Named and linked rows are meetings, not recordings; B's rows — shared
    // with A for edit or read, or not at all — are never A's recordings.
    expect(out.unlinked?.map((r) => r.assemblyai_id)).toEqual(['a-bare']);
    // A temporary upload B shared with A stays B's (Q7 grandfathers the
    // share; it does not put B's recording on A's surface).
    expect(out.temporary?.map((r) => r.assemblyai_id)).toEqual(['a-tmp']);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('reg-b');
    expect(wire).not.toContain('b-');
    expect(wire).not.toContain(B.userId);
  });

  test('B: the mirror image — nothing of A’s, not even its existence', async () => {
    const out = await mod.listOwnRecordingsSurface(B, { unlinked: true, temporary: true, tz: 'UTC' });
    expect(out.registry?.map((r) => r.id)).toEqual(['reg-b']);
    expect(out.unlinked?.map((r) => r.assemblyai_id)).toEqual(['b-bare']);
    expect(out.temporary?.map((r) => r.assemblyai_id)).toEqual(['b-tmp']);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('reg-a');
    expect(wire).not.toContain('a-bare');
    expect(wire).not.toContain('a-tmp');
    expect(wire).not.toContain(A.userId);
  });

  test('a caller with nothing gets empty sections, not an error', async () => {
    respond = () => [];
    const out = await mod.listOwnRecordingsSurface(A, { unlinked: true, temporary: true, tz: 'UTC' });
    expect(out).toEqual({ registry: [], unlinked: [], temporary: [] });
  });
});
