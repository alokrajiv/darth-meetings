/**
 * Curated series v2 — the privacy gate at the ROUTES (docs/curated-series-spec.md
 * §11.6; .agent-memory feedback_privacy_caller_scoping_gate: "whose rows can
 * reach this response?").
 *
 *   - a series exists only for its owner, editors, followers and the
 *     auditors: every other caller gets 404 from every /api/series/:id…
 *     route, an empty index, no chip in the listing, no entry in
 *     /transcripts/:id/series or the share dialog, no count from
 *     occurrence-counts, no seriesId preview;
 *   - followers cannot edit; owner/editors can; delete + transfer = owner;
 *   - auditor-owned series: a non-auditor can never become (or act as) an
 *     editor, and only an auditor makes an auditor the owner;
 *   - the preview counts within a reach, never org-wide.
 *
 * Driven as a low-involvement caller (Radhika) next to the series' people,
 * over the fake postgres tag + an in-memory series world.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from '../../../db-ops/__tests__/helpers/fake-sql';
import { seriesWorldResponder, type World } from './helpers/series-world';

const P = (id: string, email: string) => ({ userId: id, email });
const RADHIKA = P('11111111-0000-4000-8000-000000000001', 'Radhika@trames.sg');
const KAWEN = P('11111111-0000-4000-8000-000000000002', 'kawen.koh@trames.sg');
const SIQIAN = P('11111111-0000-4000-8000-000000000003', 'siqian@trames.sg');
const JAC = P('11111111-0000-4000-8000-000000000004', 'Jacqueline.Ng@trames.sg');
const ALOK = P('11111111-0000-4000-8000-000000000005', 'alok@trames.sg');
const IVAN = P('11111111-0000-4000-8000-000000000006', 'ivan@trames.sg');
const ELI = P('11111111-0000-4000-8000-000000000007', 'eli@trames.sg');
let currentUser = RADHIKA;

let sql: FakeSql;
let world: World;
/** The access resolveAccess answers for meeting m-501. */
let access: 'owner' | 'edit' | 'read' | null;

const fresh = (): World => ({
  ready053: true,
  ready054: true,
  auditors: ['alok@trames.sg', 'ivan@trames.sg'],
  identities: {},
  series: [
    {
      id: 1,
      title: 'AM Briefing: SiQian (secret)',
      priority: 50,
      patterns: [{ kind: 'title', regex: '^Juggling the Customers' }],
      owner_email: 'kawen.koh@trames.sg',
      owner_user_id: KAWEN.userId,
      editors: ['siqian@trames.sg'],
      followers: ['jacqueline.ng@trames.sg'],
      rules: [],
    },
    {
      id: 2,
      title: 'Board prep (auditor)',
      priority: 100,
      patterns: [{ kind: 'title', regex: 'Board' }],
      owner_email: 'alok@trames.sg',
      owner_user_id: ALOK.userId,
      // eli: a non-auditor editor left over from before (auditors-table change)
      editors: ['eli@trames.sg'],
      followers: ['jacqueline.ng@trames.sg'],
      rules: [],
    },
  ],
  transcripts: [
    {
      id: 501,
      assemblyai_id: 'm-501',
      user_id: RADHIKA.userId,
      title: 'Juggling the Customers',
      memberships: [[1, 'auto'], [2, 'manual']],
      shares: [],
    },
  ],
});

function respond(q: RenderedQuery): unknown[] {
  const t = q.text;
  if (t.includes('AS "__access"')) {
    if (!access) return [];
    return [
      {
        id: 501,
        user_id: access === 'owner' ? currentUser.userId : RADHIKA.userId,
        assemblyai_id: 'm-501',
        title: 'Juggling the Customers',
        gmeet_context: null,
        __access: access,
      },
    ];
  }
  if (/SELECT user_id FROM "[a-z_]+"\.transcript_activity WHERE user_email/.test(t)) {
    const all = [RADHIKA, KAWEN, SIQIAN, JAC, ALOK, IVAN, ELI];
    const hit = all.find((p) => p.email.toLowerCase() === q.params[0]);
    return hit ? [{ user_id: hit.userId }] : [];
  }
  if (/(INSERT INTO|DELETE FROM) "[a-z_]+"\.series_(editors|followers)/.test(t)) return [{ email: 'x' }];
  if (t.includes('AS visible') && t.includes('AS ctx')) {
    return [{ assemblyai_id: 'mine-1', title: 'Juggling the Customers', ctx: null, at: '2026-10-01', visible: true }];
  }
  return seriesWorldResponder(world)(q) ?? [];
}

