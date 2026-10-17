/**
 * `/api/transcripts/:id/shares` — the ONE share path behind both the web
 * Share dialog and `darth-cli meetings share` (2026-10-17).
 *
 *   - GET (any access) answers the caller's own `access`, and every share
 *     carries `source` (lib/share-source.ts: origin stamp first, then the
 *     activity log tells a manual share from an import invitee and names a
 *     previous owner) and `shared_by` ({email,name} via the activity log);
 *     a failing provenance lookup never fails the listing.
 *   - POST / DELETE keep the dialog's rule: owner or editor; a reader 403s
 *     and nothing is written.
 *
 * Over the fake postgres tag: the route's own db-ops run against canned rows.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';
import { shareSource } from '@/lib/share-source';

const OWNER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ZED_ID = 'cccccccc-0000-4000-8000-000000000003';
const mk = (userId: string, email: string) => ({
  kind: 'cli' as const,
  userId,
  email,
  name: email.split('@')[0],
  modules: ['meetings'],
  scope: 'readwrite' as const,
});
const OWNER = mk(OWNER_ID, 'alok@trames.sg');
const EDITOR = mk('bbbbbbbb-0000-4000-8000-000000000002', 'bea@trames.sg');
const READER = mk('dddddddd-0000-4000-8000-000000000004', 'rex@trames.sg');

const T = { id: 41, assemblyai_id: 'up-aaa', user_id: OWNER_ID, title: 'Phone call', scratch: false };

const SHARES = [
  { id: 1, transcript_id: 41, shared_with_email: 'eli@trames.sg', access: 'edit', origin: 'event-link', shared_by_user_id: OWNER_ID, shared_at: '2026-10-17T01:00:00Z', updated_at: '2026-10-17T01:00:00Z' },
  { id: 2, transcript_id: 41, shared_with_email: 'ivan@trames.sg', access: 'read', origin: 'auditor-external', shared_by_user_id: OWNER_ID, shared_at: '2026-10-17T01:00:00Z', updated_at: '2026-10-17T01:00:00Z' },
  { id: 3, transcript_id: 41, shared_with_email: 'bea@trames.sg', access: 'edit', origin: null, shared_by_user_id: ZED_ID, shared_at: '2026-10-17T02:00:00Z', updated_at: '2026-10-17T02:00:00Z' },
  { id: 4, transcript_id: 41, shared_with_email: 'rex@trames.sg', access: 'read', origin: null, shared_by_user_id: OWNER_ID, shared_at: '2026-10-17T01:00:00Z', updated_at: '2026-10-17T01:00:00Z' },
  { id: 5, transcript_id: 41, shared_with_email: 'zed@trames.sg', access: 'edit', origin: null, shared_by_user_id: ZED_ID, shared_at: '2026-10-17T03:00:00Z', updated_at: '2026-10-17T03:00:00Z' },
];

let sql: FakeSql;
let currentUser = OWNER;
let provenanceFails = false;
type Route = typeof import('@/app/api/transcripts/[id]/shares/route');
let route: Route;

function respond(q: RenderedQuery): unknown[] {
  const t = q.text;
  if (t.includes('transcripts t') && t.includes('LEFT JOIN')) {
    const email = q.params.find((p) => typeof p === 'string' && p.includes('@'));
    if (currentUser.userId === OWNER_ID) return [{ ...T, __access: 'owner' }];
    const s = SHARES.find((x) => x.shared_with_email === email);
    return s ? [{ ...T, __access: s.access }] : [];
  }
  if (t.includes("action IN ('share_add', 'owner_transfer')")) {
    if (provenanceFails) throw new Error('activity table unreachable');
    return [
      { action: 'share_add', user_email: 'zed@trames.sg', with_email: 'bea@trames.sg' },
      { action: 'owner_transfer', user_email: 'zed@trames.sg', with_email: null },
    ];
  }
  if (t.includes('DISTINCT ON (user_id)') && t.includes('transcript_activity')) {
    return [
      { user_id: OWNER_ID, user_email: 'alok@trames.sg', user_name: 'Alok Rajiv' },
      { user_id: ZED_ID, user_email: 'zed@trames.sg', user_name: 'Zed' },
    ];
  }
  if (t.includes('transcript_activity') && t.includes('LIMIT 1') && t.includes('user_email, user_name')) {
    return [{ user_email: 'alok@trames.sg', user_name: 'Alok Rajiv' }];
  }
  if (/FROM "[a-z_]+"\.transcript_shares WHERE transcript_id = \$1 ORDER BY shared_at/.test(t)) return SHARES;
  if (/DELETE FROM "[a-z_]+"\.transcript_shares/.test(t)) return [{ id: 1 }];
  if (/INSERT INTO "[a-z_]+"\.transcript_shares/.test(t)) {
    return [{ ...SHARES[0], shared_with_email: 'new@trames.sg', origin: null, shared_at: '2026-10-17T05:00:00Z', updated_at: '2026-10-17T05:00:01Z' }];
  }
  return [];
}

beforeAll(async () => {
  delete process.env.DARTH_APP_TOKEN; // no Slack DM from a test
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  mock.module('@/lib/auth/with-auth', () => ({
    withAuth:
      (h: (ctx: { user: typeof OWNER; request: Request }, c: unknown) => Promise<Response>) =>
      (request: Request, context: unknown) =>
        h({ user: currentUser, request }, context),
  }));
  // A module instance of our own (query-suffixed specifier): the route
  // evaluates `withAuth(handler)` once at import, so sharing the plain
  // specifier would hand our withAuth mock to curated-series-privacy.test.ts
  // (which imports the same route) or theirs to us, depending on file order.
  route = (await import(`${import.meta.dir}/../../../app/api/transcripts/[id]/shares/route.ts?shares-route-test`)) as Route;
});

beforeEach(() => {
  currentUser = OWNER;
  provenanceFails = false;
  sql.executed.length = 0;
});

const params = { params: Promise.resolve({ id: 'up-aaa' }) };
const req = (method: string, body?: unknown) =>
  new Request('https://meetings.test/api/transcripts/up-aaa/shares', {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (h: any, r: Request) => h(r, params) as Promise<Response>;
const shareWrites = () => sql.executed.filter((q) => /(INSERT INTO|DELETE FROM|UPDATE) "[a-z_]+"\.transcript_shares/.test(q.text));

describe('GET — who has access, and why', () => {
  test('owner: access + source + shared_by on every share', async () => {
    const res = await call(route.GET, req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access).toBe('owner');
    expect(body.owner).toEqual({ email: 'alok@trames.sg', name: 'Alok Rajiv', isMe: true });
    const by = Object.fromEntries(
      body.shares.map((s: { shared_with_email: string; source: string; shared_by: { email: string } | null }) => [
        s.shared_with_email,
        [s.source, s.shared_by?.email ?? null],
      ])
    );
    // shared_by goes through identitiesForUsers, which meeting-search.test.ts
    // stubs process-wide (mock.module) when it runs first — assert the
    // emails only when OUR fake SQL answered it (as occurrence-join.test.ts).
    const ours = sql.executed.some((q) => q.text.includes('DISTINCT ON (user_id)'));
    const expected: Record<string, [string, string]> = {
      'eli@trames.sg': ['event-link', 'alok@trames.sg'],
      'ivan@trames.sg': ['auditor', 'alok@trames.sg'],
      'bea@trames.sg': ['manual', 'zed@trames.sg'],
      'rex@trames.sg': ['invite', 'alok@trames.sg'],
      'zed@trames.sg': ['previous-owner', 'zed@trames.sg'],
    };
    expect(Object.keys(by).sort()).toEqual(Object.keys(expected).sort());
    for (const [email, [source, sharer]] of Object.entries(expected)) {
      expect(by[email][0]).toBe(source);
      if (ours) expect(by[email][1]).toBe(sharer);
    }
  });

  test('a reader (CLI bearer) gets the same list with access=read', async () => {
    currentUser = READER;
    const body = await (await call(route.GET, req('GET'))).json();
    expect(body.access).toBe('read');
    expect(body.owner.isMe).toBe(false);
    expect(body.shares).toHaveLength(5);
  });

  test('provenance lookup failing → still 200, shares without source', async () => {
    provenanceFails = true;
    const res = await call(route.GET, req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shares).toHaveLength(5);
    expect(body.shares.every((s: { source?: string }) => s.source === undefined)).toBe(true);
  });

  test('no access → 404', async () => {
    currentUser = mk('eeeeeeee-0000-4000-8000-000000000005', 'stranger@trames.sg');
    expect((await call(route.GET, req('GET'))).status).toBe(404);
  });
});

describe('POST / DELETE — owner or editor, as the web dialog', () => {
  test('a reader cannot add or remove; nothing is written', async () => {
    currentUser = READER;
    expect((await call(route.POST, req('POST', { email: 'new@trames.sg', access: 'edit' }))).status).toBe(403);
    expect((await call(route.DELETE, req('DELETE', { email: 'eli@trames.sg' }))).status).toBe(403);
    expect(shareWrites()).toEqual([]);
  });

  test('an editor adds a share → 201, the INSERT ran', async () => {
    currentUser = EDITOR;
    const res = await call(route.POST, req('POST', { email: 'New@Trames.sg', name: 'New', pplId: 3, access: 'read' }));
    expect(res.status).toBe(201);
    const insert = shareWrites().find((q) => q.text.includes('INSERT INTO'));
    expect(insert?.params).toContain('new@trames.sg');
    expect(insert?.params).toContain('read');
  });

  test('the owner removes a share → 200', async () => {
    const res = await call(route.DELETE, req('DELETE', { email: 'eli@trames.sg' }));
    expect(res.status).toBe(200);
    expect(sql.executed.some((q) => /DELETE FROM "[a-z_]+"\.transcript_shares/.test(q.text))).toBe(true);
  });
});

describe('shareSource (pure)', () => {
  const prov = { manual: new Set(['bea@trames.sg']), previousOwners: new Set(['zed@trames.sg']) };
  test('origin stamp wins', () => {
    expect(shareSource({ shared_with_email: 'bea@trames.sg', origin: 'event-link' }, prov)).toBe('event-link');
    expect(shareSource({ shared_with_email: 'x@trames.sg', origin: 'auditor-external' }, prov)).toBe('auditor');
    expect(shareSource({ shared_with_email: 'x@trames.sg', origin: 'series-follow' }, prov)).toBe('series-follow');
  });
  test('no origin: previous owner, then manual (case-insensitive), else invite', () => {
    expect(shareSource({ shared_with_email: 'Zed@trames.sg', origin: null }, prov)).toBe('previous-owner');
    expect(shareSource({ shared_with_email: ' BEA@trames.sg', origin: null }, prov)).toBe('manual');
    expect(shareSource({ shared_with_email: 'rex@trames.sg' }, prov)).toBe('invite');
  });
});
