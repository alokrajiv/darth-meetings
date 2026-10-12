/**
 * The Google switch to darth-auth (plans/connectors/SWITCH-2026-10-12.md):
 * `getServerAccessToken` maps every token-route answer onto a null/token and
 * the right google_accounts mirror status, and the lookup sync upserts linked
 * people, marks the rest not-linked, and touches NOTHING when auth is down.
 * auth is a stubbed global fetch; db-ops are recorded, never run.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type Call = { fn: string; args: unknown[] };
const calls: Call[] = [];
const record =
  (fn: string, ret: unknown = undefined) =>
  async (...args: unknown[]) => {
    calls.push({ fn, args });
    return typeof ret === 'function' ? (ret as (...a: unknown[]) => unknown)(...args) : ret;
  };

mock.module('server-only', () => ({}));
mock.module('@/db-ops/google-accounts', () => ({
  NOT_LINKED_ON_AUTH: 'not linked on auth',
  isNotLinkedOnAuth: (r: { last_error: string | null }) => r.last_error === 'not linked on auth',
  markGoogleAccountStatus: record('markGoogleAccountStatus'),
  upsertGoogleAccountMirror: record('upsertGoogleAccountMirror', (input: { userId: string }) =>
    input.userId === 'u-new'
  ),
  markGoogleAccountsNotLinked: record('markGoogleAccountsNotLinked', 2),
}));

const { getServerAccessToken, invalidateServerToken, connectionsUrl } = await import(
  '@/lib/server/google-oauth'
);
const { syncGoogleAccountsFromAuth, syncOneGoogleAccountFromAuth } = await import(
  '@/lib/server/google-link-sync'
);

const realFetch = globalThis.fetch;
const prevToken = process.env.DARTH_APP_TOKEN;
let requests: { url: string; body: unknown; auth: string | null }[] = [];
let answer: () => Response = () => new Response('{}', { status: 500 });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  requests.push({
    url: String(input),
    body: init?.body ? JSON.parse(String(init.body)) : null,
    auth: headers.get('authorization'),
  });
  return answer();
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevToken === undefined) delete process.env.DARTH_APP_TOKEN;
  else process.env.DARTH_APP_TOKEN = prevToken;
});

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let n = 0;
/** A fresh user id per test — the module caches per user. */
const freshUser = () => `user-${++n}`;

beforeEach(() => {
  process.env.DARTH_APP_TOKEN = 'dapp_test';
  calls.length = 0;
  requests = [];
});

describe('getServerAccessToken via darth-auth', () => {
  test('200 → token served + cached, row marked ok, request shape', async () => {
    const u = freshUser();
    const exp = new Date(Date.now() + 3600_000).toISOString();
    answer = json(200, { token: 'ya29.x', expiresAt: exp, accountLabel: 'a@trames.sg', scopes: 's' });
    const t = await getServerAccessToken(u);
    expect(t).toEqual({ token: 'ya29.x', expiresAt: Date.parse(exp) });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toEndWith('/api/links/google/token');
    expect(requests[0]!.body).toEqual({ userId: u, group: 'calendar' });
    expect(requests[0]!.auth).toBe('Bearer dapp_test');
    expect(calls).toEqual([{ fn: 'markGoogleAccountStatus', args: [u, 'ok', null] }]);
    // cached: no second request
    await getServerAccessToken(u);
    expect(requests).toHaveLength(1);
    invalidateServerToken(u);
    await getServerAccessToken(u);
    expect(requests).toHaveLength(2);
  });

  test.each([
    [404, { error: 'not linked' }, 'not linked on auth'],
    [410, { error: 'link expired', provider: 'google' }, 'darth-auth: link expired'],
    [403, { error: 'group not granted', provider: 'google', group: 'calendar' }, 'darth-auth: group not granted'],
    [403, { error: 'user disabled' }, 'darth-auth: user disabled'],
  ])('%i %o → null, row revoked, remembered for a minute', async (status, body, lastError) => {
    const u = freshUser();
    answer = json(status, body);
    expect(await getServerAccessToken(u)).toBeNull();
    expect(calls).toEqual([{ fn: 'markGoogleAccountStatus', args: [u, 'revoked', lastError] }]);
    expect(await getServerAccessToken(u)).toBeNull();
    expect(requests).toHaveLength(1); // negative cache
    invalidateServerToken(u);
    await getServerAccessToken(u);
    expect(requests).toHaveLength(2);
  });

  test.each([
    [401, { error: 'app token required' }],
    [403, { error: 'app not allowed to fetch this token' }],
    [502, { error: 'the provider did not answer' }],
    [503, { error: 'account links are not configured on auth' }],
  ])('%i → null, row error (transient), not remembered', async (status, body) => {
    const u = freshUser();
    answer = json(status, body);
    expect(await getServerAccessToken(u)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[1]).toBe('error');
    expect(String(calls[0]!.args[2])).toContain(String(status));
    await getServerAccessToken(u);
    expect(requests).toHaveLength(2);
  });

  test('transport failure → null, row error, no token in the message', async () => {
    const u = freshUser();
    answer = () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(await getServerAccessToken(u)).toBeNull();
    expect(calls[0]!.args[1]).toBe('error');
    expect(String(calls[0]!.args[2])).toContain('ECONNREFUSED');
    expect(String(calls[0]!.args[2])).not.toContain('dapp_');
  });

  test('no DARTH_APP_TOKEN → null without calling auth', async () => {
    delete process.env.DARTH_APP_TOKEN;
    const u = freshUser();
    expect(await getServerAccessToken(u)).toBeNull();
    expect(requests).toHaveLength(0);
    expect(calls[0]!.args[1]).toBe('error');
  });

  // LAST in this block: a 429 backs off every user for retryAfterMs.
  test('429 → null, row error, app-wide back-off', async () => {
    const u = freshUser();
    answer = json(429, { error: 'rate limited', retryAfterMs: 30_000 });
    expect(await getServerAccessToken(u)).toBeNull();
    expect(calls[0]!.args[1]).toBe('error');
    expect(await getServerAccessToken(freshUser())).toBeNull();
    expect(requests).toHaveLength(1);
  });
});