const ran = (re: RegExp) => sql.executed.filter((q) => re.test(q.text));
const WRITE = /^(INSERT|DELETE|UPDATE)\b|WITH ins AS \(INSERT|WITH del AS \(DELETE/;
const writes = () => sql.executed.filter((q) => WRITE.test(q.text));
const req = (url: string, init?: RequestInit) => new Request(`http://x${url}`, init);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function resetCaches() {
  const g = globalThis as Record<string, unknown>;
  for (const k of [
    '__mwCuratedSeries053',
    '__mwSeries054',
    '__mwAuditors',
    '__mwCuratedSeriesCache',
    '__mwAuditorLedger',
    '__mwShareOriginColumn',
  ]) {
    g[k] = undefined;
  }
}

type Route = Record<string, (r: Request, c?: unknown) => Promise<Response>>;
const R: Record<string, Route> = {};

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  mock.module('@/lib/auth/with-auth', () => ({
    withAuth:
      (h: (c: { user: typeof RADHIKA; request: Request }, x: unknown) => Promise<Response>) =>
      (request: Request, context: unknown) =>
        h({ user: currentUser, request }, context),
  }));
  R.index = (await import('@/app/api/series/route')) as unknown as Route;
  R.detail = (await import('@/app/api/series/[id]/route')) as unknown as Route;
  R.followers = (await import('@/app/api/series/[id]/followers/route')) as unknown as Route;
  R.editors = (await import('@/app/api/series/[id]/editors/route')) as unknown as Route;
  R.transfer = (await import('@/app/api/series/[id]/transfer/route')) as unknown as Route;
  R.members = (await import('@/app/api/series/[id]/members/route')) as unknown as Route;
  R.occurrences = (await import('@/app/api/series/[id]/occurrences/route')) as unknown as Route;
  R.counts = (await import('@/app/api/series/occurrence-counts/route')) as unknown as Route;
  R.preview = (await import('@/app/api/series/preview/route')) as unknown as Route;
  R.tseries = (await import('@/app/api/transcripts/[id]/series/route')) as unknown as Route;
  R.shares = (await import('@/app/api/transcripts/[id]/shares/route')) as unknown as Route;
});

beforeEach(() => {
  currentUser = RADHIKA;
  world = fresh();
  access = 'owner';
  sql.executed.length = 0;
  sql.log.length = 0;
  resetCaches();
});

afterAll(() => resetCaches());

// ---------------------------------------------------------------------------

