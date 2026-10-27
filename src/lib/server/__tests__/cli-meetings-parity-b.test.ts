/**
 * CLI ↔ UI parity, batch B (task 05): recordings dismiss, label-color,
 * calendar hidden / hide / unhide / check, reminders (+ dismiss / mute),
 * series occurrences, vocab (+ --set behind the meetings:settings consent).
 *
 * Same harness as cli-meetings-parity-a.test.ts: the subcommand source copied
 * into a temp tree beside a stand-in `core/args.ts`, run against a fake server
 * that answers like the real routes (success, 403, 404, the route's own
 * 4xx/409) and records every request. All data is invented.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-parity-b-'));
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
type Vocab = { keyterms_prompt: string[]; custom_spelling: Array<{ to: string; from: string[] }> };
type ParityB = {
  parseLabelColor: (raw: string) => string | null | undefined;
  parseEventKey: (raw: string) => { head: string; startMs: number } | null;
  evidenceRequest: (row: Record<string, unknown>, teams: boolean) => { path: string; body: Record<string, unknown> } | { error: string };
  evidenceLines: (teams: boolean, d: Record<string, unknown>, ref: string, tz: string) => { lines: string[]; code: number };
  parseVocabSource: (text: string) => { ok: true; vocab: Vocab } | { ok: false; error: string };
  vocabLines: (v: Vocab) => string[];
  occurrenceStatus: (o: Record<string, unknown>) => string;
  reminderKindWords: (r: Record<string, unknown>) => string;
};
const mod = (await import(path.join(tree, 'subcommands', 'meetings', 'index.ts'))) as { default: Sub; PARITY_B: ParityB };
const meetings = mod.default;
const P = mod.PARITY_B;

afterAll(() => rmSync(tree, { recursive: true, force: true }));

// ── the fake server ────────────────────────────────────────────────────────

type Call = { path: string; method: string; body?: Record<string, unknown> };
type Mute = { kind: string; value: string; title: string | null; createdAt: string };
type Reminder = { id: number; kind: string; meetingCode: string | null; title: string | null; eventStart: string | null; hasRecording?: boolean; hasTranscript?: boolean };

const EVENTS = [
  { key: 'evt1|2026-10-20T10:00:00+08:00', eventId: 'evt1', recurringEventId: 'rec1', title: 'Meeting X', start: '2026-10-20T02:00:00.000Z', end: '2026-10-20T03:00:00.000Z', meetingCode: 'abc-defg-hij', provider: 'gmeet', organizerEmail: 'test-a@example.com', muted: false },
  { key: 'evt2|2026-10-20T14:00:00+08:00', eventId: 'evt2', recurringEventId: null, title: 'Meeting Y', start: '2026-10-20T06:00:00.000Z', end: '2026-10-20T06:30:00.000Z', meetingCode: 'teams-0123456789ab', provider: 'teams', organizerEmail: 'test-b@example.com', muted: false },
  { key: 'evt3|2026-10-20T16:00:00+08:00', eventId: 'evt3', recurringEventId: null, title: 'Lunch', start: '2026-10-20T08:00:00.000Z', end: null, meetingCode: null, provider: null, organizerEmail: null, muted: false },
];
const LABELS = [
  { id: 3, parent_id: null, name: 'Customers', path: 'Customers', path_key: 'customers', depth: 0, color: null, description: null, created_by_email: 'test-a@example.com' },
  { id: 4, parent_id: 3, name: 'Org X', path: 'Customers/Org X', path_key: 'customers/org x', depth: 1, color: '#112233', description: null, created_by_email: 'test-a@example.com' },
];

let calls: Call[];
let stdout: string[];
let stderr: string[];
let mutes: Mute[];
let reminders: Reminder[];
let vocab: { user: Vocab; org: Vocab; orgVersion: number };
let server: { labelGone?: boolean; readOnly: boolean; noAccess: boolean; googleConnected: boolean; meetCheckFailed: boolean; teamsExternal: boolean };
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

class Exit extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const notFound = (msg = 'Not found') => json({ error: msg }, 404);

async function api(_base: string, p: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const call: Call = { path: p, method };
  if (typeof init?.body === 'string') call.body = JSON.parse(init.body) as Record<string, unknown>;
  calls.push(call);
  if (server.noAccess) return json({ error: 'Forbidden - no Darth Meetings access' }, 403);
  if (server.readOnly && method !== 'GET') return json({ error: 'Forbidden - token is read-only for meetings; re-run `darth-cli login` and pick Read + write' }, 403);
  const url = new URL(p, 'https://meetings.test');
  const body = call.body ?? {};
  const pn = url.pathname;

  const rec = pn.match(/^\/api\/recordings\/([^/]+)$/);
  if (rec) {
    if (rec[1] !== 'r-own' && rec[1] !== 'r-two') return notFound();
    if (method === 'PATCH') {
      if (body.dismissSuggestedEvent !== true) return json({ error: 'Nothing to change (keep, title, dismissSuggestedEvent)' }, 400);
      const next = rec[1] === 'r-two' ? { title: 'Meeting Y', startIso: '2026-10-21T06:00:00.000Z', key: 'evt9|x' } : null;
      return json({ recording: { id: rec[1], status: 'ready', suggested_event: next } });
    }
  }
  if (pn === '/api/labels' && method === 'GET') return json({ labels: LABELS });
  const lab = pn.match(/^\/api\/labels\/(\d+)$/);
  if (lab && method === 'PATCH') {
    const row = LABELS.find((l) => l.id === Number(lab[1]));
    if (!row || server.labelGone) return json({ error: 'Label not found' }, 404);
    return json({ label: { ...row, color: body.color }, updated: [{ id: row.id, path: row.path }] });
  }
  if (pn === '/api/calendar/events') return json({ range: {}, events: EVENTS, counts: {}, truncated: false, connected: true });
  if (pn === '/api/calendar-mutes') {
    if (method === 'GET') return json({ mutes });
    if (method === 'POST') {
      if ((body.kind !== 'occurrence' && body.kind !== 'series') || typeof body.value !== 'string') return json({ error: 'Expected { kind, value }' }, 400);
      mutes.push({ kind: String(body.kind), value: String(body.value), title: typeof body.title === 'string' ? body.title : null, createdAt: '2026-10-27T01:00:00.000Z' });
      return json({ ok: true }, 201);
    }
    if (method === 'DELETE') {
      const k = url.searchParams.get('kind');
      const v = url.searchParams.get('value');
      mutes = mutes.filter((m) => !(m.kind === k && m.value === v));
      return json({ ok: true });
    }
  }
  if (pn === '/api/meet/evidence' && method === 'POST') {
    if (!server.googleConnected) return json({ connected: false, status: null, error: 'Google account not connected' }, 404);
    if (server.meetCheckFailed) return json({ recording: { state: 'none', listed: 0, ready: 0, fileIds: [] }, transcript: { state: 'none', listed: 0, docIds: [], source: null }, verdict: { importable: false }, checkFailed: true });
    if (body.meetingCode === 'abc-defg-hij') {
      return json({ recordName: 'conferenceRecords/x', recording: { state: 'ready', listed: 1, ready: 1, fileIds: ['f1'] }, transcript: { state: 'ready', listed: 1, docIds: ['d1'], source: 'meet' }, verdict: { hasRecording: true, hasTranscript: true, pending: false, importable: true }, checkFailed: false, checkedAt: '2026-10-27T01:00:00.000Z' });
    }
    return json({ recording: { state: 'none', listed: 0, ready: 0, fileIds: [] }, transcript: { state: 'none', listed: 0, docIds: [], source: null }, verdict: { hasRecording: false, hasTranscript: false, pending: false, importable: false }, checkFailed: false });
  }
  if (pn === '/api/teams/evidence' && method === 'POST') {
    if (!body.meetingCode && !body.eventId) return json({ error: 'One of url / meetingCode / eventId is required' }, 400);
    if (typeof body.meetingCode !== 'string' || !/^teams-[0-9a-f]{12}$/.test(body.meetingCode)) return json({ error: 'This event has no Teams link' }, 422);
    const chat = { checkedAt: '2026-10-27T01:00:00.000Z', held: true, callStart: '2026-10-20T06:01:00.000Z', callEnd: '2026-10-20T06:31:00.000Z', durationMs: 1_800_000, recorded: true, transcribed: false };
    if (server.teamsExternal) return json({ external: true, tenantId: 'tenant-x', code: body.meetingCode, chat, checkedAt: 'x' });
    return json({ external: false, code: body.meetingCode, chat, resolved: true, probed: true, hasRecording: true, hasTranscript: false, verdict: { hasRecording: true, hasTranscript: false, pending: false, importable: true }, imported: null, meta: null, checkFailed: false, checkedAt: 'x' });
  }
  if (pn === '/api/gmeet/reminders') {
    if (method === 'GET') return json({ connected: true, accountStatus: 'active', lastPollAt: '2026-10-27T00:00:00.000Z', reminders });
    if (method === 'PATCH') {
      if (typeof body.id !== 'number' || !['dismiss', 'mute'].includes(String(body.action))) return json({ error: 'Expected {id, action: dismiss|mute}' }, 400);
      const before = reminders.length;
      reminders = reminders.filter((r) => r.id !== body.id);
      if (reminders.length === before) return json({ error: 'Reminder not found or already resolved' }, 404);
      return json({ ok: true });
    }
  }
  const occ = pn.match(/^\/api\/series\/(\d+)\/occurrences$/);
  if (occ) {
    if (occ[1] !== '5') return notFound();
    return json({
      seriesId: 5, seriesTitle: 'Weekly Meeting X', googleConnected: true, meetChecked: true, graphChecked: false,
      sweptAt: '2026-10-27T00:00:00.000Z', fromCache: url.searchParams.get('refresh') !== '1',
      counts: { total: 4, imported: 1, importable: 1, bare: 1, empty: 0, upcoming: 1, external: 4 },
      occurrences: [
        { key: 'o4', startIso: '2026-11-03T02:00:00.000Z', title: 'Weekly Meeting X', source: 'calendar', upcoming: true, meetingCode: 'abc-defg-hij', hasRecording: false, hasTranscript: false, emptyTranscript: false, meet: null, imported: [] },
        { key: 'o3', startIso: '2026-10-27T02:00:00.000Z', title: 'Weekly Meeting X', source: 'both', upcoming: false, meetingCode: 'abc-defg-hij', hasRecording: true, hasTranscript: false, emptyTranscript: false, meet: { recordName: 'r', videoPending: false, transcriptPending: false }, imported: [] },
        { key: 'o2', startIso: '2026-10-20T02:00:00.000Z', title: 'Weekly Meeting X', source: 'calendar', upcoming: false, meetingCode: 'abc-defg-hij', hasRecording: true, hasTranscript: true, emptyTranscript: false, meet: null, imported: [{ assemblyai_id: 'm-200', title: 'Weekly Meeting X', accessible: true, queued: false, failed: false }] },
        { key: 'o1', startIso: '2026-10-13T02:00:00.000Z', title: null, source: 'calendar', upcoming: false, meetingCode: null, hasRecording: false, hasTranscript: false, emptyTranscript: false, meet: null, imported: [] },
      ],
    });
  }
  const voc = pn.match(/^\/api\/vocab\/(user|org)$/);
  if (voc) {
    const which = voc[1] as 'user' | 'org';
    if (method === 'GET') {
      return which === 'user'
        ? json({ vocab: vocab.user })
        : json({ vocab: vocab.org, version: vocab.orgVersion, updated_at: '2026-10-26T02:00:00.000Z', updated_by: 'u1' });
    }
    if (method === 'PUT') {
      const v = body.vocab as Vocab | undefined;
      if (!v || !Array.isArray(v.keyterms_prompt) || !Array.isArray(v.custom_spelling)) return json({ error: 'Invalid vocab' }, 400);
      if (which === 'user') { vocab.user = v; return json({ vocab: v }); }
      vocab.org = v;
      vocab.orgVersion += 1;
      return json({ vocab: v, version: vocab.orgVersion, updated_at: '2026-10-27T02:00:00.000Z', updated_by: 'u1' });
    }
  }
  return json({ error: 'bad' }, 400);
}

const CONSENT = { id: 'dcon_abcdefghjkmn', text: 'Change my Darth Meetings settings (vocabulary) as Test asked' };

function ctx(asJson = false, consent: { id: string; text: string } | null = null) {
  return {
    config: { email: 'test-a@example.com', meetingsUrl: 'https://meetings.test', timezone: 'Asia/Singapore' },
    flags: {},
    json: asJson,
    consent,
    api,
    expectJson: async (res: Promise<Response> | Response) => {
      const r = await res;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    requireWrite: () => {},
    requireAdmin: () => {},
    print: (data: unknown, human: () => void) => (asJson ? console.log(JSON.stringify(data)) : human()),
  };
}

const out = () => stdout.join('\n');
const err = () => stderr.join('\n');
const writes = () => calls.filter((c) => c.method !== 'GET');
const run = (argv: string[], asJson = false, consent: { id: string; text: string } | null = null) => meetings.run(ctx(asJson, consent), argv);
/** A verb that ends in process.exit (requireLabel on an unknown label). */
const runExit = async (argv: string[]): Promise<number> => {
  try { return await run(argv); } catch (e) { if (e instanceof Exit) return e.code; throw e; }
};
const reset = () => {
  stdout = [];
  stderr = [];
  calls = [];
};

