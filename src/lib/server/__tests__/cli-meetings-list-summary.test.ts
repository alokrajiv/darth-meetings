/**
 * `darth-cli meetings list --no-summary` / `--summary` (2026-10-27): the
 * shared `summary=missing|failed` filter rides the v2 listing like every
 * other filter flag — forwarded verbatim, validated before any network hop,
 * refused where the server would drop it (calendar), and `--no-summary` is
 * shorthand for `--summary missing`.
 *
 * Same harness as cli-meetings-share.test.ts: the subcommand source is copied
 * into a temp tree beside a stand-in `core/args.ts` and run against a fake
 * `ctx.api` that records every request URL.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-list-summary-'));
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

// ── the fake server: one empty v2 page, every URL recorded ───────────────────

let urls: string[];
let stdout: string[];
let stderr: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

function api(_base: string, p: string): Promise<Response> {
  urls.push(p);
  const url = new URL(p, 'https://meetings.test');
  if (url.pathname === '/api/transcripts' && url.searchParams.get('v') === '2') {
    return Promise.resolve(
      Response.json({ days: [], counts: { all: 0, mine: 0, shared: 0, trash: 0, scratch: 0 }, nextCursor: null, hasMore: false })
    );
  }
  if (url.pathname === '/api/transcripts') return Promise.resolve(Response.json({ transcripts: [] }));
  if (url.pathname === '/api/calendar-meetings') {
    return Promise.resolve(Response.json({ days: [], counts: {}, nextCursor: null, hasMore: false }));
  }
  return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }));
}

function ctx() {
  return {
    config: { email: 'test-a@example.com', meetingsUrl: 'https://meetings.test', timezone: 'Asia/Singapore' },
    flags: {},
    json: false,
    consent: null,
    api,
    expectJson: async (res: Promise<Response> | Response) => {
      const r = await res;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    requireWrite: () => {},
    requireAdmin: () => {},
    print: (_data: unknown, human: () => void) => human(),
  };
}

const err = () => stderr.join('\n');
const listUrl = () => urls.find((u) => u.includes('v=2'));
const summaryParam = () => (listUrl() ? new URL(listUrl()!, 'https://meetings.test').searchParams.get('summary') : null);

beforeEach(() => {
  urls = [];
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

describe('list --summary / --no-summary', () => {
  test('--no-summary rides the v2 listing as summary=missing', async () => {
    expect(await meetings.run(ctx(), ['list', '--no-summary'])).toBe(0);
    expect(summaryParam()).toBe('missing');
    // A filter flag means the v2 path, never the legacy full array.
    expect(urls.some((u) => /\/api\/transcripts(\?|$)/.test(u) && !u.includes('v=2'))).toBe(false);
  });

  test('--summary failed and the comma-OR list are forwarded verbatim', async () => {
    expect(await meetings.run(ctx(), ['list', '--summary', 'failed'])).toBe(0);
    expect(summaryParam()).toBe('failed');
    urls = [];
    expect(await meetings.run(ctx(), ['list', '--summary', 'missing,failed'])).toBe(0);
    expect(summaryParam()).toBe('missing,failed');
  });

  test('--no-summary together with --summary missing is fine; with another value it is a contradiction', async () => {
    expect(await meetings.run(ctx(), ['list', '--summary', 'missing', '--no-summary'])).toBe(0);
    expect(summaryParam()).toBe('missing');
    urls = [];
    expect(await meetings.run(ctx(), ['list', '--summary', 'failed', '--no-summary'])).toBe(1);
    expect(urls).toEqual([]);
    expect(err()).toContain('drop one of the two');
  });

  test('an unknown value fails before any network hop', async () => {
    expect(await meetings.run(ctx(), ['list', '--summary', 'none'])).toBe(1);
    expect(urls).toEqual([]);
    expect(err()).toContain('--summary: unknown value(s) none');
    expect(err()).toContain('missing|failed');
  });

  test('a token swallowed by the boolean flag is an error, not a lost positional', async () => {
    // parseArgs eats the next non-flag token as the value of --no-summary.
    expect(await meetings.run(ctx(), ['list', '--no-summary', 'oops'])).toBe(1);
    expect(urls).toEqual([]);
    expect(err()).toContain('--no-summary takes no value');
  });

  test('--scratch refuses it like every other filter', async () => {
    expect(await meetings.run(ctx(), ['list', '--scratch', '--no-summary'])).toBe(1);
    expect(urls).toEqual([]);
    expect(err()).toContain('--no-summary');
  });

  test('calendar views never see it — the server would drop it silently', async () => {
    expect(await meetings.run(ctx(), ['calendar', '--no-summary'])).toBe(1);
    expect(urls).toEqual([]);
    expect(err()).toContain('--no-summary is not supported by this command');
    stderr = [];
    expect(await meetings.run(ctx(), ['calendar', '--summary', 'missing'])).toBe(1);
    expect(err()).toContain('--summary is not supported by this command');
  });
});