describe('a stranger to a series: it does not exist for them — on ANY route', () => {
  test('GET /api/series lists nothing — and the SQL carries the visibility predicate', async () => {
    const res = await R.index!.GET!(req('/api/series'));
    const body = (await res.json()) as { series: unknown[] };
    expect(body.series).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('secret');
    const q = sql.executed.find((x) => x.text.includes('AS visible_member_count'))!;
    expect(q.text).toContain('s.owner_email = $');
    expect(q.text).toContain('ed.email = $');
    expect(q.text).toContain('fo.email = $');
    expect(q.params).toContain('radhika@trames.sg');
  });

  const routes: Array<[string, () => Promise<Response>]> = [
    ['GET /series/1', () => R.detail!.GET!(req('/api/series/1'), ctx('1'))],
    ['PATCH /series/1', () => R.detail!.PATCH!(req('/api/series/1', json({ title: 'x' }, 'PATCH')), ctx('1'))],
    ['DELETE /series/1', () => R.detail!.DELETE!(req('/api/series/1', { method: 'DELETE' }), ctx('1'))],
    ['POST followers', () => R.followers!.POST!(req('/api/series/1/followers', json({ email: 'radhika@trames.sg' })), ctx('1'))],
    ['DELETE followers (self)', () => R.followers!.DELETE!(req('/api/series/1/followers?email=radhika@trames.sg', { method: 'DELETE' }), ctx('1'))],
    ['POST editors', () => R.editors!.POST!(req('/api/series/1/editors', json({ email: 'radhika@trames.sg' })), ctx('1'))],
    ['POST transfer', () => R.transfer!.POST!(req('/api/series/1/transfer', json({ email: 'radhika@trames.sg' })), ctx('1'))],
    ['POST members', () => R.members!.POST!(req('/api/series/1/members', json({ transcriptId: 'm-501' })), ctx('1'))],
    ['DELETE members (her own meeting)', () => R.members!.DELETE!(req('/api/series/1/members?transcriptId=m-501&remember=1', { method: 'DELETE' }), ctx('1'))],
    ['GET occurrences', () => R.occurrences!.GET!(req('/api/series/1/occurrences'), ctx('1'))],
    ['POST preview {seriesId}', () => R.preview!.POST!(req('/api/series/preview', json({ patterns: [{ kind: 'title', regex: 'x' }], seriesId: 1 })))],
  ];
  for (const [name, call] of routes) {
    test(`${name} → 404, nothing written, nothing named`, async () => {
      const res = await call();
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('secret');
      expect(writes()).toHaveLength(0);
    });
  }

  test('occurrence-counts reports null exactly like a missing id', async () => {
    const res = await R.counts!.GET!(req('/api/series/occurrence-counts?ids=1,2'));
    expect(((await res.json()) as { counts: Record<string, unknown> }).counts).toEqual({ 1: null, 2: null });
  });

  test('GET /api/transcripts/:id/series on HER OWN meeting names neither series it is in', async () => {
    const res = await R.tseries!.GET!(req('/api/transcripts/m-501/series'), ctx('m-501'));
    const body = (await res.json()) as { memberships: unknown[]; membership: unknown; canEdit: boolean };
    expect(body.memberships).toEqual([]);
    expect(body.membership).toBeNull();
    expect(body.canEdit).toBe(true);
    const q = sql.executed.find((x) => x.text.includes('SELECT m.series_id, s.title, m.how, s.priority'))!;
    expect(q.text).toContain('ed.email = $');
    expect(q.params).toContain('radhika@trames.sg');
  });

  test('the share dialog payload names no series', async () => {
    const res = await R.shares!.GET!(req('/api/transcripts/m-501/shares'), ctx('m-501'));
    const body = (await res.json()) as { series: unknown; seriesList: unknown[] };
    expect(body.series).toBeNull();
    expect(body.seriesList).toEqual([]);
  });

  test('the listing chip: first CALLER-VISIBLE series only (lateral with the predicate, LIMIT 1)', async () => {
    const { listVisibleToUser } = await import('@/db-ops/transcripts');
    await listVisibleToUser(RADHIKA.userId, RADHIKA.email);
    const q = sql.executed.find((x) => x.text.includes('LEFT JOIN LATERAL ( SELECT sm.series_id'))!;
    expect(q).toBeDefined();
    expect(q.text).toContain('se.owner_email = $');
    expect(q.text).toContain('ed.email = $');
    expect(q.text).toContain('fo.email = $');
    expect(q.text).toContain('ORDER BY se.priority, se.id LIMIT 1');
    expect(q.params).toContain('radhika@trames.sg');
    // The old global join is gone.
    expect(q.text).not.toMatch(/LEFT JOIN "[a-z_]+"\.series_members sm ON sm\.transcript_id = t\.id/);
  });

  test('the meeting detail payload redacts the auto-import provenance of a series they cannot see', async () => {
    const { withVisibleSeriesProvenance } = await import('@/lib/server/series-api');
    const row = {
      gmeet_context: {
        autoImport: { seriesId: 1, seriesTitle: 'AM Briefing: SiQian (secret)', occKey: 'k', byUserId: 'u', byEmail: 'kawen.koh@trames.sg', at: '' },
      },
    };
    const hidden = await withVisibleSeriesProvenance(row as never, RADHIKA);
    expect(JSON.stringify(hidden)).not.toContain('secret');
    expect((hidden as typeof row).gmeet_context.autoImport.seriesId).toBe(0);
    const shown = await withVisibleSeriesProvenance(row as never, JAC);
    expect(JSON.stringify(shown)).toContain('secret');
  });

  test('…and before migration 054 the listing names no series at all', async () => {
    world.ready054 = false;
    const { listVisibleToUser } = await import('@/db-ops/transcripts');
    await listVisibleToUser(RADHIKA.userId, RADHIKA.email);
    const q = sql.executed.find((x) => x.text.includes('AS "__access"') && x.text.includes('series_id'))!;
    expect(q.text).toContain('NULL::int AS series_id');
    expect(q.text).not.toContain('series_members');
  });
});

