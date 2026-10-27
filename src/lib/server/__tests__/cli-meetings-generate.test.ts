/**
 * CLI ↔ UI parity (task 05): the web UI's write actions an agent could not
 * reach — `generate` (the "Generate / Regenerate summary & report" dialog,
 * with its options), `hold` (the automatic summary's Hold), `add-person`
 * (the "+ Person" dialog) — and `help <verb>`.
 *
 * Same harness as the other cli-meetings-*.test.ts files: the subcommand
 * source copied into a temp tree beside a stand-in `core/args.ts`, run
 * against a fake server that answers like the real routes (success, 403 for a
 * reader, 404, 409) and records every request body.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-generate-'));
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

type Row = { assemblyai_id: string; title: string; status: string; access: 'owner' | 'edit' | 'read'; auto_notes: string | null; auto_report: string | null; autoReview?: { passed: boolean | null; mode?: string; pending?: true } | null };
let rows: Record<string, Row>;
let calls: Array<{ path: string; method: string; body?: Record<string, unknown> }>;
let people: Array<{ id: number; name: string; email: string; source: 'trames' | 'custom' }>;
let stdout: string[];
let stderr: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

function api(_base: string, p: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ path: p, method, body });
  const url = new URL(p, 'https://meetings.test');
  if (url.pathname === '/api/people' && method === 'POST') {
    const email = String(body?.email ?? '').toLowerCase();
    const existing = people.find((x) => x.email === email);
    if (existing) return Promise.resolve(Response.json({ error: 'exists', person: existing }, { status: 409 }));
    const person = { id: people.length + 1, name: String(body?.name), email, source: 'custom' as const };
    people.push(person);
    return Promise.resolve(Response.json({ person }, { status: 201 }));
  }
  const m = url.pathname.match(/^\/api\/transcripts\/([^/]+)(\/report|\/notes\/hold)?$/);
  const row = m ? rows[m[1]!] : undefined;
  if (!m || !row) return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }));
  if (!m[2]) return Promise.resolve(Response.json({ transcript: { ...row, gmeet_context: row.autoReview ? { autoReview: row.autoReview } : null } }));
  if (row.access === 'read') return Promise.resolve(Response.json({ error: 'Read-only access' }, { status: 403 }));
  if (m[2] === '/report' && method === 'POST') {
    if (row.status !== 'completed') return Promise.resolve(Response.json({ error: 'Transcript is not completed yet' }, { status: 409 }));
    if (typeof body?.runAt === 'string') return Promise.resolve(Response.json({ status: 'scheduled', runAt: body.runAt }));
    return Promise.resolve(Response.json({ status: 'running' }));
  }
  if (m[2] === '/report' && method === 'DELETE') return Promise.resolve(Response.json({ cancelled: true }));
  if (m[2] === '/notes/hold' && method === 'POST') {
    const ex = row.autoReview;
    if (ex && ex.mode !== 'held') {
      const why = ex.pending ? 'The summary is being written right now.' : ex.passed ? 'The summary was already written automatically.' : 'The automatic pass already ran on this meeting; the review gate stays.';
      return Promise.resolve(Response.json({ error: `${why} Nothing left to hold.` }, { status: 409 }));
    }
    row.autoReview = { passed: false, mode: 'held' };
    return Promise.resolve(Response.json({ ok: true, held: true, autoProceedAt: null }));
  }
  return Promise.resolve(Response.json({ error: 'bad' }, { status: 400 }));
}

function ctx(json = false) {
  return {
    config: { email: 'test-a@example.com', meetingsUrl: 'https://meetings.test', timezone: 'Asia/Singapore' },
    flags: {},
    json,
    consent: null,
    api,
    expectJson: async (res: Promise<Response> | Response) => {
      const r = await res;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    requireWrite: () => {},
    requireAdmin: () => {},
    print: (data: unknown, human: () => void) => (json ? console.log(JSON.stringify(data)) : human()),
  };
}

const out = () => stdout.join('\n');
const err = () => stderr.join('\n');
const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  rows = {
    'm-new': { assemblyai_id: 'm-new', title: 'Meeting X', status: 'completed', access: 'owner', auto_notes: null, auto_report: null },
    'm-has': { assemblyai_id: 'm-has', title: 'Meeting Y', status: 'completed', access: 'edit', auto_notes: '# notes', auto_report: '# report' },
    'm-ro': { assemblyai_id: 'm-ro', title: 'Meeting Z', status: 'completed', access: 'read', auto_notes: null, auto_report: null },
    'm-run': { assemblyai_id: 'm-run', title: 'Meeting W', status: 'processing', access: 'owner', auto_notes: null, auto_report: null },
  };
  people = [{ id: 1, name: 'Test Person A', email: 'test-a@example.com', source: 'trames' }];
  calls = [];
  stdout = [];
  stderr = [];
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

describe('generate — the dialog, as a verb', () => {
  test('without --yes: the plan, nothing started', async () => {
    expect(await meetings.run(ctx(), ['generate', 'm-new', '--instructions', 'focus on decisions', '--no-video'])).toBe(0);
    expect(writes()).toEqual([]);
    expect(out()).toContain('generate summary + detailed report for m-new "Meeting X"');
    expect(out()).toContain('report: text only (--no-video)');
    expect(out()).toContain('instructions: "focus on decisions"');
    expect(out()).toContain('when: now');
    expect(out()).toContain('dry run — nothing started. Re-run with --yes to start it.');
  });

  test('--yes POSTs the dialog body (useVideo, instructions) and reports running', async () => {
    expect(await meetings.run(ctx(), ['generate', 'm-new', '--yes', '--instructions', 'five bullets'])).toBe(0);
    const post = writes()[0]!;
    expect(post.path).toBe('/api/transcripts/m-new/report');
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({ useVideo: true, instructions: 'five bullets' });
    expect(out()).toContain('generating summary + detailed report for m-new');
  });

  test('--no-video → useVideo:false; no instructions → key absent', async () => {
    expect(await meetings.run(ctx(), ['generate', 'm-new', '--yes', '--no-video'])).toBe(0);
    expect(writes()[0]!.body).toEqual({ useVideo: false });
  });

  test('existing notes → it says REGENERATE / regenerating; `regenerate` is an alias', async () => {
    expect(await meetings.run(ctx(), ['regenerate', 'm-has'])).toBe(0);
    expect(out()).toContain('REGENERATE summary + detailed report for m-has');
    expect(out()).toContain('the existing notes/report are replaced when the run lands');
    stdout = [];
    expect(await meetings.run(ctx(), ['regenerate', 'm-has', '--yes'])).toBe(0);
    expect(out()).toContain('regenerating summary + detailed report for m-has');
  });

  test('--run-at: an ISO instant is forwarded; "tonight" is the next 02:00 local; junk is refused before any hop', async () => {
    expect(await meetings.run(ctx(), ['generate', 'm-new', '--yes', '--run-at', '2026-11-01T18:00:00.000Z'])).toBe(0);
    expect(writes()[0]!.body).toEqual({ useVideo: true, runAt: '2026-11-01T18:00:00.000Z' });
    expect(out()).toContain('scheduled: summary + detailed report for m-new run at');
    calls = [];
    expect(await meetings.run(ctx(), ['generate', 'm-new', '--yes', '--run-at', 'tonight'])).toBe(0);
    const runAt = String(writes()[0]!.body!.runAt);
    expect(new Date(runAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(runAt).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    calls = [];
    expect(await meetings.run(ctx(), ['generate', 'm-new', '--yes', '--run-at', 'soonish'])).toBe(1);
    expect(writes()).toEqual([]);
    expect(err()).toContain("--run-at: 'soonish' is not 'tonight' or an ISO instant");
  });

  test('a reader gets a clear 403; a wrong id a 404; a not-completed meeting stops locally', async () => {
    expect(await meetings.run(ctx(), ['generate', 'm-ro', '--yes'])).toBe(1);
    expect(err()).toContain('Forbidden: Read-only access');
    expect(err()).toContain('EDIT access to m-ro');
    stderr = [];
    expect(await meetings.run(ctx(), ['generate', 'm-nope', '--yes'])).toBe(1);
    expect(err()).toContain('no meeting m-nope visible to you');
    stderr = [];
    calls = [];
    expect(await meetings.run(ctx(), ['generate', 'm-run', '--yes'])).toBe(1);
    expect(err()).toContain('m-run is not completed yet (status processing)');
    expect(writes()).toEqual([]); // stopped locally, before the POST
  });

  test('--cancel DELETEs the report marker', async () => {
    expect(await meetings.run(ctx(), ['generate', 'm-new', '--cancel'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-new/report', method: 'DELETE', body: undefined }]);
    expect(out()).toContain('cancelled the scheduled/queued run on m-new');
  });

  test('--json prints the reply plus what was asked', async () => {
    expect(await meetings.run(ctx(true), ['generate', 'm-new', '--yes', '--no-video'])).toBe(0);
    expect(JSON.parse(out())).toEqual({ status: 'running', id: 'm-new', regenerate: false, useVideo: false });
  });
});

describe('hold — the automatic summary, stopped', () => {
  test('200 → held line; the gate stays', async () => {
    expect(await meetings.run(ctx(), ['hold', 'm-new'])).toBe(0);
    expect(writes()).toEqual([{ path: '/api/transcripts/m-new/notes/hold', method: 'POST', body: undefined }]);
    expect(out()).toContain('held m-new — the summary will not be written automatically');
  });

  test('409 once it already ran, with the server reason; 403 for a reader; 404 for a wrong id', async () => {
    rows['m-new']!.autoReview = { passed: true, mode: 'grace' };
    expect(await meetings.run(ctx(), ['hold', 'm-new'])).toBe(1);
    expect(err()).toContain('hold refused: The summary was already written automatically. Nothing left to hold.');
    stderr = [];
    expect(await meetings.run(ctx(), ['hold', 'm-ro'])).toBe(1);
    expect(err()).toContain('Forbidden');
    stderr = [];
    expect(await meetings.run(ctx(), ['hold', 'm-nope'])).toBe(1);
    expect(err()).toContain('not found');
    expect(await meetings.run(ctx(), ['hold'])).toBe(1);
  });
});

describe('add-person — the "+ Person" dialog', () => {
  test('201 → added; the hint shows how to use them as a speaker', async () => {
    expect(await meetings.run(ctx(), ['add-person', 'Test Person B', 'Test-B@Example.com'])).toBe(0);
    expect(writes()[0]).toEqual({ path: '/api/people', method: 'POST', body: { name: 'Test Person B', email: 'test-b@example.com' } });
    expect(out()).toContain('added Test Person B <test-b@example.com> to the people directory');
    expect(out()).toContain('set-speakers <id> A=test-b@example.com');
  });

  test('409 existing → the existing record is the answer, exit 0, nothing forked', async () => {
    expect(await meetings.run(ctx(), ['add-person', 'Someone Else', 'test-a@example.com'])).toBe(0);
    expect(people).toHaveLength(1);
    expect(out()).toContain('test-a@example.com already belongs to Test Person A (Trames directory)');
  });

  test('usage errors before any hop', async () => {
    expect(await meetings.run(ctx(), ['add-person', 'Only Name'])).toBe(1);
    expect(await meetings.run(ctx(), ['add-person', 'Test Person C', 'not-an-email'])).toBe(1);
    expect(err()).toContain("'not-an-email' is not an email address");
    expect(writes()).toEqual([]);
  });
});

describe('help <verb>', () => {
  test('one verb’s lines, including segments sub-verbs; unknown verb → exit 1', async () => {
    expect(await meetings.run(ctx(), ['help', 'generate'])).toBe(0);
    expect(out()).toContain('generate <id> [--instructions');
    expect(out()).toContain("'regenerate' is an alias");
    expect(out()).not.toContain('hold <id>');
    stdout = [];
    expect(await meetings.run(ctx(), ['help', 'hold'])).toBe(0);
    expect(out()).toContain('hold <id>');
    expect(out()).not.toContain('add-person');
    stdout = [];
    expect(await meetings.run(ctx(), ['help', 'segments'])).toBe(0);
    expect(out()).toContain('segments');
    expect(await meetings.run(ctx(), ['help', 'no-such-verb'])).toBe(1);
  });
});
