/**
 * Curated series — the privacy gate at the ROUTES (docs/curated-series-spec.md
 * §6; .agent-memory feedback_privacy_caller_scoping_gate: "whose rows can
 * reach this response?"). Following grants read access to other people's
 * meetings, so:
 *
 *   - a non-auditor cannot add followers (not even themselves);
 *   - a non-auditor cannot change the patterns of a FOLLOWED series, but may
 *     edit an unfollowed one;
 *   - a follower may remove themselves (and nobody else);
 *   - series detail lists only meetings the caller owns or holds a share on;
 *   - the preview's global count is a number — every meeting it names is
 *     the caller's own or shared;
 *   - DELETE /api/series/:id/members is scoped to :id, and attaching or
 *     detaching needs owner/edit access to the meeting.
 *
 * Driven as a low-involvement caller (jacqueline-style), over the fake
 * postgres tag.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';

const JAC = { userId: '19679081-a63f-4058-8ea4-dc5705744c75', email: 'Jacqueline.Ng@trames.sg' };
const ALOK = { userId: 'bf547379-4c7e-4e17-932e-0246e50bfe54', email: 'alok@trames.sg' };
let currentUser: { userId: string; email: string } = JAC;

let sql: FakeSql;
interface World {
  followers: Record<number, string[]>;
  membershipSeries: number | null;
  access: 'owner' | 'edit' | 'read';
  previewRows: Array<{ id: number; assemblyai_id: string; title: string; visible: boolean }>;
}
let world: World;

const SERIES = (id: number) => ({
  id,
  title: id === 1 ? 'AM Briefing: Jacq' : 'Data scrum',
  created_by: 'creator-id',
  notes: null,
  description: null,
  patterns: [{ kind: 'title', regex: id === 1 ? '^AI AM$' : '^Data scrum' }],
  priority: 100,
  auto_import: null,
  created_at: '',
  updated_at: '',
});

function respond(q: RenderedQuery): unknown[] {
  const t = q.text;
  if (t.includes('information_schema')) {
    if (t.includes('AS ledger_origin')) return [{ patterns: 1, followers: 1, ledger_origin: 1 }];
    return [{ n: 1 }];
  }
  if (/SELECT \* FROM "[a-z_]+"\.series WHERE id = \$1/.test(t)) {
    const id = q.params[0] as number;
    return id === 1 || id === 2 ? [SERIES(id)] : [];
  }
  if (/SELECT DISTINCT series_id FROM "[a-z_]+"\.series_followers/.test(t)) {
    return Object.entries(world.followers)
      .filter(([, emails]) => emails.length > 0)
      .map(([id]) => ({ series_id: Number(id) }));
  }
  if (/FROM "[a-z_]+"\.series_followers/.test(t) && t.startsWith('SELECT')) {
    const ids = q.params[0] as number[];
    return ids.flatMap((id) =>
      (world.followers[id] ?? []).map((email) => ({
        series_id: id,
        email,
        name: null,
        added_by_email: 'alok@trames.sg',
        added_at: '',
      }))
    );
  }
  if (/DELETE FROM "[a-z_]+"\.series_followers/.test(t)) {
    const [id, email] = q.params as [number, string];
    return (world.followers[id] ?? []).includes(email) ? [{ email }] : [];
  }
  if (t.includes('AS "__access"')) {
    return [
      {
        id: 501,
        user_id: world.access === 'owner' ? JAC.userId : 'someone-else',
        assemblyai_id: 'm-501',
        title: 'AI AM',
        gmeet_context: null,
        __access: world.access,
      },
    ];
  }
  if (/SELECT m\.series_id, s\.title, m\.how/.test(t)) {
    return world.membershipSeries ? [{ series_id: world.membershipSeries, title: 'x', how: 'auto' }] : [];
  }
  if (/DELETE FROM "[a-z_]+"\.series_members/.test(t)) return [{ id: 1 }];
  if (t.includes('AS visible') && t.includes('jsonb_build_object')) {
    return world.previewRows.map((r) => ({
      ...r,
      user_id: 'u',
      scratch: false,
      deleted: false,
      ctx: null,
      series_id: null,
      how: null,
      excluded: null,
      at: `2026-10-0${r.id % 9}T00:00:00Z`,
    }));
  }
  return [];
}

const ran = (re: RegExp) => sql.executed.filter((q) => re.test(q.text));
const req = (url: string, init?: RequestInit) => new Request(`http://x${url}`, init);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function resetCaches() {
  const g = globalThis as Record<string, unknown>;
  g.__mwCuratedSeries053 = undefined;
  g.__mwCuratedSeriesCache = undefined;
  g.__mwAuditorLedger = undefined;
  g.__mwShareOriginColumn = undefined;
}

type Route = Record<string, (r: Request, c?: unknown) => Promise<Response>>;
let followers: Route;
let detail: Route;
let members: Route;
let preview: Route;

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  mock.module('@/lib/auth/with-auth', () => ({
    withAuth:
      (h: (c: { user: typeof JAC; request: Request }, x: unknown) => Promise<Response>) =>
      (request: Request, context: unknown) =>
        h({ user: currentUser, request }, context),
  }));
  followers = (await import('@/app/api/series/[id]/followers/route')) as unknown as Route;
  detail = (await import('@/app/api/series/[id]/route')) as unknown as Route;
  members = (await import('@/app/api/series/[id]/members/route')) as unknown as Route;
  preview = (await import('@/app/api/series/preview/route')) as unknown as Route;
});

beforeEach(() => {
  currentUser = JAC;
  world = { followers: { 1: ['alok@trames.sg'] }, membershipSeries: 1, access: 'owner', previewRows: [] };
  sql.executed.length = 0;
  sql.log.length = 0;
  resetCaches();
});

afterAll(() => resetCaches());

describe('followers', () => {
  test('a non-auditor cannot add a follower — not even themselves', async () => {
    const res = await followers.POST!(req('/api/series/1/followers', json({ email: JAC.email })), ctx('1'));
    expect(res.status).toBe(403);
    expect(ran(/INSERT INTO "[a-z_]+"\.series_followers/)).toHaveLength(0);
    expect(ran(/transcript_shares/)).toHaveLength(0);
  });

  test('an auditor can', async () => {
    currentUser = ALOK;
    const res = await followers.POST!(req('/api/series/1/followers', json({ email: 'Ivan@trames.sg' })), ctx('1'));
    expect(res.status).toBe(200);
    const ins = ran(/INSERT INTO "[a-z_]+"\.series_followers/);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.params).toContain('ivan@trames.sg');
  });

  test('a follower may remove themselves, but nobody else', async () => {
    world.followers[1] = ['alok@trames.sg', 'jacqueline.ng@trames.sg'];
    const other = await followers.DELETE!(
      req('/api/series/1/followers?email=alok@trames.sg', { method: 'DELETE' }),
      ctx('1')
    );
    expect(other.status).toBe(403);
    expect(ran(/DELETE FROM "[a-z_]+"\.series_followers/)).toHaveLength(0);

    const self = await followers.DELETE!(
      req('/api/series/1/followers?email=Jacqueline.Ng@trames.sg', { method: 'DELETE' }),
      ctx('1')
    );
    expect(self.status).toBe(200);
    expect(ran(/DELETE FROM "[a-z_]+"\.series_followers/)[0]!.params).toEqual([1, 'jacqueline.ng@trames.sg']);
  });
});

describe('editing the matching', () => {
  const widen = { patterns: [{ kind: 'title', regex: '.*' }] };

  test('a non-auditor cannot change the patterns of a followed series', async () => {
    const res = await detail.PATCH!(req('/api/series/1', { ...json(widen), method: 'PATCH' }), ctx('1'));
    expect(res.status).toBe(403);
    expect(ran(/UPDATE "[a-z_]+"\.series/)).toHaveLength(0);
  });

  test('…nor its priority', async () => {
    const res = await detail.PATCH!(req('/api/series/1', { ...json({ priority: 1 }), method: 'PATCH' }), ctx('1'));
    expect(res.status).toBe(403);
  });

  test('…but CAN edit an unfollowed one (and its name on a followed one)', async () => {
    const res = await detail.PATCH!(req('/api/series/2', { ...json(widen), method: 'PATCH' }), ctx('2'));
    expect(res.status).toBe(200);
    const upd = ran(/UPDATE "[a-z_]+"\.series SET patterns/);
    expect(upd).toHaveLength(1);

    const rename = await detail.PATCH!(
      req('/api/series/1', { ...json({ title: 'AM Briefing: Jacqueline' }), method: 'PATCH' }),
      ctx('1')
    );
    expect(rename.status).toBe(200);
  });
});

describe('what a caller sees', () => {
  test('series detail lists only meetings the caller owns or holds a share on', async () => {
    const res = await detail.GET!(req('/api/series/1'), ctx('1'));
    expect(res.status).toBe(200);
    const q = sql.executed.find((x) => x.text.includes('AS owner_is_caller'))!;
    expect(q.text).toContain('AND (t.user_id = $');
    expect(q.text).toContain('OR sh.id IS NOT NULL)');
    expect(q.text).toContain('t.deleted_at IS NULL');
    expect(q.params).toContain(JAC.userId);
    expect(q.params).toContain('jacqueline.ng@trames.sg');
    const body = (await res.json()) as { followers: Array<{ email: string }>; permissions: { editMatching: boolean } };
    // Everyone sees who follows — and is told they cannot change the matching.
    expect(body.followers.map((f) => f.email)).toEqual(['alok@trames.sg']);
    expect(body.permissions.editMatching).toBe(false);
  });

  test('preview: a non-auditor gets NO org-wide count (a regex + count is an oracle); only their meetings are named', async () => {
    world.previewRows = [
      { id: 1, assemblyai_id: 'mine-1', title: 'AI AM', visible: true },
      { id: 2, assemblyai_id: 'theirs-2', title: 'AI AM', visible: false },
      { id: 3, assemblyai_id: 'theirs-3', title: 'AI AM', visible: false },
      { id: 4, assemblyai_id: 'shared-4', title: 'AI AM', visible: true },
      { id: 5, assemblyai_id: 'other-5', title: 'Lunch', visible: true },
    ];
    const res = await preview.POST!(
      req('/api/series/preview', json({ patterns: [{ kind: 'title', regex: '^AI AM$' }] }))
    );
    const body = (await res.json()) as {
      matched: number | null;
      visibleToYou: number;
      sample: Array<{ assemblyai_id: string }>;
    };
    expect(body.matched).toBeNull();
    expect(body.visibleToYou).toBe(2);
    expect(body.sample.map((s) => s.assemblyai_id).sort()).toEqual(['mine-1', 'shared-4']);
    expect(JSON.stringify(body)).not.toContain('theirs');
    // The visibility flag is computed for THIS caller.
    const q = sql.executed.find((x) => x.text.includes('AS visible'))!;
    expect(q.params).toContain(JAC.userId);
    expect(q.params).toContain('jacqueline.ng@trames.sg');
  });

  test('preview: an auditor gets the org-wide count (still only their own meetings named)', async () => {
    currentUser = ALOK;
    world.previewRows = [
      { id: 1, assemblyai_id: 'mine-1', title: 'AI AM', visible: true },
      { id: 2, assemblyai_id: 'theirs-2', title: 'AI AM', visible: false },
    ];
    const res = await preview.POST!(
      req('/api/series/preview', json({ patterns: [{ kind: 'title', regex: '^AI AM$' }] }))
    );
    const body = (await res.json()) as { matched: number | null; sample: Array<{ assemblyai_id: string }> };
    expect(body.matched).toBe(2);
    expect(JSON.stringify(body)).not.toContain('theirs');
  });
});

describe('members', () => {
  test('DELETE is scoped to :id — a meeting in ANOTHER series is not detached', async () => {
    world.membershipSeries = 2;
    const res = await members.DELETE!(
      req('/api/series/1/members?transcriptId=m-501', { method: 'DELETE' }),
      ctx('1')
    );
    expect(res.status).toBe(404);
    expect(ran(/DELETE FROM "[a-z_]+"\.series_members/)).toHaveLength(0);
  });

  test('DELETE in the right series detaches it there and only there', async () => {
    const res = await members.DELETE!(
      req('/api/series/1/members?transcriptId=m-501&remember=1', { method: 'DELETE' }),
      ctx('1')
    );
    expect(res.status).toBe(200);
    const del = ran(/DELETE FROM "[a-z_]+"\.series_members/);
    expect(del[0]!.text).toContain('AND series_id = $');
    expect(del[0]!.params).toEqual([501, 1]);
    expect(ran(/INSERT INTO "[a-z_]+"\.series_exclusions/)).toHaveLength(1);
  });

  test('a read-only sharer can neither attach nor detach', async () => {
    world.access = 'read';
    const post = await members.POST!(req('/api/series/1/members', json({ transcriptId: 'm-501' })), ctx('1'));
    expect(post.status).toBe(403);
    const del = await members.DELETE!(
      req('/api/series/1/members?transcriptId=m-501', { method: 'DELETE' }),
      ctx('1')
    );
    expect(del.status).toBe(403);
    expect(ran(/series_members/).filter((q) => /INSERT|DELETE/.test(q.text))).toHaveLength(0);
  });
});
