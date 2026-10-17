/**
 * `darth-cli meetings share` + the "shared with" line of `meetings get`
 * (2026-10-17: an agent made 7 meetings from phone recordings and could
 * neither share them with Ivan nor show who had access).
 *
 *   - no flags = LIST: GET /api/transcripts/:id/shares (+ the transcript for
 *     its title), no write, no write token needed;
 *   - --add resolves the address in the people directory first (the web
 *     dialog's picker, /api/users/search) — an address not in it changes
 *     NOTHING on any meeting and exits 1 with the closest matches;
 *   - a new person → POST {email,name,pplId,access} (default edit, the
 *     dialog's default); an existing share keeps its level unless --access
 *     differs → PATCH; --remove → DELETE {email}; the owner and a not-shared
 *     address are refused locally (exit 1);
 *   - server refusals (reader 403, temporary 409) → exit 1, a 401 → 3;
 *   - several ids = the same change on each, --json = an array;
 *   - usage errors exit 1 before any network hop.
 *
 * cli-subcommand-src/index.ts is built inside darth-cli
 * (src/subcommands/meetings/), so it is copied into a temp tree next to a
 * stand-in `core/args.ts` (the CLI core's parseArgs/str, verbatim — same
 * harness as cli-settings-consent.test.ts) and run against a fake server.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-share-'));
mkdirSync(path.join(tree, 'core'), { recursive: true });
mkdirSync(path.join(tree, 'subcommands', 'meetings'), { recursive: true });
writeFileSync(
  path.join(tree, 'core', 'args.ts'),
  `export function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | boolean> } {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
        else flags[key] = true;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}
export const str = (v: string | boolean | undefined): string | undefined => typeof v === "string" ? v : undefined;
`
);
writeFileSync(path.join(tree, 'core', 'types.ts'), 'export {};\n');
copyFileSync(path.join(repo, 'cli-subcommand-src', 'index.ts'), path.join(tree, 'subcommands', 'meetings', 'index.ts'));

type Sub = { run: (ctx: unknown, argv: string[]) => Promise<number> };
const meetings = ((await import(path.join(tree, 'subcommands', 'meetings', 'index.ts'))) as { default: Sub }).default;

afterAll(() => rmSync(tree, { recursive: true, force: true }));

// ── the fake server ────────────────────────────────────────────────────────

type Share = {
  shared_with_email: string;
  shared_with_name: string | null;
  access: 'edit' | 'read';
  shared_at: string;
  source: string;
  shared_by: { email: string; name: string | null } | null;
};
type Meeting = { title: string; access: 'owner' | 'edit' | 'read'; shares: Share[] };

const DIRECTORY = [
  { id: 7, name: 'Ivan Seow', email: 'ivan@trames.sg', source: 'trames' },
  { id: 9, name: 'Bea Tan', email: 'bea@trames.sg', source: 'trames' },
  { id: 3, name: 'Wei Lin (custom)', email: 'wei@partner.example', source: 'custom' },
];

let db: Record<string, Meeting>;
let calls: Array<{ path: string; method: string; body?: Record<string, unknown> }>;
let failNext: { method: string; status: number; error: string } | null;
let stdout: string[];
let stderr: string[];
let writeRequired: number;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

function share(email: string, access: 'edit' | 'read', source: string, by: string | null = 'alok@trames.sg'): Share {
  return {
    shared_with_email: email,
    shared_with_name: null,
    access,
    shared_at: '2026-10-17T06:00:00.000Z',
    source,
    shared_by: by ? { email: by, name: null } : null,
  };
}

function freshDb(): Record<string, Meeting> {
  return {
    'up-aaa': { title: 'Phone call 1', access: 'owner', shares: [] },
    'up-bbb': { title: 'Phone call 2', access: 'owner', shares: [share('bob@trames.sg', 'edit', 'invite')] },
    'up-ccc': { title: 'Somebody else’s', access: 'read', shares: [share('alok@trames.sg', 'read', 'manual', 'zed@trames.sg')] },
  };
}

function api(_base: string, p: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ path: p, method, body });
  if (failNext && failNext.method === method) {
    const f = failNext;
    failNext = null;
    return Promise.resolve(Response.json({ error: f.error }, { status: f.status }));
  }
  const url = new URL(p, 'https://meetings.test');
  if (url.pathname === '/api/users/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const local = q.split('@')[0];
    return Promise.resolve(Response.json({ people: DIRECTORY.filter((d) => d.email.includes(local) || local.includes(d.email.split('@')[0])) }));
  }
  const m = url.pathname.match(/^\/api\/transcripts\/([^/]+)(\/shares)?$/);
  const row = m ? db[m[1]] : undefined;
  if (!m || !row) return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }));
  const owner = row.access === 'owner' ? 'alok@trames.sg' : 'zed@trames.sg';
  if (!m[2]) {
    return Promise.resolve(
      Response.json({ transcript: { assemblyai_id: m[1], title: row.title, access: row.access, owner_email: owner, status: 'completed', source: 'upload' } })
    );
  }
  if (method === 'GET') {
    return Promise.resolve(Response.json({ shares: row.shares, access: row.access, owner: { email: owner, name: null, isMe: row.access === 'owner' } }));
  }
  if (row.access === 'read') return Promise.resolve(Response.json({ error: 'Only the owner or an editor can share' }, { status: 403 }));
  if (method === 'POST') {
    row.shares.push({ ...share(body.email, body.access, 'manual'), shared_with_name: body.name ?? null });
    return Promise.resolve(Response.json({ share: {} }, { status: 201 }));
  }
  if (method === 'PATCH') {
    const s = row.shares.find((x) => x.shared_with_email === body.email)!;
    s.access = body.access;
    return Promise.resolve(Response.json({ share: s }));
  }
  if (method === 'DELETE') {
    row.shares = row.shares.filter((x) => x.shared_with_email !== body.email);
    return Promise.resolve(Response.json({ ok: true }));
  }
  return Promise.resolve(Response.json({ error: 'bad' }, { status: 400 }));
}

function ctx(json = false) {
  return {
    config: { email: 'alok@trames.sg', meetingsUrl: 'https://meetings.test', timezone: 'Asia/Singapore' },
    flags: {},
    json,
    consent: null,
    api,
    expectJson: async (res: Promise<Response> | Response) => {
      const r = await res;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    requireWrite: () => {
      writeRequired++;
    },
    requireAdmin: () => {},
    print: (data: unknown, human: () => void) => (json ? console.log(JSON.stringify(data)) : human()),
  };
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const out = () => stdout.join('\n');
const err = () => stderr.join('\n');
const run = (argv: string[], json = false) => meetings.run(ctx(json), ['share', ...argv]);

beforeEach(() => {
  db = freshDb();
  calls = [];
  failNext = null;
  stdout = [];
  stderr = [];
  writeRequired = 0;
  logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(' '));
  });
  errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// ── listing ────────────────────────────────────────────────────────────────

describe('share <id> (list)', () => {
  test('lists owner + shares with why/when/by, writes nothing, needs no write token', async () => {
    db['up-bbb'].shares.push(share('ivan@trames.sg', 'read', 'auditor', null));
    expect(await run(['up-bbb'])).toBe(0);
    expect(writes()).toEqual([]);
    expect(writeRequired).toBe(0);
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/transcripts/up-bbb', '/api/transcripts/up-bbb/shares']);
    expect(out()).toContain('up-bbb  "Phone call 2"');
    expect(out()).toContain('owner  alok@trames.sg  ← you');
    expect(out()).toContain('edit   bob@trames.sg  — calendar invite (import) · added 2026-10-17 14:00 by alok@trames.sg');
    expect(out()).toContain('read   ivan@trames.sg  — auditor (outside party on the invite) · added 2026-10-17 14:00');
  });

  test('nobody else', async () => {
    expect(await run(['up-aaa'])).toBe(0);
    expect(out()).toContain('shared with nobody else');
  });

  test('a reader sees the list and is told only owner/editors can change it', async () => {
    expect(await run(['up-ccc'])).toBe(0);
    expect(out()).toContain('owner  zed@trames.sg');
    expect(out()).toContain('read   alok@trames.sg  ← you  — shared by hand');
    expect(out()).toContain('you have read access');
  });

  test('--json: one object with owner, your_access, shared_with', async () => {
    expect(await run(['up-bbb'], true)).toBe(0);
    const v = JSON.parse(out());
    expect(v.id).toBe('up-bbb');
    expect(v.title).toBe('Phone call 2');
    expect(v.url).toBe('https://meetings.test/transcript/up-bbb');
    expect(v.your_access).toBe('owner');
    expect(v.owner.email).toBe('alok@trames.sg');
    expect(v.shared_with).toEqual([
      { email: 'bob@trames.sg', name: null, access: 'edit', source: 'invite', shared_at: '2026-10-17T06:00:00.000Z', shared_by: 'alok@trames.sg' },
    ]);
    expect(v.changes).toBeUndefined();
  });

  test('a meeting you cannot open → exit 1, a recording id gets the hint', async () => {
    expect(await run(['up-nope'])).toBe(1);
    expect(err()).toContain('No meeting up-nope visible to you');
    stderr = [];
    expect(await run(['rec-1234'])).toBe(1);
    expect(err()).toContain('recordings are never shared');
  });

  test('401 → exit 3', async () => {
    failNext = { method: 'GET', status: 401, error: 'Unauthorized - invalid or revoked darth token' };
    expect(await run(['up-aaa'])).toBe(3);
  });
});

// ── changes ────────────────────────────────────────────────────────────────

describe('share <id> --add / --remove', () => {
  test('--add a directory person → POST with name + pplId at edit, Slack-DM note, fresh list', async () => {
    expect(await run(['up-aaa', '--add', 'Ivan@Trames.sg'])).toBe(0);
    expect(writeRequired).toBe(1);
    expect(calls[0].path).toBe('/api/users/search?q=ivan%40trames.sg&limit=10');
    expect(writes()).toEqual([
      { path: '/api/transcripts/up-aaa/shares', method: 'POST', body: { email: 'ivan@trames.sg', name: 'Ivan Seow', pplId: 7, access: 'edit' } },
    ]);
    expect(out()).toContain('+ shared with ivan@trames.sg (edit) — they get a Slack DM');
    expect(out()).toContain('edit   ivan@trames.sg (Ivan Seow)  — shared by hand');
  });

  test('--access read; a custom-directory person carries no pplId', async () => {
    expect(await run(['up-aaa', '--add', 'wei@partner.example', '--access', 'read'])).toBe(0);
    expect(writes()[0].body).toEqual({ email: 'wei@partner.example', name: 'Wei Lin (custom)', access: 'read' });
  });

  test('an address not in the directory → exit 1, nothing written anywhere, did-you-mean', async () => {
    expect(await run(['up-aaa', 'up-bbb', '--add', 'ivan@trames.sg', '--add', 'van@trames.sg'])).toBe(1);
    expect(writes()).toEqual([]);
    expect(calls.some((c) => c.path.startsWith('/api/transcripts'))).toBe(false);
    expect(err()).toContain('van@trames.sg is not in the Trames people directory');
    expect(err()).toContain('Did you mean: ivan@trames.sg (Ivan Seow)');
  });

  test('already shared: no write without --access; --access different → PATCH', async () => {
    expect(await run(['up-bbb', '--add', 'bob@trames.sg'])).toBe(1); // bob is not in the directory
    db['up-bbb'].shares = [share('ivan@trames.sg', 'edit', 'invite')];
    calls = [];
    stdout = [];
    expect(await run(['up-bbb', '--add', 'ivan@trames.sg'])).toBe(0);
    expect(writes()).toEqual([]);
    expect(out()).toContain('= ivan@trames.sg already has edit access (--access edit|read changes the level)');
    calls = [];
    stdout = [];
    expect(await run(['up-bbb', '--add', 'ivan@trames.sg', '--access', 'read'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/up-bbb/shares', method: 'PATCH', body: { email: 'ivan@trames.sg', access: 'read' } }]);
    expect(out()).toContain('~ ivan@trames.sg now has read access');
  });

  test('adding the owner is a no-op, not an error', async () => {
    db['up-aaa'].shares = [];
    const dirHasAlok = DIRECTORY.push({ id: 1, name: 'Alok Rajiv', email: 'alok@trames.sg', source: 'trames' });
    try {
      expect(await run(['up-aaa', '--add', 'alok@trames.sg'])).toBe(0);
      expect(writes()).toEqual([]);
      expect(out()).toContain('= alok@trames.sg is the owner');
    } finally {
      DIRECTORY.splice(dirHasAlok - 1, 1);
    }
  });

  test('--remove a share → DELETE {email}', async () => {
    expect(await run(['up-bbb', '--remove', 'bob@trames.sg'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/up-bbb/shares', method: 'DELETE', body: { email: 'bob@trames.sg' } }]);
    expect(out()).toContain('- removed bob@trames.sg');
    expect(out()).toContain('shared with nobody else');
  });

  test('--remove someone it is not shared with, or the owner → refused, exit 1, no DELETE', async () => {
    expect(await run(['up-bbb', '--remove', 'nobody@trames.sg'])).toBe(1);
    expect(err()).toContain('not shared with them');
    expect(await run(['up-bbb', '--remove', 'alok@trames.sg'])).toBe(1);
    expect(err()).toContain('that is the owner');
    expect(writes()).toEqual([]);
  });

  test('a reader is refused by the server → exit 1 with its message', async () => {
    expect(await run(['up-ccc', '--add', 'ivan@trames.sg'])).toBe(1);
    expect(err()).toContain('up-ccc: add ivan@trames.sg refused — Only the owner or an editor can share');
  });

  test('a temporary row (409) → exit 1 with the server text; a 401 on a write → 3', async () => {
    failNext = { method: 'POST', status: 409, error: 'A temporary recording cannot be shared — only meetings can.' };
    expect(await run(['up-aaa', '--add', 'ivan@trames.sg'])).toBe(1);
    expect(err()).toContain('A temporary recording cannot be shared');
    failNext = { method: 'POST', status: 401, error: 'Unauthorized' };
    expect(await run(['up-aaa', '--add', 'bea@trames.sg'])).toBe(3);
  });

  test('several ids: the same change on each, --json = array with changes', async () => {
    expect(await run(['up-aaa,up-bbb', '--add', 'ivan@trames.sg', '--remove', 'bob@trames.sg'], true)).toBe(1); // up-aaa has no bob
    const v = JSON.parse(out());
    expect(Array.isArray(v)).toBe(true);
    expect(v.map((x: { id: string }) => x.id)).toEqual(['up-aaa', 'up-bbb']);
    expect(v[0].changes).toEqual([
      { op: 'remove', email: 'bob@trames.sg', result: 'refused', error: 'the meeting is not shared with them, nothing to remove' },
      { op: 'add', email: 'ivan@trames.sg', result: 'added', access: 'edit' },
    ]);
    expect(v[1].changes.map((c: { result: string }) => c.result)).toEqual(['removed', 'added']);
    expect(v[1].shared_with.map((s: { email: string }) => s.email)).toEqual(['ivan@trames.sg']);
  });
});

// ── usage ──────────────────────────────────────────────────────────────────

describe('share usage errors (exit 1, no network)', () => {
  const cases: Array<[string, string[], string]> = [
    ['no id', [], 'usage: darth-cli meetings share'],
    ['bare --add', ['up-aaa', '--add'], '--add / --remove need an email'],
    ['bad --access', ['up-aaa', '--add', 'ivan@trames.sg', '--access', 'owner'], '--access must be edit or read'],
    ['--access alone', ['up-aaa', '--access', 'read'], '--access goes with --add'],
    ['not an email', ['up-aaa', '--add', 'ivan'], 'not an email address: ivan'],
    ['add + remove same', ['up-aaa', '--add', 'ivan@trames.sg', '--remove', 'IVAN@trames.sg'], 'both --add and --remove'],
  ];
  for (const [name, argv, msg] of cases) {
    test(name, async () => {
      expect(await run(argv)).toBe(1);
      expect(err()).toContain(msg);
      expect(calls).toEqual([]);
    });
  }
});

// ── get ────────────────────────────────────────────────────────────────────

describe('get <id> carries who it is shared with', () => {
  test('human: owner + shared with line', async () => {
    db['up-bbb'].shares.push(share('ivan@trames.sg', 'read', 'manual'));
    expect(await meetings.run(ctx(), ['get', 'up-bbb'])).toBe(0);
    expect(out()).toContain('owner:       alok@trames.sg');
    expect(out()).toContain(
      "shared with: bob@trames.sg (edit, calendar invite (import)), ivan@trames.sg (read)  — details: 'darth-cli meetings share up-bbb'"
    );
  });

  test('--json: shared_with[] next to the transcript fields', async () => {
    expect(await meetings.run(ctx(true), ['get', 'up-aaa'])).toBe(0);
    const t = JSON.parse(out());
    expect(t.assemblyai_id).toBe('up-aaa');
    expect(t.shared_with).toEqual([]);
  });

  test('a failing share listing never fails get', async () => {
    const orig = db['up-aaa'];
    // The shares GET fails, the transcript GET does not.
    const spy = (p: string) => p.endsWith('/shares');
    const realApi = api;
    const c = ctx();
    c.api = (b: string, p: string, i?: RequestInit) =>
      spy(p) ? Promise.resolve(Response.json({ error: 'boom' }, { status: 500 })) : realApi(b, p, i);
    expect(await meetings.run(c, ['get', 'up-aaa'])).toBe(0);
    expect(out()).toContain('shared with: (could not read: boom)');
    expect(orig.title).toBe('Phone call 1');
  });
});
