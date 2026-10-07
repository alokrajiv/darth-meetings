/**
 * Consents (CONTRACT §5, meetings subcommand): the darth-cli `meetings`
 * settings verbs — `auto-sync off|mine|all`, `notify <kind> on|off`,
 * `offline prefs --set` — need `--consent` (ctx.consent, parsed by the CLI
 * core); the retired `--i-have-got-consent-from-human-user` flag and a
 * missing consent both print the request command and exit 6.
 *
 * cli-subcommand-src/index.ts is built inside darth-cli
 * (src/subcommands/meetings/), so it is copied into a temp tree next to a
 * stand-in `core/args.ts` (the CLI core's parseArgs/str, verbatim) and run
 * with a mock Ctx.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-consent-'));
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

type Call = { path: string; method: string; body?: unknown };
let calls: Call[] = [];
let stderr: string[] = [];
let errSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;

function ctx(consent: { id: string; text: string } | null) {
  return {
    config: { email: 'alok@trames.sg', meetingsUrl: 'https://meetings.test' },
    flags: {},
    json: false,
    consent,
    api: async (_base: string, p: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ path: p, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (p === '/api/notify-prefs' && method === 'GET') {
        return Response.json({ prefs: {}, kinds: ['transcript_ready', 'shared'], labels: {} });
      }
      if (p === '/api/auto-sync') return Response.json({ autoSync: { scope: 'all', mode: 'video', report: 'later', since: 'x', providers: { gmeet: true, teams: true } } });
      if (p === '/api/notify-prefs') return Response.json({ prefs: { transcript_ready: false } });
      return Response.json({ prefs: { transcripts: 10, audio: 1, video: 1 }, max: {} });
    },
    expectJson: async (res: Promise<Response> | Response) => (await res).json(),
    requireWrite: () => {},
    requireAdmin: () => {},
    print: (_d: unknown, human: () => void) => human(),
  };
}

const CONSENT = { id: 'dcon_abcdefghjkmn', text: 'Change my Darth Meetings settings (auto-sync) as Alok asked' };
const RETIRED = '--i-have-got-consent-from-human-user';
const writes = () => calls.filter((c) => c.method === 'PUT');
const err = () => stderr.join('\n');

beforeEach(() => {
  calls = [];
  stderr = [];
  errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
});

const VERBS = [
  { name: 'auto-sync all', argv: ['auto-sync', 'all'], area: 'auto-sync', put: '/api/auto-sync' },
  { name: 'notify transcript_ready off', argv: ['notify', 'transcript_ready', 'off'], area: 'notifications', put: '/api/notify-prefs' },
  { name: 'offline prefs --set', argv: ['offline', 'prefs', '--set', 'transcripts=10'], area: 'offline prefs', put: '/api/offline/prefs' },
] as const;

for (const v of VERBS) {
  describe(`darth-cli meetings ${v.name}`, () => {
    const request = `darth-cli consent request --service meetings --action settings --target - --text 'Change my Darth Meetings settings (${v.area}) as Alok asked'`;

    test('the retired bare flag → exit 6, "retired" + the request command, nothing written', async () => {
      const code = await meetings.run(ctx(null), [...v.argv, RETIRED]);
      expect(code).toBe(6);
      expect(err()).toContain('this flag is retired');
      expect(err()).toContain(request);
      expect(writes().length).toBe(0);
    });

    test('the retired flag even next to a valid --consent → still exit 6 (drop the old flag)', async () => {
      const code = await meetings.run(ctx(CONSENT), [...v.argv, RETIRED]);
      expect(code).toBe(6);
      expect(writes().length).toBe(0);
    });

    test('no consent → exit 6 with the request command, nothing written', async () => {
      const code = await meetings.run(ctx(null), [...v.argv]);
      expect(code).toBe(6);
      expect(err()).toContain(request);
      expect(err()).toContain("--consent '<dcon_id>: <text>'");
      expect(writes().length).toBe(0);
    });

    test('with ctx.consent → proceeds to the PUT', async () => {
      const code = await meetings.run(ctx(CONSENT), [...v.argv]);
      expect(code).toBe(0);
      expect(writes().map((c) => c.path)).toEqual([v.put]);
    });
  });
}

test('the retired flag BEFORE the positional does not swallow it (liftBoolFlags) and is refused', async () => {
  const code = await meetings.run(ctx(null), ['auto-sync', RETIRED, 'all']);
  expect(code).toBe(6);
  expect(err()).toContain('this flag is retired');
});

test('reads stay ungated: plain auto-sync / notify / offline prefs need no consent', async () => {
  expect(await meetings.run(ctx(null), ['auto-sync'])).toBe(0);
  expect(await meetings.run(ctx(null), ['notify'])).toBe(0);
  expect(await meetings.run(ctx(null), ['offline', 'prefs'])).toBe(0);
  expect(writes().length).toBe(0);
});
