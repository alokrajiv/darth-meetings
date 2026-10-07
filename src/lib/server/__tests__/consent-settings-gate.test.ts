/**
 * Consents (CONTRACT §4, meetings row): the three account-settings write
 * routes — PUT /api/auto-sync, PUT /api/notify-prefs, PUT /api/offline/prefs —
 * need a human-approved `meetings:settings` consent from a darth-cli (dth_)
 * caller, and stay ungated for the web UI (cookie).
 *
 * Over the fake postgres tag (only the modules every route test already
 * replaces are mocked — `mock.module` is process-wide), the same withAuth
 * stand-in the other route tests use (a dth_ caller is the one that carries
 * `cliScope`, exactly as the real withAuth sets it), and a fake `fetch` in the
 * place of darth-auth's `/api/consents/verify`.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from '../../../db-ops/__tests__/helpers/fake-sql';

const sql: FakeSql = createFakeSql((q) => respond(q));
const respond = (q: RenderedQuery): unknown[] => {
  if (/INSERT INTO "[a-z_]+"\.notify_prefs/.test(q.text)) return [{ prefs: {} }];
  if (/INSERT INTO "[a-z_]+"\.user_prefs/.test(q.text) && /RETURNING/.test(q.text)) {
    return [{ user_id: USER.userId, email: USER.email, auto_sync: 'off', auto_sync_providers: {} }];
  }
  return [];
};
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));
mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));

const USER = {
  kind: 'user' as const,
  userId: 'u-consent-1',
  email: 'alok@trames.sg',
  name: 'Alok Rajiv',
  modules: ['meetings'],
  scope: 'readwrite' as const,
};
mock.module('@/lib/auth/with-auth', () => ({
  withAuth:
    (h: (ctx: { user: typeof USER; request: Request; cliScope?: string }, c: unknown) => Promise<Response>) =>
    (request: Request, context: unknown) => {
      const cli = /^Bearer dth_/.test(request.headers.get('authorization') || '');
      return h({ user: USER, request, ...(cli ? { cliScope: USER.scope } : {}) }, context);
    },
}));

const realFetch = globalThis.fetch;
const savedAuthUrl = process.env.DARTH_AUTH_INTERNAL_URL;
process.env.DARTH_AUTH_INTERNAL_URL = 'http://auth.test:8790/';

type Verify = { kind: 'json'; status: number; body: unknown } | { kind: 'throw' };
let verifyAnswer: Verify = { kind: 'json', status: 200, body: { ok: true, consent: { id: 'x', text: 'y' } } };
const verifyCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith('/api/consents/verify')) throw new Error(`unexpected fetch ${url}`);
  verifyCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
  if (verifyAnswer.kind === 'throw') throw new TypeError('fetch failed: ECONNREFUSED');
  return new Response(JSON.stringify(verifyAnswer.body), {
    status: verifyAnswer.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedAuthUrl === undefined) delete process.env.DARTH_AUTH_INTERNAL_URL;
  else process.env.DARTH_AUTH_INTERNAL_URL = savedAuthUrl;
});

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const autoSync = (await import('@/app/api/auto-sync/route')) as unknown as { PUT: Handler };
const notify = (await import('@/app/api/notify-prefs/route')) as unknown as { PUT: Handler };
const offline = (await import('@/app/api/offline/prefs/route')) as unknown as { PUT: Handler };

const ROUTES = [
  { name: 'auto-sync', area: 'auto-sync', put: autoSync.PUT, path: '/api/auto-sync', body: { scope: 'off' }, write: /INSERT INTO "[a-z_]+"\.user_prefs/ },
  { name: 'notify-prefs', area: 'notifications', put: notify.PUT, path: '/api/notify-prefs', body: { prefs: { transcript_ready: false } }, write: /INSERT INTO "[a-z_]+"\.notify_prefs/ },
  { name: 'offline/prefs', area: 'offline prefs', put: offline.PUT, path: '/api/offline/prefs', body: { transcripts: 50 }, write: /INSERT INTO "[a-z_]+"\.user_prefs/ },
] as const;

const ID = 'dcon_abcdefghjkmn';
const TEXT = 'Change my Darth Meetings settings (auto-sync) as Alok asked';

function req(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`https://meetings.test${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const CLI = { authorization: 'Bearer dth_aaaaaaaaaaaaaaaaaaaaaaaa' };
const WITH_CONSENT = { ...CLI, 'x-darth-consent-id': ID, 'x-darth-consent': TEXT, 'x-darth-run': 'run-42' };
const params = { params: Promise.resolve({}) };
const wrote = (re: RegExp) => sql.executed.some((q) => re.test(q.text));

beforeEach(() => {
  sql.executed.length = 0;
  sql.log.length = 0;
  verifyCalls.length = 0;
  verifyAnswer = { kind: 'json', status: 200, body: { ok: true, consent: { id: ID, text: TEXT, expiresAt: '2026-10-07T12:00:00Z', usesLeft: null } } };
});

for (const r of ROUTES) {
  describe(`PUT ${r.path} — meetings:settings gate`, () => {
    test('dth_ caller without the headers → 400 consent_required with the ready request command; nothing written, auth not asked', async () => {
      const res = await r.put(req(r.path, r.body, CLI), params);
      expect(res.status).toBe(400);
      const j = await res.json();
      expect(j.code).toBe('consent_required');
      expect(j.consent.service).toBe('meetings');
      expect(j.consent.action).toBe('settings');
      expect(j.consent.target).toBe('-');
      expect(j.consent.suggestedText).toBe(`Change my Darth Meetings settings (${r.area}) as Alok asked`);
      expect(j.consent.request).toBe(
        `darth-cli consent request --service meetings --action settings --target - --text 'Change my Darth Meetings settings (${r.area}) as Alok asked'`
      );
      expect(verifyCalls.length).toBe(0);
      expect(wrote(r.write)).toBe(false);
    });

    test('an ill-shaped id is the same 400 (never forwarded)', async () => {
      const res = await r.put(req(r.path, r.body, { ...CLI, 'x-darth-consent-id': 'dcon_0000', 'x-darth-consent': TEXT }), params);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('consent_required');
      expect(verifyCalls.length).toBe(0);
    });

    test('auth says ok:false text_mismatch → 409 consent_refused with the approved text; nothing written', async () => {
      verifyAnswer = { kind: 'json', status: 200, body: { ok: false, reason: 'text_mismatch', text: 'Turn auto-sync off as Alok asked' } };
      const res = await r.put(req(r.path, r.body, WITH_CONSENT), params);
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.code).toBe('consent_refused');
      expect(j.reason).toBe('text_mismatch');
      expect(j.text).toBe('Turn auto-sync off as Alok asked');
      expect(j.error).toContain('Turn auto-sync off as Alok asked');
      expect(j.consent.request).toContain('darth-cli consent request --service meetings --action settings --target -');
      expect(wrote(r.write)).toBe(false);
    });

    test('ok:false scope_mismatch carries auth scope', async () => {
      verifyAnswer = { kind: 'json', status: 200, body: { ok: false, reason: 'scope_mismatch', text: 'x', scope: { service: 'gmail', action: 'read', target: 'mailbox' } } };
      const res = await r.put(req(r.path, r.body, WITH_CONSENT), params);
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.scope).toEqual({ service: 'gmail', action: 'read', target: 'mailbox' });
      expect(j.error).toContain('gmail:read');
    });

    test('ok:true → the write goes through; verify got the exact contract body', async () => {
      const res = await r.put(req(r.path, r.body, WITH_CONSENT), params);
      expect(res.status).toBe(200);
      expect(wrote(r.write)).toBe(true);
      expect(verifyCalls.length).toBe(1);
      expect(verifyCalls[0].url).toBe('http://auth.test:8790/api/consents/verify');
      expect(verifyCalls[0].body).toEqual({
        id: ID,
        text: TEXT,
        service: 'meetings',
        action: 'settings',
        target: '-',
        userId: USER.userId,
        run: 'run-42',
      });
    });

    test('darth-auth unreachable → 503 consent_unverifiable (fail closed)', async () => {
      verifyAnswer = { kind: 'throw' };
      const res = await r.put(req(r.path, r.body, WITH_CONSENT), params);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('consent_unverifiable');
      expect(wrote(r.write)).toBe(false);
    });

    test('darth-auth 5xx → 503 as well', async () => {
      verifyAnswer = { kind: 'json', status: 502, body: { error: 'bad gateway' } };
      const res = await r.put(req(r.path, r.body, WITH_CONSENT), params);
      expect(res.status).toBe(503);
      expect(wrote(r.write)).toBe(false);
    });

    test('cookie (web UI) caller is not gated: no headers, no verify, written', async () => {
      const res = await r.put(req(r.path, r.body, {}), params);
      expect(res.status).toBe(200);
      expect(verifyCalls.length).toBe(0);
      expect(wrote(r.write)).toBe(true);
    });
  });
}

describe('consent helper', () => {
  test('a suggested sentence with a quote is shell-quoted in the request command', async () => {
    const { consentBlock } = await import('@/lib/auth/consent');
    const b = consentBlock({ service: 'meetings', action: 'settings', target: '-' }, "Alok's ask");
    expect(b.request).toBe(`darth-cli consent request --service meetings --action settings --target - --text 'Alok'\\''s ask'`);
  });

  test('askerName: first word of the mailbox, capitalised', async () => {
    const { askerName } = await import('@/lib/auth/consent');
    expect(askerName('alok@trames.sg')).toBe('Alok');
    expect(askerName('ivan.tan@trames.sg')).toBe('Ivan');
    expect(askerName('')).toBe('the user');
  });
});
