/**
 * The operator API's gate (lib/auth/with-admin-auth.ts) and the two
 * /api/admin/recorder/* routes behind it: `access` passes (cookie or any-scope
 * dth_ for GET), everyone else signed in gets 404 {error:'Not found'} — the
 * route does not reveal itself — and no credential is a 401.
 *
 * darth-auth introspection is stubbed at `fetch`; the DB is the fake tag.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createFakeSql, type FakeSql, type RenderedQuery } from '@/db-ops/__tests__/helpers/fake-sql';

let respond: (q: RenderedQuery) => unknown[] = () => [];
const sql: FakeSql = createFakeSql((q) => respond(q));
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));
mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
mock.module('@/lib/server/recorder-version', () => ({ latestAppVersion: async () => '0.3.22' }));

// Introspection answers keyed by raw token (each test uses its own token — cli-auth caches 60 s).
const identities = new Map<string, Record<string, unknown>>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/introspect')) {
    const { token } = JSON.parse(String(init?.body ?? '{}')) as { token: string };
    const id = identities.get(token);
    return Response.json(id ? { active: true, ...id } : { active: false });
  }
  return new Response('not stubbed', { status: 599 });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { withAdminAuth } = await import('@/lib/auth/with-admin-auth');
const devicesRoute = await import('@/app/api/admin/recorder/devices/route');
const eventsRoute = await import('@/app/api/admin/recorder/events/route');

let seq = 0;
function token(prefix: 'dss_' | 'dth_', who: Record<string, unknown>): string {
  const t = `${prefix}${'T'.repeat(20)}${++seq}x${Math.random().toString(36).slice(2, 10)}`.replace(/[^A-Za-z0-9_]/g, '');
  identities.set(t, { userId: 'u-' + seq, email: `p${seq}@example.test`, ...who });
  return t;
}
const ADMIN = { kind: 'session', modules: ['access', 'meetings'] };
const ADMIN_ONLY = { kind: 'session', modules: ['access'] };
const MEMBER = { kind: 'session', modules: ['meetings'] };

function req(path: string, opts: { cookie?: string; bearer?: string; method?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = `darth_session=${opts.cookie}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest(`http://127.0.0.1:3002${path}`, { method: opts.method ?? 'GET', headers });
}
const ctx = { params: Promise.resolve({}) };

beforeEach(() => {
  sql.executed.length = 0;
  sql.log.length = 0;
  respond = () => [];
});

describe('withAdminAuth', () => {
  const ok = withAdminAuth(async ({ user }) => Response.json({ email: user.email }));

  test('no credential → 401', async () => {
    const res = await ok(req('/api/admin/x'), ctx);
    expect(res.status).toBe(401);
  });

  test('a session with access passes — with or without the meetings module', async () => {
    for (const who of [ADMIN, ADMIN_ONLY]) {
      const res = await ok(req('/api/admin/x', { cookie: token('dss_', who) }), ctx);
      expect(res.status).toBe(200);
    }
  });

  test('a plain meetings user → 404 {error:"Not found"}, nothing else', async () => {
    const res = await ok(req('/api/admin/x', { cookie: token('dss_', MEMBER) }), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('a read-scope dth_ with access passes for GET, 404 for a write', async () => {
    const t = token('dth_', { kind: 'user', modules: ['access'], scope: 'read' });
    expect((await ok(req('/api/admin/x', { bearer: t }), ctx)).status).toBe(200);
    expect((await ok(req('/api/admin/x', { bearer: t, method: 'POST' }), ctx)).status).toBe(404);
  });

  test('a dth_ without access → 404; an unknown dth_ → 401; an app token → 404', async () => {
    const t = token('dth_', { kind: 'user', modules: ['meetings'], scope: 'admin' });
    expect((await ok(req('/api/admin/x', { bearer: t }), ctx)).status).toBe(404);
    expect((await ok(req('/api/admin/x', { bearer: 'dth_' + 'Z'.repeat(30) }), ctx)).status).toBe(401);
    const app = 'dapp_' + 'A'.repeat(24);
    identities.set(app, { kind: 'app', app: 'tasks' });
    expect((await ok(req('/api/admin/x', { bearer: app }), ctx)).status).toBe(404);
  });
});

describe('GET /api/admin/recorder/devices', () => {
  test('404 for a meetings user — and no query runs', async () => {
    const res = await devicesRoute.GET(req('/api/admin/recorder/devices', { cookie: token('dss_', MEMBER) }), ctx);
    expect(res.status).toBe(404);
    expect(sql.executed).toHaveLength(0);
  });

  test('an admin gets {latest_app_version, server_time, devices[]}', async () => {
    const now = Date.now();
    respond = (q) => {
      if (q.text.includes('recorder_devices d')) {
        return [
          {
            device_id: 'aaaaaaaa-0000-4000-8000-000000000001',
            user_id: 'u1',
            email: 'a@example.test',
            hostname: 'mac-a',
            os: 'macOS',
            app_version: '0.3.21',
            first_seen: new Date(now - 86_400_000),
            last_seen: new Date(now - 60_000),
            last_ip: null,
            last_status: {
              ts: new Date(now - 60_000).toISOString(),
              recording: true,
              recording_id: 'rec-1',
              recording_since: new Date(now - 600_000).toISOString(),
              source: { kind: 'window', title: 'Standup' },
              calls: [{ app: 'Zoom', kind: 'zoom' }],
            },
            last_event_at: new Date(now - 30_000),
            resource_ts: null,
            resource_payload: null,
            life_kind: null,
            life_ts: null,
            life_payload: null,
            unclean_exits_7d: 1,
          },
        ];
      }
      if (q.text.includes('jsonb_to_recordset')) {
        return [
          {
            device_id: 'aaaaaaaa-0000-4000-8000-000000000001',
            recording_id: 'rec-1',
            max_segment: 1,
            closed_segments: 0,
            closed_bytes: null,
            last_progress_at: new Date(now - 30_000),
            latest_source: null,
            call: { app: 'Zoom', kind: 'zoom' },
            row_started_at: null,
          },
        ];
      }
      return [];
    };
    const res = await devicesRoute.GET(req('/api/admin/recorder/devices', { cookie: token('dss_', ADMIN) }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latest_app_version).toBe('0.3.22');
    expect(typeof body.server_time).toBe('string');
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({
      state: 'recording',
      live: true,
      outdated: true,
      unclean_exits_7d: 1,
      recording: { recording_id: 'rec-1', segments: 1, call: { app: 'Zoom' }, source: { kind: 'window', title: 'Standup' } },
    });
    // devices + progress + recent = three queries.
    expect(sql.executed).toHaveLength(3);
  });
});

describe('GET /api/admin/recorder/events', () => {
  test('404 for a meetings user', async () => {
    const res = await eventsRoute.GET(
      req('/api/admin/recorder/events?device_id=aaaaaaaa-0000-4000-8000-000000000001', { cookie: token('dss_', MEMBER) }),
      ctx
    );
    expect(res.status).toBe(404);
  });

  test('400 without a uuid device_id', async () => {
    const res = await eventsRoute.GET(req('/api/admin/recorder/events?device_id=nope', { cookie: token('dss_', ADMIN) }), ctx);
    expect(res.status).toBe(400);
  });

  test('limit is clamped to 200, kinds parsed, payload passed through', async () => {
    respond = () => [
      { id: '7', device_id: 'x', ts: new Date('2026-10-02T05:00:00Z'), kind: 'call_started', payload: { app: 'Zoom' }, received_at: new Date('2026-10-02T05:01:00Z') },
    ];
    const res = await eventsRoute.GET(
      req('/api/admin/recorder/events?device_id=AAAAAAAA-0000-4000-8000-000000000001&limit=5000&kinds=call_started,call_ended', {
        cookie: token('dss_', ADMIN),
      }),
      ctx
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(body.events[0]).toEqual({
      id: '7',
      ts: '2026-10-02T05:00:00.000Z',
      kind: 'call_started',
      payload: { app: 'Zoom' },
      received_at: '2026-10-02T05:01:00.000Z',
    });
    const q = sql.executed[0]!;
    expect(q.params).toContain(200);
    expect(q.params).toContainEqual(['call_started', 'call_ended']);
  });
});
