/**
 * `darth-cli meetings split` vs 409 `speaker_check_running` (2026-10-27).
 *
 * The server refuses to split while the source's speaker-ID pass runs (a
 * half split off then would be born 'running' and never settle). The pass
 * takes about a minute, so the CLI waits instead of failing: one stderr line
 * per 409, retry every `SPLIT_RETRY.intervalMs`, give up after
 * `SPLIT_RETRY.maxMs` with the server's own sentence; `--no-wait` fails on
 * the first 409. Any other refusal is printed at once, as before.
 *
 * Same harness as cli-meetings-share.test.ts: the subcommand source is copied
 * into a temp tree beside a stand-in `core/args.ts` and run against a fake
 * `ctx.api`. `SPLIT_RETRY` is shortened here so the test takes milliseconds.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-split-'));
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
const mod = (await import(path.join(tree, 'subcommands', 'meetings', 'index.ts'))) as {
  default: Sub;
  SPLIT_RETRY: { intervalMs: number; maxMs: number };
};
const meetings = mod.default;

afterAll(() => rmSync(tree, { recursive: true, force: true }));

// ── the fake server ────────────────────────────────────────────────────────

const RUNNING = {
  error: 'Speaker identification is still running on this meeting — retry in about a minute.',
  code: 'speaker_check_running',
  message: 'Speaker identification is still running on this meeting — retry in about a minute.',
};
const OK = {
  meeting: { id: 'split-x1', title: 'Meeting X, part 2', fromMs: 600_000, toMs: 1_800_000, durationMs: 1_200_000, url: '/transcript/split-x1' },
  moved: { edits: 0, speakerNames: 2 },
  source: { clips: [], notesStale: false },
};

/** What each successive POST answers, in order; the last one repeats. */
let replies: Array<{ status: number; body: unknown }>;
let posts: Array<Record<string, unknown>>;
let stdout: string[];
let stderr: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

function api(_base: string, p: string, init?: RequestInit): Promise<Response> {
  const url = new URL(p, 'https://meetings.test');
  if (url.pathname !== '/api/transcripts/m-x/split' || (init?.method ?? 'GET') !== 'POST') {
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }));
  }
  posts.push(JSON.parse(String(init?.body)));
  const r = replies[Math.min(posts.length - 1, replies.length - 1)]!;
  return Promise.resolve(Response.json(r.body, { status: r.status }));
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

const err = () => stderr.join('\n');
const out = () => stdout.join('\n');
const run = (argv: string[]) => meetings.run(ctx(), ['split', 'm-x', '--from', '10:00', '--to', '30:00', ...argv]);

beforeEach(() => {
  replies = [{ status: 201, body: OK }];
  posts = [];
  stdout = [];
  stderr = [];
  // Milliseconds, not the real 10 s / 3 min: 3 ms between tries, 10 ms in all
  // = at most 3 retries (0, 3, 6, 9 → the 4th would end past maxMs).
  mod.SPLIT_RETRY.intervalMs = 3;
  mod.SPLIT_RETRY.maxMs = 10;
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

describe('split waits out a running speaker pass', () => {
  test('409, 409, 201 → success after two retries, one line per wait', async () => {
    replies = [
      { status: 409, body: RUNNING },
      { status: 409, body: RUNNING },
      { status: 201, body: OK },
    ];
    expect(await run([])).toBe(0);
    expect(posts.length).toBe(3);
    // The same body every time — the retry re-sends the request as given.
    expect(posts.every((b) => b.from === '10:00' && b.to === '30:00')).toBe(true);
    expect(err().match(/still running on m-x — retrying in/g)?.length).toBe(2);
    expect(out()).toContain('split → new meeting split-x1');
  });

  test('--no-wait → the first 409 is final, exit 1, the server sentence printed', async () => {
    replies = [{ status: 409, body: RUNNING }, { status: 201, body: OK }];
    expect(await run(['--no-wait'])).toBe(1);
    expect(posts.length).toBe(1);
    expect(err()).toContain('split refused (HTTP 409)');
    expect(err()).toContain('retry in about a minute');
    expect(err()).toContain('[speaker_check_running]');
    expect(err()).not.toContain('retrying in');
  });

  test('never accepted within maxMs → exit 1 with the server sentence and a gave-up line', async () => {
    replies = [{ status: 409, body: RUNNING }];
    expect(await run([])).toBe(1);
    // 0, 3, 6, 9 ms: four sends, three waits, then the next wait would overrun.
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.length).toBeLessThanOrEqual(4);
    expect(err()).toContain('gave up after');
    expect(err()).toContain('split refused (HTTP 409)');
    expect(err()).toContain('retry in about a minute');
  });

  test('any other 409 is final at once — waiting only helps the speaker pass', async () => {
    replies = [
      { status: 409, body: { error: 'A new transcription is running — wait for it to land before splitting.', code: 'transcribing' } },
      { status: 201, body: OK },
    ];
    expect(await run([])).toBe(1);
    expect(posts.length).toBe(1);
    expect(err()).toContain('[transcribing]');
    expect(err()).not.toContain('retrying in');
  });

  test('a server that puts the code in `error` (the brief’s shape) is waited on too', async () => {
    replies = [{ status: 409, body: { error: 'speaker_check_running', message: 'still running' } }, { status: 201, body: OK }];
    expect(await run([])).toBe(0);
    expect(posts.length).toBe(2);
  });

  test('the shipped clock is 10 s between tries and 3 min in all', () => {
    // The test shortened the live object; the source states the real values.
    const src = readFileSync(path.join(repo, 'cli-subcommand-src', 'index.ts'), 'utf8');
    expect(src).toContain('export const SPLIT_RETRY = { intervalMs: 10_000, maxMs: 180_000 };');
  });
});
