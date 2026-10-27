/**
 * CLI ↔ UI parity, batch A (task 05): the transcript page's remaining actions
 * as verbs — set-description, keep, trash --cancel-queued, unlink,
 * link --dismiss, fetch-recording, retry, activity, ai-runs, attach /
 * attachment-rm, share --suggestions / --add-suggested, speakers --guess,
 * text --index, edit-line, replace.
 *
 * Same harness as the other cli-meetings-*.test.ts files: the subcommand
 * source copied into a temp tree beside a stand-in `core/args.ts`, run
 * against a fake server that answers like the real routes (success, 403 for a
 * reader, 404, 409 where the route has one) and records every request.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-parity-a-'));
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

type Edit = { text?: string; speaker?: string };
type Row = {
  title: string;
  status: string;
  access: 'owner' | 'edit' | 'read';
  scratch?: boolean;
  description?: string;
  linked?: { shares: string[] };
  suggestedEvent?: { title: string };
  audio?: boolean;
  ingestFailure?: boolean;
  googleConnected?: boolean;
  recordingKnown?: boolean;
};
type Call = { path: string; method: string; body?: Record<string, unknown>; rawBytes?: number; headers?: Record<string, string> };

let rows: Record<string, Row>;
let edits: Record<string, Record<string, Edit>>;
let shares: Record<string, Array<{ shared_with_email: string; shared_with_name: string | null; access: string; shared_at: string; source: string; shared_by: null }>>;
let calls: Call[];
let stdout: string[];
let stderr: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

const UTTERANCES = [
  { start: 0, end: 4000, speaker: 'A', text: 'Hello from Meeting X.' },
  { start: 65000, end: 70000, speaker: 'B', text: 'The tramies team ships tramies tools.' },
  { start: 130000, end: 131000, speaker: 'A', text: 'Thanks.' },
];
const DIRECTORY = [{ id: 21, name: 'Test Person B', email: 'test-b@trames.sg', source: 'trames' }];

const json = (data: unknown, status = 200) => Response.json(data, { status });
const notFound = () => json({ error: 'Not found' }, 404);
const readOnly = () => json({ error: 'Read-only access' }, 403);

async function api(_base: string, p: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const call: Call = { path: p, method };
  if (typeof init?.body === 'string') call.body = JSON.parse(init.body) as Record<string, unknown>;
  else if (init?.body instanceof Blob) call.rawBytes = (await init.body.arrayBuffer()).byteLength;
  if (init?.headers) call.headers = { ...(init.headers as Record<string, string>) };
  calls.push(call);
  const url = new URL(p, 'https://meetings.test');

  if (url.pathname === '/api/users/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return json({ people: DIRECTORY.filter((d) => d.email === q) });
  }
  const m = url.pathname.match(/^\/api\/transcripts\/([^/]+)(\/.*)?$/);
  const id = m?.[1];
  const row = id ? rows[id] : undefined;
  if (!m || !id || !row) return notFound();
  const sub = m[2] ?? '';
  const body = call.body ?? {};
  const t = () => ({ assemblyai_id: id, title: row.title, status: row.status, access: row.access, scratch: row.scratch ?? false, description: row.description ?? null, speaker_id_status: 'completed', speaker_count: 2 });

  if (sub === '') {
    if (method === 'GET') return json({ transcript: t() });
    if (method === 'PATCH') {
      if (row.access === 'read') return readOnly();
      if (body.dismissSuggestedEvent === true) {
        if (!row.suggestedEvent) return json({ error: 'No suggested event on this meeting' }, 409);
        return json({ transcript: t() });
      }
      if (body.unlinkEvent === true) {
        if (!row.linked) return json({ error: 'This meeting is not linked to a calendar event' }, 409);
        const sharesRemoved = row.linked.shares;
        row.linked = undefined;
        return json({ transcript: t(), sharesRemoved });
      }
      if (typeof body.scratch === 'boolean') row.scratch = body.scratch;
      if (typeof body.description === 'string') row.description = body.description;
      return json({ transcript: t() });
    }
    if (method === 'DELETE') {
      if (row.access !== 'owner') return json({ error: 'Only the owner can delete' }, 403);
      if (row.status === 'waiting' || row.status === 'uploading') {
        delete rows[id];
        return json({ ok: true, filesRemoved: true });
      }
      return json({ ok: true, trashed: true });
    }
  }
  if (sub === '/content') return json({ content: { text: UTTERANCES.map((u) => u.text).join(' '), utterances: UTTERANCES } });
  if (sub === '/speakers' && method === 'GET') {
    return json({ speakerLabels: [{ originalSpeaker: 'A', customName: 'Test Person A', description: '' }], suggestions: { B: { name: 'Test Person B', confidence: 0.8, source: 'voice' } } });
  }
  if (sub === '/speakers/suggest' && method === 'POST') {
    if (row.access === 'read') return readOnly();
    if (row.status !== 'completed') return json({ error: 'Transcript is not completed yet' }, 409);
    return json({ suggestions: { B: { name: 'Test Person B', confidence: 0.8, source: 'voice' } }, speakerIdStatus: 'running' });
  }
  if (sub === '/edits') {
    if (method === 'GET') return json({ edits: edits[id] ?? {} });
    if (row.access === 'read') return readOnly();
    if (method === 'PATCH') {
      const key = String(body.utteranceIndex);
      edits[id] = { ...(edits[id] ?? {}), [key]: { ...(edits[id]?.[key] ?? {}), text: String(body.text) } };
      return json({ edits: edits[id] });
    }
    if (method === 'PUT') {
      edits[id] = body.edits as Record<string, Edit>;
      return json({ edits: edits[id] });
    }
  }
  if (sub === '/fetch-audio' && method === 'POST') {
    if (row.access === 'read') return readOnly();
    if (row.audio) return json({ ok: true, already: true });
    if (!row.recordingKnown) return json({ error: 'No recording is known for this transcript.' }, 422);
    if (!row.googleConnected) return json({ error: 'Google is not connected — connect Google and try again.' }, 401);
    row.audio = true;
    return json({ ok: true, bytes: 2 * 1048576 });
  }
  if (sub === '/retry-ingest' && method === 'POST') {
    if (row.access === 'read') return readOnly();
    if (row.status !== 'error' || !row.ingestFailure) return json({ error: 'This transcript is not a failed hand-off.' }, 409);
    row.status = 'uploading';
    return json({ ok: true }, 202);
  }
  if (sub === '/activity') {
    return json({
      events: [
        { id: 2, user_email: 'test-a@example.com', user_name: 'Test Person A', action: 'edit_meta', details: { changedTitle: true, changedDescription: false }, at: '2026-10-01T02:00:00.000Z' },
        { id: 1, user_email: 'test-c@example.com', user_name: null, action: 'view', details: null, at: '2026-09-30T23:30:00.000Z' },
      ],
      lastEdit: null,
      recentViewers: [{ user_id: 'u3', user_email: 'test-c@example.com', user_name: null, last_viewed_at: '2026-09-30T23:30:00.000Z' }],
    });
  }
  if (sub === '/ai-runs') {
    return json({
      runs: [{ kind: 'auto_notes', status: 'completed', model: 'model-x', cost_usd: '0.1234', duration_ms: 42000, input_tokens: '1000', output_tokens: '200', triggered_by_email: 'test-a@example.com', error: null, created_at: '2026-10-01T02:00:00.000Z' },
        { kind: 'speaker_id', status: 'error', model: 'model-x', cost_usd: null, duration_ms: null, input_tokens: null, output_tokens: null, triggered_by_email: null, error: 'timed out\nafter 60s', created_at: '2026-10-01T01:00:00.000Z' }],
      totals: { runs: 2, errors: 1, cost_usd: '0.1234' },
    });
  }
  if (sub === '/attachments' && method === 'POST') {
    if (row.access === 'read') return readOnly();
    const ct = call.headers?.['content-type'] ?? '';
    if (ct.includes('application/json')) {
      return json({ attachment: { id: 12, kind: 'text', title: typeof body.title === 'string' ? body.title : 'Pasted notes' } }, 201);
    }
    const title = call.headers?.['x-title'] ? decodeURIComponent(call.headers['x-title']) : decodeURIComponent(call.headers?.['x-filename'] ?? 'Attachment');
    return json({ attachment: { id: 11, kind: 'file', title, extraction_status: 'ok' } }, 201);
  }
  const att = sub.match(/^\/attachments\/(\d+)$/);
  if (att && method === 'DELETE') {
    if (row.access === 'read') return readOnly();
    return att[1] === '11' ? json({ ok: true }) : notFound();
  }
  if (sub === '/share-suggestions') {
    if (row.access === 'read') return json({ suggestions: [] });
    const have = new Set((shares[id] ?? []).map((s) => s.shared_with_email));
    return json({ suggestions: [{ name: 'Test Person B', email: 'test-b@trames.sg', reason: 'was invited' }].filter((s) => !have.has(s.email)) });
  }
  if (sub === '/shares') {
    const list = (shares[id] ??= []);
    if (method === 'GET') return json({ shares: list, access: row.access, owner: { email: 'test-a@example.com', name: 'Test Person A', isMe: row.access === 'owner' } });
    if (row.access === 'read') return json({ error: 'Only the owner or an editor can share' }, 403);
    if (method === 'POST') {
      list.push({ shared_with_email: String(body.email), shared_with_name: (body.name as string) ?? null, access: String(body.access), shared_at: '2026-10-27T01:00:00.000Z', source: 'manual', shared_by: null });
      return json({ ok: true }, 201);
    }
  }
  return json({ error: 'bad' }, 400);
}

function ctx(asJson = false) {
  return {
    config: { email: 'test-a@example.com', meetingsUrl: 'https://meetings.test', timezone: 'Asia/Singapore' },
    flags: {},
    json: asJson,
    consent: null,
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
const run = (argv: string[], asJson = false) => meetings.run(ctx(asJson), argv);
const reset = () => {
  stdout = [];
  stderr = [];
  calls = [];
};

beforeEach(() => {
  rows = {
    'm-own': { title: 'Meeting X', status: 'completed', access: 'owner', scratch: true, linked: { shares: ['test-c@trames.sg'] }, suggestedEvent: { title: 'Meeting X sync' }, recordingKnown: true, googleConnected: true },
    'm-edit': { title: 'Meeting Y', status: 'completed', access: 'edit', audio: true },
    'm-ro': { title: 'Meeting Z', status: 'completed', access: 'read' },
    'm-wait': { title: 'Meeting W', status: 'waiting', access: 'owner' },
    'm-up': { title: 'Meeting V', status: 'uploading', access: 'owner' },
    'm-err': { title: 'Meeting U', status: 'error', access: 'owner', ingestFailure: true },
    'm-nogoogle': { title: 'Meeting T', status: 'completed', access: 'owner', recordingKnown: true, googleConnected: false },
  };
  edits = { 'm-own': { '2': { text: 'Thanks, Tramies.' } } };
  shares = {};
  reset();
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

const tmpFile = (name: string, content: string) => {
  const f = path.join(tree, name);
  writeFileSync(f, content);
  return f;
};

// ── the verbs ──────────────────────────────────────────────────────────────

describe('set-description', () => {
  test('PATCHes {description} trimmed, like the page; prints the length', async () => {
    const f = tmpFile('desc.md', '  Notes for Meeting X\n\n');
    expect(await run(['set-description', 'm-own', '--file', f])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-own', method: 'PATCH', body: { description: 'Notes for Meeting X' }, headers: { 'content-type': 'application/json' } }]);
    expect(out()).toBe('description set (19 chars)');
  });

  test('an empty file clears it; --file missing → usage, no hop', async () => {
    expect(await run(['set-description', 'm-own', '--file', tmpFile('empty.md', '\n')])).toBe(0);
    expect(out()).toBe('description cleared');
    reset();
    expect(await run(['set-description', 'm-own'])).toBe(1);
    expect(writes()).toEqual([]);
  });

  test('403 reader, 404 unknown', async () => {
    const f = tmpFile('d2.md', 'x');
    expect(await run(['set-description', 'm-ro', '--file', f])).toBe(1);
    expect(err()).toContain('Forbidden: Read-only access');
    reset();
    expect(await run(['set-description', 'm-nope', '--file', f])).toBe(1);
    expect(err()).toContain('no meeting m-nope visible to you');
  });
});

describe('keep', () => {
  test('PATCH {scratch:false} per id; carries on past a failure, exit 1', async () => {
    expect(await run(['keep', 'm-own,m-ro,m-edit'])).toBe(1);
    expect(writes().map((c) => [c.path, c.body])).toEqual([
      ['/api/transcripts/m-own', { scratch: false }],
      ['/api/transcripts/m-ro', { scratch: false }],
      ['/api/transcripts/m-edit', { scratch: false }],
    ]);
    expect(out()).toContain('kept m-own — permanent now');
    expect(out()).toContain('kept m-edit — permanent now');
    expect(err()).toContain('Forbidden: Read-only access');
    expect(rows['m-own']!.scratch).toBe(false);
  });

  test('all good → exit 0; 404 → exit 1; --json one object for one id', async () => {
    expect(await run(['keep', 'm-own'], true)).toBe(0);
    expect(JSON.parse(out())).toEqual({ id: 'm-own', kept: true });
    reset();
    expect(await run(['keep', 'm-nope'])).toBe(1);
    expect(err()).toContain('not found');
  });
});

describe('trash --cancel-queued', () => {
  test('a waiting placeholder is DELETEd (the "Cancel queued import")', async () => {
    expect(await run(['trash', 'm-wait', '--cancel-queued'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-wait', method: 'DELETE' }]);
    expect(out()).toContain('cancelled the queued import m-wait');
  });

  test('flag before the id still works (boolean lifted)', async () => {
    expect(await run(['trash', '--cancel-queued', 'm-wait'])).toBe(0);
    expect(writes()).toHaveLength(1);
  });

  test('uploading stays refused; a normal row is not trashed through the flag; no flag on waiting → hint', async () => {
    expect(await run(['trash', 'm-up', '--cancel-queued'])).toBe(1);
    expect(err()).toContain('still uploading');
    expect(writes()).toEqual([]);
    reset();
    expect(await run(['trash', 'm-own', '--cancel-queued'])).toBe(1);
    expect(err()).toContain('drop the flag to move it to the trash');
    expect(writes()).toEqual([]);
    reset();
    expect(await run(['trash', 'm-wait'])).toBe(1);
    expect(err()).toContain("'darth-cli meetings trash m-wait --cancel-queued'");
    expect(writes()).toEqual([]);
  });

  test('a reader is refused before any DELETE; 404; restore rejects the flag; plain trash unchanged', async () => {
    expect(await run(['trash', 'm-ro', '--cancel-queued'])).toBe(1);
    expect(err()).toContain('Only the owner can trash m-ro');
    expect(writes()).toEqual([]);
    reset();
    await expect(run(['trash', 'm-nope', '--cancel-queued'])).rejects.toThrow('HTTP 404');
    reset();
    expect(await run(['restore', 'm-own', '--cancel-queued'])).toBe(1);
    reset();
    expect(await run(['trash', 'm-own'])).toBe(0);
    expect(out()).toContain('trashed m-own');
  });
});

describe('unlink', () => {
  test('PATCH {unlinkEvent:true}; prints the removed link shares', async () => {
    expect(await run(['unlink', 'm-own'])).toBe(0);
    expect(writes()[0]!.body).toEqual({ unlinkEvent: true });
    expect(out()).toContain('unlinked m-own from its calendar event — 1 share(s) the link had created removed: test-c@trames.sg');
  });

  test('409 not linked, 403 reader, 404', async () => {
    expect(await run(['unlink', 'm-edit'])).toBe(1);
    expect(err()).toContain('unlink refused: This meeting is not linked to a calendar event');
    reset();
    expect(await run(['unlink', 'm-ro'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['unlink', 'm-nope'])).toBe(1);
    expect(err()).toContain('not found');
  });
});

describe('link --dismiss', () => {
  test('PATCH {dismissSuggestedEvent:true}; the ref form is untouched', async () => {
    expect(await run(['link', 'm-own', '--dismiss'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-own', method: 'PATCH', body: { dismissSuggestedEvent: true }, headers: { 'content-type': 'application/json' } }]);
    expect(out()).toContain('dismissed the suggested event on m-own');
    reset();
    expect(await run(['link', 'm-own', 'abc-defg-hij', '--dismiss'])).toBe(1);
    expect(writes()).toEqual([]);
  });

  test('409 no suggestion, 403 reader, 404', async () => {
    expect(await run(['link', 'm-edit', '--dismiss'])).toBe(1);
    expect(err()).toContain('link --dismiss refused: No suggested event on this meeting');
    reset();
    expect(await run(['link', 'm-ro', '--dismiss'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['link', 'm-nope', '--dismiss'])).toBe(1);
    expect(err()).toContain('not found');
  });
});

describe('fetch-recording', () => {
  test('POST fetch-audio {}; prints the size; "already" when stored', async () => {
    expect(await run(['fetch-recording', 'm-own'])).toBe(0);
    expect(writes()[0]).toMatchObject({ path: '/api/transcripts/m-own/fetch-audio', method: 'POST', body: {} });
    expect(out()).toContain('fetched the recording of m-own (2.0 MB)');
    reset();
    expect(await run(['fetch-recording', 'm-edit'])).toBe(0);
    expect(out()).toContain('already has its recording stored');
  });

  test('Google not connected (401) is exit 1, not the token exit 3; 422; 403; 404', async () => {
    expect(await run(['fetch-recording', 'm-nogoogle'])).toBe(1);
    expect(err()).toContain('Google is not connected');
    expect(err()).not.toContain('darth-cli login');
    reset();
    expect(await run(['fetch-recording', 'm-wait'])).toBe(1);
    expect(err()).toContain('No recording is known');
    reset();
    expect(await run(['fetch-recording', 'm-ro'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['fetch-recording', 'm-nope'])).toBe(1);
    expect(err()).toContain('not found');
  });
});

describe('retry', () => {
  test('202 → back to uploading; 409 not a failed hand-off; 403; 404', async () => {
    expect(await run(['retry', 'm-err'])).toBe(0);
    expect(writes()[0]).toMatchObject({ path: '/api/transcripts/m-err/retry-ingest', method: 'POST' });
    expect(out()).toContain('retrying m-err (HTTP 202)');
    reset();
    expect(await run(['retry', 'm-own'])).toBe(1);
    expect(err()).toContain('retry refused: This transcript is not a failed hand-off.');
    reset();
    expect(await run(['retry', 'm-ro'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['retry', 'm-nope'])).toBe(1);
    expect(err()).toContain('not found');
  });
});

describe('activity / ai-runs', () => {
  test('activity: limit reaches the query; one line per event in local tz; viewers footer', async () => {
    expect(await run(['activity', 'm-ro', '--limit', '5'])).toBe(0);
    expect(calls[0]!.path).toBe('/api/transcripts/m-ro/activity?limit=5');
    expect(out()).toContain('2026-10-01 10:00  Test Person A <test-a@example.com>  edit_meta  — changedTitle');
    expect(out()).toContain('2026-10-01 07:30  test-c@example.com  view');
    expect(out()).toContain('viewed in the last 30 days by test-c@example.com');
    reset();
    expect(await run(['activity', 'm-ro', '--limit', '500'])).toBe(1);
    expect(calls).toEqual([]);
    reset();
    expect(await run(['activity', 'm-nope'])).toBe(1);
    expect(err()).toContain('not found');
  });

  test('ai-runs: kind, status, model, cost, duration, tokens, who; errors one-lined; totals', async () => {
    expect(await run(['ai-runs', 'm-ro'])).toBe(0);
    expect(out()).toContain('2026-10-01 10:00  auto_notes  completed  model-x  $0.1234  42s  1000 in / 200 out  by test-a@example.com');
    expect(out()).toContain('speaker_id  error  model-x  — timed out after 60s');
    expect(out()).toContain('2 run(s), 1 error(s), $0.1234 in total');
    reset();
    expect(await run(['ai-runs', 'm-nope'])).toBe(1);
    expect(err()).toContain('not found');
  });
});

describe('attach / attachment-rm', () => {
  test('a file goes up raw with x-filename / x-title and a real content-type', async () => {
    const f = tmpFile('agenda.pdf', '%PDF-fake agenda');
    expect(await run(['attach', 'm-own', f, '--title', 'Agenda for Meeting X'])).toBe(0);
    const c = writes()[0]!;
    expect(c.path).toBe('/api/transcripts/m-own/attachments');
    expect(c.rawBytes).toBe(16);
    expect(c.headers).toEqual({ 'content-type': 'application/pdf', 'x-filename': 'agenda.pdf', 'x-title': encodeURIComponent('Agenda for Meeting X') });
    expect(out()).toContain('attached #11 "Agenda for Meeting X" (agenda.pdf');
    expect(out()).toContain('text extracted');
  });

  test('--text sends {kind:"text", title, text} as JSON', async () => {
    const f = tmpFile('brief.md', 'Brief for Meeting X');
    expect(await run(['attach', 'm-own', '--text', f, '--title', 'Brief'])).toBe(0);
    expect(writes()[0]).toEqual({ path: '/api/transcripts/m-own/attachments', method: 'POST', body: { kind: 'text', title: 'Brief', text: 'Brief for Meeting X' }, headers: { 'content-type': 'application/json' } });
    expect(out()).toContain('attached #12 "Brief" (text, 19 chars)');
  });

  test('usage + missing file stop before any hop; 403 reader; 404', async () => {
    expect(await run(['attach', 'm-own'])).toBe(1);
    expect(await run(['attach', 'm-own', path.join(tree, 'no-such.pdf')])).toBe(1);
    expect(writes()).toEqual([]);
    const f = tmpFile('a.txt', 'x');
    expect(await run(['attach', 'm-ro', f])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['attach', 'm-nope', f])).toBe(1);
    expect(err()).toContain('not found');
  });

  test('attachment-rm DELETEs; 404 names the attachment; 403 reader', async () => {
    expect(await run(['attachment-rm', 'm-own', '11'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-own/attachments/11', method: 'DELETE' }]);
    expect(out()).toBe('removed attachment #11 from m-own');
    reset();
    expect(await run(['attachment-rm', 'm-own', '99'])).toBe(1);
    expect(err()).toContain('no attachment #99');
    reset();
    expect(await run(['attachment-rm', 'm-ro', '11'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['attachment-rm', 'm-own', 'x'])).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('share --suggestions / --add-suggested', () => {
  test('lists the suggestions with why', async () => {
    expect(await run(['share', 'm-own', '--suggestions'])).toBe(0);
    expect(out()).toContain('Test Person B <test-b@trames.sg>  — was invited');
    expect(writes()).toEqual([]);
  });

  test('--add-suggested shares each through the --add path (directory check, edit default)', async () => {
    expect(await run(['share', 'm-own', '--add-suggested'])).toBe(0);
    expect(calls.some((c) => c.path.startsWith('/api/users/search'))).toBe(true);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-own/shares', method: 'POST', body: { email: 'test-b@trames.sg', name: 'Test Person B', pplId: 21, access: 'edit' } }]);
    expect(out()).toContain('+ shared with test-b@trames.sg (edit)');
    reset();
    expect(await run(['share', 'm-own', '--suggestions'])).toBe(0);
    expect(out()).toContain('already has access');
  });

  test('--access read reaches the share body', async () => {
    expect(await run(['share', 'm-edit', '--add-suggested', '--access', 'read'])).toBe(0);
    expect(writes()[0]!.body).toMatchObject({ email: 'test-b@trames.sg', access: 'read' });
  });

  test('a reader gets no suggestions (the route answers [], not 403): list exit 0, add exit 1; 404', async () => {
    expect(await run(['share', 'm-ro', '--suggestions'])).toBe(0);
    expect(out()).toContain('you have read access');
    reset();
    expect(await run(['share', 'm-ro', '--add-suggested'])).toBe(1);
    expect(writes()).toEqual([]);
    reset();
    expect(await run(['share', 'm-nope', '--suggestions'])).toBe(1);
    expect(err()).toContain('No meeting m-nope visible to you');
  });
});

describe('speakers --guess', () => {
  test('POST speakers/suggest, then the normal speakers output', async () => {
    expect(await run(['speakers', 'm-own', '--guess'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-own/speakers/suggest', method: 'POST' }]);
    expect(out()).toContain('voiceprint match ran on m-own — the speaker-ID pass is running too');
    expect(out()).toContain('speakers of m-own');
    expect(out()).toContain('= Test Person A');
  });

  test('403 reader, 409 not completed, 404; plain speakers makes no POST', async () => {
    expect(await run(['speakers', 'm-ro', '--guess'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['speakers', 'm-wait', '--guess'])).toBe(1);
    expect(err()).toContain('speakers --guess refused: Transcript is not completed yet');
    reset();
    expect(await run(['speakers', 'm-nope', '--guess'])).toBe(1);
    expect(err()).toContain('not found');
    reset();
    expect(await run(['speakers', 'm-own'])).toBe(0);
    expect(writes()).toEqual([]);
  });
});

describe('text --index / edit-line / replace', () => {
  test('text --index prefixes the 0-based index; plain text is unchanged', async () => {
    expect(await run(['text', 'm-own', '--index'])).toBe(0);
    expect(out()).toBe(['[0] [0:00] Test Person A: Hello from Meeting X.', '[1] [1:05] Speaker B: The tramies team ships tramies tools.', '[2] [2:10] Test Person A: Thanks.'].join('\n'));
    reset();
    expect(await run(['text', 'm-own'])).toBe(0);
    expect(out()).toStartWith('[0:00] Test Person A: Hello from Meeting X.');
  });

  test('edit-line PATCHes {utteranceIndex, text}; before = the edited text', async () => {
    expect(await run(['edit-line', 'm-own', '2', '--text', 'Thanks, everyone.'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-own/edits', method: 'PATCH', body: { utteranceIndex: 2, text: 'Thanks, everyone.' }, headers: { 'content-type': 'application/json' } }]);
    expect(out()).toContain('[2] [2:10] Test Person A');
    expect(out()).toContain('before: Thanks, Tramies.');
    expect(out()).toContain('after:  Thanks, everyone.');
  });

  test('edit-line: out of range / bad n stop before the write; 403; 404', async () => {
    expect(await run(['edit-line', 'm-own', '7', '--text', 'x'])).toBe(1);
    expect(err()).toContain('no line 7');
    expect(writes()).toEqual([]);
    expect(await run(['edit-line', 'm-own', 'one', '--text', 'x'])).toBe(1);
    expect(await run(['edit-line', 'm-own', '1'])).toBe(1);
    reset();
    expect(await run(['edit-line', 'm-ro', '1', '--text', 'x'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['edit-line', 'm-nope', '1', '--text', 'x'])).toBe(1);
    expect(err()).toContain('not found');
  });

  test('replace --dry-run lists before/after over the EDITED text, case-insensitive, writes nothing', async () => {
    expect(await run(['replace', 'm-own', 'tramies', 'Trames', '--dry-run'])).toBe(0);
    expect(writes()).toEqual([]);
    expect(out()).toContain('[1] [1:05] Speaker B  (2×)');
    expect(out()).toContain('after:  The Trames team ships Trames tools.');
    expect(out()).toContain('before: Thanks, Tramies.');
    expect(out()).toContain('after:  Thanks, Trames.');
    expect(out()).toContain('dry run — nothing written. 3 match(es) in 2 line(s)');
  });

  test('replace PUTs the whole edit map like "Replace all"', async () => {
    edits['m-own']!['0'] = { text: 'Hello from Meeting X!', speaker: 'B' };
    expect(await run(['replace', 'm-own', 'tramies', 'Trames'])).toBe(0);
    const put = writes()[0]!;
    expect(put).toMatchObject({ path: '/api/transcripts/m-own/edits', method: 'PUT' });
    expect(put.body).toEqual({ edits: { '0': { text: 'Hello from Meeting X!', speaker: 'B' }, '1': { text: 'The Trames team ships Trames tools.' }, '2': { text: 'Thanks, Trames.' } } });
    expect(out()).toContain('replaced 3 match(es) in 2 line(s) of m-own');
  });

  test('a line that ends up equal to the raw words drops its text override, keeps the speaker', async () => {
    edits['m-own'] = { '0': { text: 'Hello from Meeting Y.', speaker: 'B' } };
    expect(await run(['replace', 'm-own', 'Meeting Y', 'Meeting X'])).toBe(0);
    expect(writes()[0]!.body).toEqual({ edits: { '0': { speaker: 'B' } } });
  });

  test('--case: case-sensitive; no match → nothing written; 403; 404', async () => {
    expect(await run(['replace', 'm-own', 'Tramies', 'Trames', '--case', '--dry-run'])).toBe(0);
    expect(out()).toContain('1 match(es) in 1 line(s)');
    reset();
    expect(await run(['replace', 'm-own', 'nothing-like-this', 'x'])).toBe(0);
    expect(out()).toContain('no match for "nothing-like-this"');
    expect(writes()).toEqual([]);
    reset();
    expect(await run(['replace', 'm-ro', 'Meeting', 'Call'])).toBe(1);
    expect(err()).toContain('Forbidden');
    reset();
    expect(await run(['replace', 'm-nope', 'Meeting', 'Call'])).toBe(1);
    expect(err()).toContain('not found');
  });

  test("'' as <with> deletes; --json carries the plan", async () => {
    expect(await run(['replace', 'm-own', ' tramies', '', '--dry-run'], true)).toBe(0);
    const j = JSON.parse(out()) as { matches: number; lines: Array<{ index: number; after: string }>; written: boolean };
    expect(j.matches).toBe(3); // the edited line 2 "Thanks, Tramies." matches too
    expect(j.written).toBe(false);
    expect(j.lines[0]).toMatchObject({ index: 1, after: 'The team ships tools.' });
  });
});

describe('help <verb> for the new verbs', () => {
  test('each verb has its own HELP lines', async () => {
    for (const [verb, needle] of [
      ['set-description', 'set-description <id> --file'],
      ['keep', 'keep <id>[,<id>…]'],
      ['unlink', 'unlink <id>'],
      ['fetch-recording', 'fetch-recording <id>'],
      ['retry', 'retry <id>'],
      ['activity', 'activity <id> [--limit N]'],
      ['ai-runs', 'ai-runs <id>'],
      ['attach', '--text <file|->'],
      ['attachment-rm', 'attachment-rm <id> <attId>'],
      ['edit-line', 'edit-line <id> <n> --text'],
      ['replace', '--dry-run lists the lines'],
      ['trash', '--cancel-queued'],
      ['link', 'link <id> --dismiss'],
      ['share', '--add-suggested'],
      ['speakers', '--guess'],
      ['text', '--index prefixes'],
    ] as const) {
      reset();
      expect(await run(['help', verb])).toBe(0);
      expect(out()).toContain(needle);
    }
  });
});