beforeEach(() => {
  mutes = [{ kind: 'series', value: 'rec1', title: 'Meeting X', createdAt: '2026-10-26T02:00:00.000Z' }];
  reminders = [
    { id: 7, kind: 'unimported', meetingCode: 'abc-defg-hij', title: 'Meeting X', eventStart: '2026-10-20T02:00:00.000Z', hasRecording: true, hasTranscript: false },
    { id: 8, kind: 'autorec_off', meetingCode: 'teams-0123456789ab', title: null, eventStart: '2026-10-28T06:00:00.000Z' },
  ];
  vocab = { user: { keyterms_prompt: ['Tramies', 'Meeting X'], custom_spelling: [{ to: 'Test Person A', from: ['test persn a', 'tp a'] }] }, org: { keyterms_prompt: ['Org X'], custom_spelling: [] }, orgVersion: 3 };
  server = { readOnly: false, noAccess: false, googleConnected: true, meetCheckFailed: false, teamsExternal: false };
  reset();
  logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(' '));
  });
  errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
  exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code ?? 0);
  }) as never);
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

const tmpFile = (name: string, content: string) => {
  const f = path.join(tree, name);
  writeFileSync(f, content);
  return f;
};

// ── recordings dismiss ─────────────────────────────────────────────────────

describe('recordings dismiss', () => {
  test('PATCH {dismissSuggestedEvent:true}; prints the line; rec- prefix stripped', async () => {
    expect(await run(['recordings', 'dismiss', 'rec-r-own'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/recordings/r-own', method: 'PATCH', body: { dismissSuggestedEvent: true } }]);
    expect(out()).toContain('dismissed the suggested event on r-own — it is no longer offered');
    expect(out()).not.toContain('next suggestion');
  });

  test('a further suggestion is named (local tz); --json = the server reply', async () => {
    expect(await run(['recordings', 'dismiss', 'r-two'])).toBe(0);
    expect(out()).toContain('next suggestion: Meeting Y · 2026-10-21 14:00');
    reset();
    expect(await run(['recordings', 'dismiss', 'r-two'], true)).toBe(0);
    expect(JSON.parse(out()).recording.id).toBe('r-two');
  });

  test('404 not yours, 403 read-only token, no id = usage', async () => {
    expect(await run(['recordings', 'dismiss', 'r-nope'])).toBe(1);
    expect(err()).toContain('no such recording of yours');
    reset();
    server.readOnly = true;
    expect(await run(['recordings', 'dismiss', 'r-own'])).toBe(1);
    expect(err()).toContain('Forbidden: Forbidden - token is read-only');
    reset();
    expect(await run(['recordings', 'dismiss'])).toBe(1);
    expect(err()).toContain('usage: darth-cli meetings recordings dismiss <rid>');
    expect(calls).toEqual([]);
  });
});

// ── label-color ────────────────────────────────────────────────────────────

describe('label-color', () => {
  test('resolves a path case-insensitively → PATCH {color} lower-cased; prints old → new', async () => {
    expect(await run(['label-color', 'customers/org x', '#AABBCC'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/labels/4', method: 'PATCH', body: { color: '#aabbcc' } }]);
    expect(out()).toBe('Customers/Org X (#4) color #112233 → #aabbcc');
  });

  test('#id, bare rrggbb, and none = clear (color:null)', async () => {
    expect(await run(['label-color', '#3', 'ff0000'])).toBe(0);
    expect(writes()[0]).toEqual({ path: '/api/labels/3', method: 'PATCH', body: { color: '#ff0000' } });
    expect(out()).toBe('Customers (#3) color (none) → #ff0000');
    reset();
    expect(await run(['label-color', 'Customers/Org X', 'none'])).toBe(0);
    expect(writes()[0]!.body).toEqual({ color: null });
    expect(out()).toContain('color cleared — it inherits its parent');
  });

  test('bad color / missing args → exit 1 before any hop', async () => {
    for (const argv of [['label-color', 'Customers', 'red'], ['label-color', 'Customers', '#abc'], ['label-color', 'Customers'], ['label-color', 'a', 'b', '#ffffff']]) {
      reset();
      expect(await run(argv)).toBe(1);
      expect(calls).toEqual([]);
    }
    expect(err()).toContain('usage: darth-cli meetings label-color');
  });

  test('unknown label → exit 1 with did-you-mean, nothing written', async () => {
    expect(await runExit(['label-color', 'Org', '#ffffff'])).toBe(1);
    expect(err()).toContain("No label 'Org'");
    expect(err()).toContain('Customers/Org X  (#4)');
    expect(writes()).toEqual([]);
  });

  test('403 / 404 from the PATCH', async () => {
    server.readOnly = true;
    expect(await run(['label-color', '#4', '#ffffff'])).toBe(1);
    expect(err()).toContain('label-color refused: Forbidden - token is read-only');
    reset();
    server.readOnly = false;
    server.labelGone = true; // listed, then deleted before the PATCH lands
    expect(await run(['label-color', '#4', '#ffffff'])).toBe(1);
    expect(err()).toContain('label-color failed: not found (Label not found).');
  });
});

// ── calendar hidden / hide / unhide ────────────────────────────────────────

describe('calendar hidden', () => {
  test('lists the mutes (kind, hidden-at local, title, value)', async () => {
    expect(await run(['calendar', 'hidden'])).toBe(0);
    expect(calls).toEqual([{ path: '/api/calendar-mutes', method: 'GET' }]);
    expect(out()).toContain('series      2026-10-26 10:00  Meeting X  rec1');
    expect(out()).toContain('1 hidden');
  });

  test('empty list; --json = the server body; 403', async () => {
    mutes = [];
    expect(await run(['calendar', 'hidden'])).toBe(0);
    expect(out()).toContain('Nothing hidden');
    reset();
    expect(await run(['calendar', 'hidden'], true)).toBe(0);
    expect(JSON.parse(out())).toEqual({ mutes: [] });
    reset();
    server.noAccess = true;
    expect(await run(['calendar', 'hidden'])).toBe(1);
    expect(err()).toContain('calendar hidden refused: Forbidden - no Darth Meetings access');
  });

  test('plain calendar keeps its old behaviour (no sub-verb)', async () => {
    expect(await run(['calendar', '--view', 'bogus'])).toBe(1);
    expect(err()).toContain('--view must be unimported, norec or all');
  });
});

describe('calendar hide', () => {
  const KEY = 'evt1|2026-10-20T10:00:00+08:00';

  test('occurrence: looks the row up (cache only, day ±1) → POST {kind:occurrence, value:key, title}', async () => {
    expect(await run(['calendar', 'hide', KEY])).toBe(0);
    const look = calls[0]!;
    expect(look.method).toBe('GET');
    const q = new URL(look.path, 'https://x').searchParams;
    expect(new URL(look.path, 'https://x').pathname).toBe('/api/calendar/events');
    expect([q.get('from'), q.get('to'), q.get('tz'), q.get('sync')]).toEqual(['2026-10-19', '2026-10-21', 'Asia/Singapore', '0']);
    expect(writes()).toEqual([{ path: '/api/calendar-mutes', method: 'POST', body: { kind: 'occurrence', value: KEY, title: 'Meeting X' } }]);
    expect(out()).toContain('hidden: "Meeting X" 2026-10-20 10:00 (this occurrence)');
    expect(out()).toContain(`undo: darth-cli meetings calendar unhide '${KEY}'`);
  });

  test('--series (even when the parser swallowed the key) → value = recurringEventId; --title overrides', async () => {
    expect(await run(['calendar', 'hide', '--series', KEY, '--title', 'Standup X'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/calendar-mutes', method: 'POST', body: { kind: 'series', value: 'rec1', title: 'Standup X' } }]);
    expect(out()).toContain('every occurrence of the series, future ones too');
    expect(out()).toContain("unhide 'rec1' --series");
  });

  test('a row without a title sends no title (like the UI)', async () => {
    const saved = EVENTS[2]!.title;
    (EVENTS[2] as { title: string | null }).title = null;
    try {
      expect(await run(['calendar', 'hide', 'evt3|2026-10-20T16:00:00+08:00'])).toBe(0);
      expect(writes()[0]!.body).toEqual({ kind: 'occurrence', value: 'evt3|2026-10-20T16:00:00+08:00' });
    } finally {
      (EVENTS[2] as { title: string | null }).title = saved;
    }
  });

  test('matched by head + instant when the key is the unimported-layer form', async () => {
    expect(await run(['calendar', 'hide', 'abc-defg-hij|2026-10-20T02:00:00.000Z'])).toBe(0);
    expect(writes()[0]!.body).toEqual({ kind: 'occurrence', value: 'abc-defg-hij|2026-10-20T02:00:00.000Z', title: 'Meeting X' });
  });

  test('--series on a non-recurring row, unknown key, bad key, --title without value → exit 1, nothing written', async () => {
    expect(await run(['calendar', 'hide', 'evt2|2026-10-20T14:00:00+08:00', '--series'])).toBe(1);
    expect(err()).toContain('is not a recurring event');
    reset();
    expect(await run(['calendar', 'hide', 'evt9|2026-10-20T10:00:00+08:00'])).toBe(1);
    expect(err()).toContain('No calendar event with key');
    reset();
    expect(await run(['calendar', 'hide', 'not-a-key'])).toBe(1);
    expect(err()).toContain('is not an event key');
    expect(calls).toEqual([]);
    reset();
    expect(await run(['calendar', 'hide', KEY, '--title'])).toBe(1);
    expect(calls).toEqual([]);
    reset();
    expect(await run(['calendar', 'hide'])).toBe(1);
    expect(err()).toContain('usage: darth-cli meetings calendar hide');
    expect(writes()).toEqual([]);
  });

  test('403 from the POST', async () => {
    server.readOnly = true;
    expect(await run(['calendar', 'hide', KEY])).toBe(1);
    expect(err()).toContain('calendar hide refused: Forbidden - token is read-only');
  });
});

describe('calendar unhide', () => {
  test('series by raw value → GET pre-check then DELETE ?kind=series&value=', async () => {
    expect(await run(['calendar', 'unhide', 'rec1', '--series'])).toBe(0);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/calendar-mutes'],
      ['DELETE', '/api/calendar-mutes?kind=series&value=rec1'],
    ]);
    expect(out()).toBe('unhidden: "Meeting X" (series) — back in the calendar listings');
    expect(mutes).toEqual([]);
  });

  test('series by an event key → resolved to its recurringEventId', async () => {
    expect(await run(['calendar', 'unhide', '--series', 'evt1|2026-10-20T10:00:00+08:00'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/calendar-mutes?kind=series&value=rec1', method: 'DELETE' }]);
  });

  test('occurrence by key (encoded); not hidden → exit 1 with the --series hint', async () => {
    const KEY = 'evt2|2026-10-20T14:00:00+08:00';
    mutes.push({ kind: 'occurrence', value: KEY, title: 'Meeting Y', createdAt: '2026-10-26T02:00:00.000Z' });
    expect(await run(['calendar', 'unhide', KEY])).toBe(0);
    expect(writes()).toEqual([{ path: `/api/calendar-mutes?${new URLSearchParams({ kind: 'occurrence', value: KEY })}`, method: 'DELETE' }]);
    reset();
    expect(await run(['calendar', 'unhide', 'rec1'])).toBe(1);
    expect(err()).toContain("Nothing is hidden as occurrence 'rec1' — it is hidden as series: add --series");
    expect(writes()).toEqual([]);
  });

  test('403 / usage', async () => {
    server.readOnly = true;
    expect(await run(['calendar', 'unhide', 'rec1', '--series'])).toBe(1);
    expect(err()).toContain('calendar unhide refused');
    reset();
    expect(await run(['calendar', 'unhide'])).toBe(1);
    expect(calls).toEqual([]);
  });
});

// ── calendar check ─────────────────────────────────────────────────────────

describe('calendar check', () => {
  test('Meet row → POST /api/meet/evidence {meetingCode, startTime, event{id, recurringEventId}}; importable → import hint', async () => {
    expect(await run(['calendar', 'check', 'evt1|2026-10-20T10:00:00+08:00'])).toBe(0);
    expect(writes()).toEqual([{
      path: '/api/meet/evidence', method: 'POST',
      body: { meetingCode: 'abc-defg-hij', startTime: '2026-10-20T02:00:00.000Z', event: { id: 'evt1', recurringEventId: 'rec1' } },
    }]);
    expect(out()).toContain('Google — "Meeting X" 2026-10-20 10:00  [abc-defg-hij]');
    expect(out()).toContain('recording:  ready (1 of 1 file(s) ready)');
    expect(out()).toContain('transcript: ready (meet)');
    expect(out()).toContain("importable now — import it: darth-cli meetings import 'evt1|2026-10-20T10:00:00+08:00'");
  });

  test('Teams row (provider) → POST /api/teams/evidence with the UI body; chat verdict in words', async () => {
    expect(await run(['calendar', 'check', 'evt2|2026-10-20T14:00:00+08:00'])).toBe(0);
    expect(writes()).toEqual([{
      path: '/api/teams/evidence', method: 'POST',
      body: { meetingCode: 'teams-0123456789ab', eventId: 'evt2', startTime: '2026-10-20T06:00:00.000Z', endTime: '2026-10-20T06:30:00.000Z', event: { recurringEventId: null, organizerEmail: 'test-b@example.com' } },
    }]);
    expect(out()).toContain('Microsoft — "Meeting Y"');
    expect(out()).toContain('recording:  yes');
    expect(out()).toContain('chat:       call held 2026-10-20 14:01–14:31 (30m), recorded');
    expect(out()).toContain('importable now');
  });

  test('a key not in the cache whose head is a Meet code → body from the key; nothing there', async () => {
    expect(await run(['calendar', 'check', 'xyz-abcd-efg|2026-10-20T03:00:00.000Z'])).toBe(0);
    expect(writes()[0]).toEqual({ path: '/api/meet/evidence', method: 'POST', body: { meetingCode: 'xyz-abcd-efg', startTime: '2026-10-20T03:00:00.000Z', event: { id: null, recurringEventId: null } } });
    expect(out()).toContain('nothing at Google — never recorded');
  });

  test('--teams forces the Teams route (422 from a row with no Teams link)', async () => {
    expect(await run(['calendar', 'check', 'evt1|2026-10-20T10:00:00+08:00', '--teams'])).toBe(1);
    expect(writes()[0]!.path).toBe('/api/teams/evidence');
    expect(err()).toContain('calendar check failed (HTTP 422): This event has no Teams link');
  });

  test('external Teams tenant → says so, exit 0', async () => {
    server.teamsExternal = true;
    expect(await run(['calendar', 'check', 'evt2|2026-10-20T14:00:00+08:00'])).toBe(0);
    expect(out()).toContain('organized outside our tenant (tenant-x)');
  });

  test('no Meet link, unknown key, Google not connected (404), checkFailed (exit 1), 403', async () => {
    expect(await run(['calendar', 'check', 'evt3|2026-10-20T16:00:00+08:00'])).toBe(1);
    expect(err()).toContain('"Lunch" has no Google Meet link');
    expect(writes()).toEqual([]);
    reset();
    expect(await run(['calendar', 'check', 'evt9|2026-10-20T16:00:00+08:00'])).toBe(1);
    expect(err()).toContain('No calendar event with key');
    reset();
    server.googleConnected = false;
    expect(await run(['calendar', 'check', 'evt1|2026-10-20T10:00:00+08:00'])).toBe(1);
    expect(err()).toContain('Google is not connected (Google account not connected)');
    reset();
    server.googleConnected = true;
    server.meetCheckFailed = true;
    expect(await run(['calendar', 'check', 'evt1|2026-10-20T10:00:00+08:00'])).toBe(1);
    expect(out()).toContain("Google didn't answer — try again (nothing concluded)");
    reset();
    server.readOnly = true;
    expect(await run(['calendar', 'check', 'evt1|2026-10-20T10:00:00+08:00'])).toBe(1);
    expect(err()).toContain('calendar check refused: Forbidden - token is read-only');
  });

  test('--json = the evidence reply', async () => {
    expect(await run(['calendar', 'check', 'evt1|2026-10-20T10:00:00+08:00'], true)).toBe(0);
    expect(JSON.parse(out()).verdict.importable).toBe(true);
  });
});

// ── reminders ──────────────────────────────────────────────────────────────

describe('reminders', () => {
  test('list: id, when (local), provider, why, title [code]', async () => {
    expect(await run(['reminders'])).toBe(0);
    expect(calls).toEqual([{ path: '/api/gmeet/reminders', method: 'GET' }]);
    expect(out()).toContain('     7  2026-10-20 10:00  gmeet  not imported (recording)');
    expect(out()).toContain('Meeting X  [abc-defg-hij]');
    expect(out()).toContain('     8  2026-10-28 14:00  teams  auto-record is off — enable it in Meet before it starts  teams-0123456789ab');
    expect(out()).toContain('2 open reminder(s) (tz Asia/Singapore) · last poll 2026-10-27 08:00');
  });

  test('dismiss: GET then PATCH {id, action, meetingCode, title, eventStart} from that row', async () => {
    expect(await run(['reminders', 'dismiss', '7'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/gmeet/reminders', method: 'PATCH', body: { id: 7, action: 'dismiss', meetingCode: 'abc-defg-hij', title: 'Meeting X', eventStart: '2026-10-20T02:00:00.000Z' } }]);
    expect(out()).toBe('dismissed reminder 7: "Meeting X" 2026-10-20 10:00 — this occurrence only');
  });

  test('mute: same body with action mute; a null title falls back to the code in the line', async () => {
    expect(await run(['reminders', 'mute', '8'])).toBe(0);
    expect(writes()[0]!.body).toEqual({ id: 8, action: 'mute', meetingCode: 'teams-0123456789ab', title: null, eventStart: '2026-10-28T06:00:00.000Z' });
    expect(out()).toBe('muted reminder 8: "teams-0123456789ab" — never reminded about this meeting again');
  });

  test('unknown id → exit 1, no PATCH; bad usage → exit 1, no hop; 403; empty list; --json', async () => {
    expect(await run(['reminders', 'dismiss', '99'])).toBe(1);
    expect(err()).toContain('No open reminder 99');
    expect(writes()).toEqual([]);
    for (const argv of [['reminders', 'dismiss'], ['reminders', 'snooze', '7'], ['reminders', 'mute', 'x'], ['reminders', 'mute', '7', '8']]) {
      reset();
      expect(await run(argv)).toBe(1);
      expect(calls).toEqual([]);
    }
    reset();
    server.readOnly = true;
    expect(await run(['reminders', 'mute', '7'])).toBe(1);
    expect(err()).toContain('reminders mute refused');
    reset();
    server.readOnly = false;
    reminders = [];
    expect(await run(['reminders'])).toBe(0);
    expect(out()).toBe('No open reminders.');
    reset();
    expect(await run(['reminders'], true)).toBe(0);
    expect(JSON.parse(out()).reminders).toEqual([]);
  });

  test('404 from the PATCH (resolved meanwhile)', async () => {
    const orig = api;
    const row = reminders[0]!;
    // the GET still lists it; the PATCH finds it gone
    reminders = reminders.filter((r) => r.id !== 7);
    const ctxRace = { ...ctx(), api: async (b: string, p: string, init?: RequestInit) => (init?.method === 'PATCH' ? orig(b, p, init) : Response.json({ connected: true, reminders: [row] })) };
    expect(await meetings.run(ctxRace, ['reminders', 'dismiss', '7'])).toBe(1);
    expect(err()).toContain('reminders dismiss failed: not found (Reminder not found or already resolved)');
  });
});

// ── series occurrences ─────────────────────────────────────────────────────

describe('series occurrences', () => {
  test('one line per occurrence (local tz) with status + the linked meeting id', async () => {
    expect(await run(['series', 'occurrences', '5'])).toBe(0);
    expect(calls).toEqual([{ path: '/api/series/5/occurrences', method: 'GET' }]);
    const o = out();
    expect(o).toContain('series #5 "Weekly Meeting X" — 4 occurrence(s) on your calendar: 1 imported · 1 importable · 1 nothing recorded · 1 upcoming');
    expect(o).toContain('  2026-11-03 10:00  upcoming');
    expect(o).toContain('  2026-10-27 10:00  importable (recording)');
    expect(o).toContain('  2026-10-20 10:00  imported → m-200');
    expect(o).toContain('  2026-10-13 10:00  nothing recorded                    (untitled)');
    expect(o).toContain('cached; --refresh re-sweeps');
  });

  test('--refresh → ?refresh=1 (fresh); --json = the body', async () => {
    expect(await run(['series', 'occurrences', '5', '--refresh'])).toBe(0);
    expect(calls[0]!.path).toBe('/api/series/5/occurrences?refresh=1');
    expect(out()).toContain('— fresh');
    reset();
    expect(await run(['series', 'occurrences', '5'], true)).toBe(0);
    expect(JSON.parse(out()).occurrences.length).toBe(4);
  });

  test('404 not visible, 403 no access, usage', async () => {
    expect(await run(['series', 'occurrences', '6'])).toBe(1);
    expect(err()).toContain('no series #6 visible to you');
    reset();
    server.noAccess = true;
    expect(await run(['series', 'occurrences', '5'])).toBe(1);
    expect(err()).toContain('series occurrences refused');
    reset();
    expect(await run(['series', 'occurrences', 'abc'])).toBe(1);
    expect(calls).toEqual([]);
  });
});

// ── vocab ──────────────────────────────────────────────────────────────────

describe('vocab', () => {
  test('read: one term per line, then To <- from per spelling; no consent needed', async () => {
    expect(await run(['vocab'])).toBe(0);
    expect(calls).toEqual([{ path: '/api/vocab/user', method: 'GET' }]);
    expect(stdout).toEqual([
      "# my vocabulary: 2 term(s), 1 spelling(s) — 'To <- from, from' = a custom spelling",
      'Tramies',
      'Meeting X',
      'Test Person A <- test persn a, tp a',
    ]);
  });

  test('--org read carries the version; --json = the body', async () => {
    expect(await run(['vocab', '--org'])).toBe(0);
    expect(calls[0]!.path).toBe('/api/vocab/org');
    expect(stdout[0]).toContain('# company vocabulary v3, updated 2026-10-26 10:00: 1 term(s), 0 spelling(s)');
    reset();
    expect(await run(['vocab', '--org'], true)).toBe(0);
    expect(JSON.parse(out()).version).toBe(3);
  });

  test('--set without consent → exit 6 with the request command, nothing written', async () => {
    const f = tmpFile('v1.txt', 'Tramies\n');
    expect(await run(['vocab', '--set', '--file', f])).toBe(6);
    expect(err()).toContain("darth-cli consent request --service meetings --action settings --target - --text 'Change my Darth Meetings settings (vocabulary) as Test asked'");
    expect(writes()).toEqual([]);
    reset();
    expect(await run(['vocab', '--org', '--set', '--file', f])).toBe(6);
    expect(err()).toContain('settings (company vocabulary)');
  });

  test('the retired bare flag → exit 6 even with a consent', async () => {
    const f = tmpFile('v2.txt', 'Tramies\n');
    expect(await run(['vocab', '--set', '--file', f, '--i-have-got-consent-from-human-user'], false, CONSENT)).toBe(6);
    expect(err()).toContain('this flag is retired');
    expect(writes()).toEqual([]);
  });

  test('--set with consent: the text read prints round-trips into PUT {vocab}', async () => {
    const f = tmpFile('v3.txt', "# my vocabulary: …\nTramies\n\n  Org X  \nTest Person A <- test persn a, tp a\n");
    expect(await run(['vocab', '--set', '--file', f], false, CONSENT)).toBe(0);
    expect(writes()).toEqual([{ path: '/api/vocab/user', method: 'PUT', body: { vocab: { keyterms_prompt: ['Tramies', 'Org X'], custom_spelling: [{ to: 'Test Person A', from: ['test persn a', 'tp a'] }] } } }]);
    expect(out()).toBe('saved my vocabulary: 2 term(s), 1 spelling(s) — it REPLACED the previous list');
  });

  test('--org --set from JSON ({vocab:…} form); prints the new version', async () => {
    const f = tmpFile('v4.json', JSON.stringify({ vocab: { keyterms_prompt: ['Org X', 'Org Y'], custom_spelling: [] } }));
    expect(await run(['vocab', '--org', '--set', '--file', f], false, CONSENT)).toBe(0);
    expect(writes()[0]).toEqual({ path: '/api/vocab/org', method: 'PUT', body: { vocab: { keyterms_prompt: ['Org X', 'Org Y'], custom_spelling: [] } } });
    expect(out()).toBe('saved company vocabulary v4: 2 term(s), 0 spelling(s) — it REPLACED the previous list');
  });

  test('bad input → exit 1 before consent / any hop', async () => {
    for (const content of ['{"keyterms_prompt": "x", "custom_spelling": []}', '{nope', 'Term\n <- a\n', 'X <- \n']) {
      reset();
      expect(await run(['vocab', '--set', '--file', tmpFile('bad.txt', content)], false, CONSENT)).toBe(1);
      expect(calls).toEqual([]);
    }
    reset();
    expect(await run(['vocab', '--set'], false, CONSENT)).toBe(1);
    expect(err()).toContain("--file needs a file ('-' reads stdin)");
    reset();
    expect(await run(['vocab', '--file', 'x'])).toBe(1);
    expect(err()).toContain('--file only goes with --set');
    reset();
    expect(await run(['vocab', 'extra'])).toBe(1);
    expect(calls).toEqual([]);
  });

  test('403 on the read / the write', async () => {
    server.noAccess = true;
    expect(await run(['vocab'])).toBe(1);
    expect(err()).toContain('vocab refused');
    reset();
    server.noAccess = false;
    server.readOnly = true;
    expect(await run(['vocab', '--set', '--file', tmpFile('v5.txt', 'X\n')], false, CONSENT)).toBe(1);
    expect(err()).toContain('vocab --set refused: Forbidden - token is read-only');
  });
});

// ── pure helpers ───────────────────────────────────────────────────────────

describe('pure helpers', () => {
  test('parseLabelColor', () => {
    expect(P.parseLabelColor('#AbCdEf')).toBe('#abcdef');
    expect(P.parseLabelColor('abcdef')).toBe('#abcdef');
    expect(P.parseLabelColor('NONE')).toBeNull();
    for (const bad of ['#abcde', '#abcdefg', 'red', '', '#ggg000']) expect(P.parseLabelColor(bad)).toBeUndefined();
  });

  test('parseEventKey', () => {
    expect(P.parseEventKey('evt1|2026-10-20T10:00:00+08:00')).toEqual({ head: 'evt1', startMs: Date.parse('2026-10-20T02:00:00Z') });
    expect(P.parseEventKey('a|b|2026-10-20T02:00:00Z')?.head).toBe('a|b');
    for (const bad of ['evt1', '|2026-10-20T02:00:00Z', 'evt1|', 'evt1|not-a-date']) expect(P.parseEventKey(bad)).toBeNull();
  });

  test('evidenceRequest: Meet needs a Meet code; Teams takes code or event id', () => {
    const row = { key: 'k', eventId: 'e', recurringEventId: null, title: 'T', start: 's', end: null, meetingCode: null, provider: null, organizerEmail: null };
    expect(P.evidenceRequest(row, false)).toEqual({ error: '"T" has no Google Meet link — nothing to check at Google (a Teams call? add --teams)' });
    expect(P.evidenceRequest(row, true)).toEqual({ path: '/api/teams/evidence', body: { meetingCode: null, eventId: 'e', startTime: 's', endTime: null, event: { recurringEventId: null, organizerEmail: null } } });
    expect('error' in P.evidenceRequest({ ...row, eventId: null }, true)).toBe(true);
  });

  test('evidenceLines: pending, imported elsewhere, unresolved, check failed', () => {
    const tz = 'Asia/Singapore';
    expect(P.evidenceLines(false, { recording: { state: 'generating', listed: 1, ready: 0 }, transcript: { state: 'none' }, verdict: { importable: true, pending: true } }, 'k', tz).lines.at(-1)).toContain('still being generated');
    expect(P.evidenceLines(true, { resolved: true, verdict: { hasRecording: true, importable: true }, imported: { assemblyaiId: null, title: null, ownerEmail: 'test-c@example.com', accessible: false } }, 'k', tz).lines.at(-1)).toBe("already imported by test-c@example.com (you can't open it — ask them to share it)");
    expect(P.evidenceLines(true, { resolved: false, verdict: {}, chat: { reason: 'forbidden' } }, 'k', tz).lines).toEqual(['Microsoft has no record of this meeting', 'chat:       not readable (forbidden)', 'nothing at Microsoft to import']);
    expect(P.evidenceLines(true, { checkFailed: true, error: "Microsoft didn’t answer (429)" }, 'k', tz).code).toBe(1);
  });

  test('parseVocabSource / vocabLines round-trip', () => {
    const v = { keyterms_prompt: ['A', 'B C'], custom_spelling: [{ to: 'Test Person A', from: ['tpa', 'test a'] }] };
    const back = P.parseVocabSource(P.vocabLines(v).join('\n'));
    expect(back).toEqual({ ok: true, vocab: v });
    expect(P.parseVocabSource(JSON.stringify(v))).toEqual({ ok: true, vocab: v });
    expect(P.parseVocabSource('{"keyterms_prompt":[" x ",""],"custom_spelling":[]}')).toEqual({ ok: true, vocab: { keyterms_prompt: ['x'], custom_spelling: [] } });
    expect(P.parseVocabSource('{"keyterms_prompt":[1],"custom_spelling":[]}').ok).toBe(false);
    expect(P.parseVocabSource('{"keyterms_prompt":[],"custom_spelling":[{"to":"x","from":"y"}]}').ok).toBe(false);
    expect(P.parseVocabSource('')).toEqual({ ok: true, vocab: { keyterms_prompt: [], custom_spelling: [] } });
  });

  test('occurrenceStatus / reminderKindWords', () => {
    const base = { startIso: 'x', title: null, source: 'calendar', upcoming: false, meetingCode: null, hasRecording: false, hasTranscript: false, imported: [] as unknown[] };
    expect(P.occurrenceStatus({ ...base, imported: [{ assemblyai_id: 'm-1', title: null, accessible: false, queued: true }] })).toBe('imported (no access) (queued)');
    expect(P.occurrenceStatus({ ...base, imported: [{ assemblyai_id: 'm-1', title: null, accessible: true, failed: true }] })).toBe('imported → m-1 (import failed)');
    expect(P.occurrenceStatus({ ...base, hasTranscript: true, meet: { transcriptPending: true } })).toBe('importable (transcript, generating)');
    expect(P.occurrenceStatus({ ...base, emptyTranscript: true })).toBe('empty transcript (no speech)');
    expect(P.reminderKindWords({ kind: 'sync_requested' })).toBe('colleagues need your import');
    expect(P.reminderKindWords({ kind: 'unimported', hasRecording: true, hasTranscript: true })).toBe('not imported (recording+transcript)');
  });
});

// ── help ───────────────────────────────────────────────────────────────────

describe('help <verb> for the new verbs', () => {
  test('each verb (and two-word sub-verb) has its own HELP lines', async () => {
    for (const [argv, needle] of [
      [['help', 'recordings', 'dismiss'], 'recordings dismiss <rid>'],
      [['help', 'label-color'], 'label-color <label> <#rrggbb|none>'],
      [['help', 'calendar', 'hidden'], 'calendar hidden'],
      [['help', 'calendar', 'hide'], 'calendar hide <event-key> [--series] [--title "<t>"]'],
      [['help', 'calendar', 'unhide'], 'calendar unhide <event-key|value> [--series]'],
      [['help', 'calendar', 'check'], 'calendar check <event-key> [--teams]'],
      [['help', 'reminders'], 'The home page\'s reminders card'],
      [['help', 'reminders', 'dismiss'], 'reminders dismiss <id>'],
      [['help', 'reminders', 'mute'], 'reminders mute <id>'],
      [['help', 'series', 'occurrences'], 'series occurrences <id> [--refresh]'],
      [['help', 'vocab'], 'vocab [--org]'],
    ] as const) {
      reset();
      expect(await run([...argv])).toBe(0);
      expect(out()).toContain(needle);
    }
  });

  test('two words fall back to the first word; the old one-word help is unchanged', async () => {
    expect(await run(['help', 'calendar', 'nonsense'])).toBe(0);
    expect(out()).toContain('calendar [--view unimported|norec|all]');
    reset();
    expect(await run(['help', 'calendar', 'hide'])).toBe(0);
    expect(out()).not.toContain('calendar [--view');
    reset();
    expect(await run(['help', 'recordings'])).toBe(0);
    expect(out()).toContain('recordings list|get|text|audio|link|make-meeting|keep|dismiss|rm');
  });
});