describe('the people of a series', () => {
  test('the follower sees series 1 (both, actually) in the index and on the meeting — in priority order', async () => {
    currentUser = JAC;
    const idx = (await (await R.index!.GET!(req('/api/series'))).json()) as { series: Array<{ id: number; permissions: { role: string } }> };
    expect(idx.series.map((s) => [s.id, s.permissions.role])).toEqual([
      [1, 'follower'],
      [2, 'follower'],
    ]);
    access = 'read';
    const m = (await (await R.tseries!.GET!(req('/api/transcripts/m-501/series'), ctx('m-501'))).json()) as {
      memberships: Array<{ series_id: number }>;
    };
    expect(m.memberships.map((x) => x.series_id)).toEqual([1, 2]);
  });

  test('a follower cannot edit (403), nor add followers (403), but may unfollow themselves', async () => {
    currentUser = JAC;
    expect((await R.detail!.PATCH!(req('/api/series/1', json({ patterns: [{ kind: 'title', regex: '.*' }] }, 'PATCH')), ctx('1'))).status).toBe(403);
    expect((await R.followers!.POST!(req('/api/series/1/followers', json({ email: 'eli@trames.sg' })), ctx('1'))).status).toBe(403);
    expect((await R.followers!.DELETE!(req('/api/series/1/followers?email=kawen.koh@trames.sg', { method: 'DELETE' }), ctx('1'))).status).toBe(403);
    expect(writes()).toHaveLength(0);
    const self = await R.followers!.DELETE!(req('/api/series/1/followers?email=Jacqueline.Ng@trames.sg', { method: 'DELETE' }), ctx('1'));
    expect(self.status).toBe(200);
  });

  test('an editor edits the definition and adds followers; only the owner deletes', async () => {
    currentUser = SIQIAN;
    expect((await R.detail!.PATCH!(req('/api/series/1', json({ title: 'Renamed' }, 'PATCH')), ctx('1'))).status).toBe(200);
    expect((await R.followers!.POST!(req('/api/series/1/followers', json({ email: 'eli@trames.sg' })), ctx('1'))).status).toBe(200);
    expect((await R.detail!.DELETE!(req('/api/series/1', { method: 'DELETE' }), ctx('1'))).status).toBe(403);
  });

  test('followers must be company addresses', async () => {
    currentUser = KAWEN;
    const res = await R.followers!.POST!(req('/api/series/1/followers', json({ email: 'buyer@danone.com' })), ctx('1'));
    expect(res.status).toBe(400);
  });

  test('an auditor sees every series (oversight) but cannot edit one they do not own/edit', async () => {
    currentUser = IVAN;
    const d = await R.detail!.GET!(req('/api/series/1'), ctx('1'));
    expect(d.status).toBe(200);
    expect(((await d.json()) as { permissions: { role: string } }).permissions.role).toBe('auditor');
    expect((await R.detail!.PATCH!(req('/api/series/1', json({ title: 'x' }, 'PATCH')), ctx('1'))).status).toBe(403);
  });
});