describe('google link sync (lookup)', () => {
  test('full pass: upserts linked people, marks the rest, counts', async () => {
    answer = json(200, {
      provider: 'google',
      accounts: {
        'harshil@trames.sg': {
          userId: 'u-new', linked: true, status: 'ok', groups: ['calendar', 'drive'],
          accountLabel: 'harshil@trames.sg', lastOkAt: null,
        },
        'meghana.uppaluri@trames-engineering.com': {
          userId: 'u-eng', linked: true, status: 'revoked', groups: ['calendar'],
          accountLabel: 'meghana.uppaluri@trames-engineering.com', lastError: 'invalid_grant',
        },
      },
    });
    const r = await syncGoogleAccountsFromAuth();
    expect(requests[0]!.url).toEndWith('/api/links/google/lookup');
    expect(requests[0]!.body).toEqual({});
    expect(r).toEqual({ linked: 2, added: 1, marked: 2 });
    const ups = calls.filter((c) => c.fn === 'upsertGoogleAccountMirror').map((c) => c.args[0]);
    expect(ups).toEqual([
      {
        userId: 'u-new', userEmail: 'harshil@trames.sg', googleEmail: 'harshil@trames.sg',
        scopes: 'calendar drive', clientKey: 'sg', status: 'ok', lastError: null,
      },
      {
        userId: 'u-eng', userEmail: 'meghana.uppaluri@trames-engineering.com',
        googleEmail: 'meghana.uppaluri@trames-engineering.com', scopes: 'calendar',
        clientKey: 'eng', status: 'revoked', lastError: 'invalid_grant',
      },
    ]);
    expect(calls.find((c) => c.fn === 'markGoogleAccountsNotLinked')!.args[0]).toEqual(['u-new', 'u-eng']);
  });

  test.each([
    ['auth down', () => { throw new Error('ECONNREFUSED'); }],
    ['403 app not allowed', json(403, { error: 'app not allowed' })],
    ['malformed', json(200, { provider: 'google' })],
  ])('%s → null and NO row touched', async (_name, a) => {
    answer = a as () => Response;
    expect(await syncGoogleAccountsFromAuth()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('one person: linked → upsert; not linked → row revoked; auth down → untouched', async () => {
    answer = json(200, {
      provider: 'google',
      accounts: { 'a@trames.sg': { userId: 'u-a', linked: true, status: 'ok', groups: ['calendar'], accountLabel: 'a@gmail.com' } },
    });
    expect(await syncOneGoogleAccountFromAuth('u-a', 'A@trames.sg')).toBe('linked');
    expect(requests[0]!.body).toEqual({ emails: ['a@trames.sg'] });
    expect(calls[0]!.fn).toBe('upsertGoogleAccountMirror');

    calls.length = 0;
    answer = json(200, { provider: 'google', accounts: { 'a@trames.sg': { userId: 'u-a', linked: false } } });
    expect(await syncOneGoogleAccountFromAuth('u-a', 'a@trames.sg')).toBe('not_linked');
    expect(calls).toEqual([
      { fn: 'markGoogleAccountStatus', args: ['u-a', 'revoked', 'not linked on auth'] },
    ]);

    calls.length = 0;
    answer = () => { throw new Error('down'); };
    expect(await syncOneGoogleAccountFromAuth('u-a', 'a@trames.sg')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

test('connectionsUrl: relative return made absolute on APP_BASE_URL', () => {
  const u = new URL(connectionsUrl('/settings'));
  expect(`${u.origin}${u.pathname}`).toBe('https://auth.darth-internal.trames.io/connections');
  expect(u.searchParams.get('return')).toMatch(/^https?:\/\/[^/]+\/settings$/);
});