describe('auditor-owned series — nobody hands an auditor reach to a non-auditor', () => {
  test('PRIVACY: the auditor owner adding a NON-auditor editor → 400, nothing written', async () => {
    currentUser = ALOK;
    const res = await R.editors!.POST!(req('/api/series/2/editors', json({ email: 'kawen.koh@trames.sg' })), ctx('2'));
    expect(res.status).toBe(400);
    expect(ran(/INSERT INTO "[a-z_]+"\.series_editors/)).toHaveLength(0);
  });

  test('…an auditor editor is fine', async () => {
    currentUser = ALOK;
    const res = await R.editors!.POST!(req('/api/series/2/editors', json({ email: 'ivan@trames.sg' })), ctx('2'));
    expect(res.status).toBe(200);
    expect(ran(/INSERT INTO "[a-z_]+"\.series_editors/)).toHaveLength(1);
  });

  test('PRIVACY: a NON-auditor (even a left-over editor) adding a non-auditor editor → 403, nothing written', async () => {
    currentUser = ELI;
    const res = await R.editors!.POST!(req('/api/series/2/editors', json({ email: 'jacqueline.ng@trames.sg' })), ctx('2'));
    expect(res.status).toBe(403);
    // …nor may that left-over editor widen the patterns.
    const p = await R.detail!.PATCH!(req('/api/series/2', json({ patterns: [{ kind: 'title', regex: '.*' }] }, 'PATCH')), ctx('2'));
    expect(p.status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  test('PRIVACY: a non-auditor owner cannot transfer their series to an auditor → 403, nothing written', async () => {
    currentUser = KAWEN;
    const res = await R.transfer!.POST!(req('/api/series/1/transfer', json({ email: 'alok@trames.sg' })), ctx('1'));
    expect(res.status).toBe(403);
    expect(ran(/UPDATE "[a-z_]+"\.series\b/)).toHaveLength(0);
  });

  test('…an editor cannot transfer at all; the owner may hand it to a colleague', async () => {
    currentUser = SIQIAN;
    expect((await R.transfer!.POST!(req('/api/series/1/transfer', json({ email: 'eli@trames.sg' })), ctx('1'))).status).toBe(403);
    currentUser = KAWEN;
    const ok = await R.transfer!.POST!(req('/api/series/1/transfer', json({ email: 'eli@trames.sg' })), ctx('1'));
    expect(ok.status).toBe(200);
    const upd = ran(/UPDATE "[a-z_]+"\.series SET owner_user_id/);
    expect(upd).toHaveLength(1);
    expect(upd[0]!.params).toContain('eli@trames.sg');
    // The old owner becomes an editor.
    expect(ran(/INSERT INTO "[a-z_]+"\.series_editors/)[0]!.params).toContain('kawen.koh@trames.sg');
  });
});

describe('preview — within a reach, never org-wide', () => {
  test("a caller's own preview counts within THEIR reach (owner/share predicate on them)", async () => {
    const res = await R.preview!.POST!(req('/api/series/preview', json({ patterns: [{ kind: 'title', regex: 'Juggling' }] })));
    const body = (await res.json()) as { matched: number; visibleToYou: number; reachOf: string };
    expect(body.reachOf).toBe('you');
    expect(typeof body.matched).toBe('number');
    const q = sql.executed.find((x) => x.text.includes('AS visible') && x.text.includes('AS ctx'))!;
    expect(q.text).toMatch(/t\.user_id = \$\d+::uuid OR EXISTS \( SELECT 1 FROM "[a-z_]+"\.transcript_shares rs/);
    expect(q.params).toContain(RADHIKA.userId);
    expect(q.params).toContain('radhika@trames.sg');
  });

  test("an editor previewing their series counts within the OWNER's reach; samples stay caller-openable", async () => {
    currentUser = SIQIAN;
    const res = await R.preview!.POST!(req('/api/series/preview', json({ patterns: [{ kind: 'title', regex: 'Juggling' }], seriesId: 1 })));
    expect(((await res.json()) as { reachOf: string }).reachOf).toBe('owner');
    const q = sql.executed.find((x) => x.text.includes('AS visible') && x.text.includes('AS ctx'))!;
    expect(q.params).toContain(KAWEN.userId);
    expect(q.params).toContain('kawen.koh@trames.sg');
    expect(q.params).toContain(SIQIAN.userId); // the visible flag is still the caller's
  });

  test('a follower asking with seriesId gets their OWN reach, not the owner’s', async () => {
    currentUser = JAC;
    const res = await R.preview!.POST!(req('/api/series/preview', json({ patterns: [{ kind: 'title', regex: 'x' }], seriesId: 1 })));
    expect(((await res.json()) as { reachOf: string }).reachOf).toBe('you');
  });
});

describe('members', () => {
  test('attach needs owner/editor of the SERIES (a follower → 403) and the meeting in the owner’s reach', async () => {
    currentUser = JAC;
    access = 'edit';
    expect((await R.members!.POST!(req('/api/series/1/members', json({ transcriptId: 'm-501' })), ctx('1'))).status).toBe(403);
    // Kawen owns series 1 but cannot open Radhika's meeting (no share) → it is out of reach.
    currentUser = KAWEN;
    access = 'read'; // pretend he can open it via the route…
    // …but the shares list (what reach is judged on) has no share for him and he does not own it.
    const res = await R.members!.POST!(req('/api/series/1/members', json({ transcriptId: 'm-501' })), ctx('1'));
    expect(res.status).toBe(403);
    expect(ran(/INSERT INTO "[a-z_]+"\.series_members/)).toHaveLength(0);
  });

  test('the MEETING owner may take it out of a series they can see (a follower of it)', async () => {
    currentUser = JAC;
    access = 'owner';
    const res = await R.members!.DELETE!(req('/api/series/1/members?transcriptId=m-501&remember=1', { method: 'DELETE' }), ctx('1'));
    expect(res.status).toBe(200);
    const del = ran(/DELETE FROM "[a-z_]+"\.series_members/);
    expect(del[0]!.text).toContain('AND series_id = $');
  });
});
