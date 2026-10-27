/**
 * `darth-cli meetings set-speakers` — a speaker is a person (2026-10-27):
 *
 *   - `A="Name"` (name only), `A=email@x` (the server resolves the name),
 *     `A="Name <email@x>"` (both) all parse; anything else is a usage error
 *     before any network hop;
 *   - the PUT carries `email` and the CLI prints what the server STORED
 *     (`name <email>`), not what was typed;
 *   - a name-only re-assignment drops a previous email;
 *   - `--from-invite` lists every unconfirmed speaker whose guess carries an
 *     email and writes nothing without `--yes`; with it, confirms them as
 *     `{customName: guess, email}`; explicit assignments win.
 *
 * Same harness as cli-meetings-share.test.ts: the subcommand source is copied
 * into a temp tree beside a stand-in `core/args.ts` and run against a fake
 * server that resolves emails the way the real route does (directory name).
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..', '..');
const tree = mkdtempSync(path.join(tmpdir(), 'meetings-cli-set-speakers-'));
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

type Label = { originalSpeaker: string; customName: string; description: string; email?: string };
/** The directory the real route resolves canonical names from. */
const DIRECTORY: Record<string, string> = {
  'test-a@example.com': 'Test Person A',
  'test-b@example.com': 'Test Person B',
};

let labels: Label[];
let suggestions: Record<string, { name: string; confidence: number; source?: string; email?: string; emailSource?: 'invite' | 'directory' }>;
let puts: Label[][];
let stdout: string[];
let stderr: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

function api(_base: string, p: string, init?: RequestInit): Promise<Response> {
  const url = new URL(p, 'https://meetings.test');
  const method = init?.method ?? 'GET';
  if (url.pathname === '/api/transcripts/m-x') {
    return Promise.resolve(Response.json({ transcript: { assemblyai_id: 'm-x', speaker_id_status: 'completed', speaker_count: 3 } }));
  }
  if (url.pathname !== '/api/transcripts/m-x/speakers') return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }));
  if (method === 'GET') return Promise.resolve(Response.json({ speakerLabels: labels, suggestions }));
  const body = JSON.parse(String(init?.body)) as { speakerLabels: Label[] };
  for (const l of body.speakerLabels) {
    if (l.email !== undefined && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(l.email)) {
      return Promise.resolve(Response.json({ error: 'Invalid speakerLabels' }, { status: 400 }));
    }
  }
  // The route's resolution: a sent name is KEPT (the email never renames); a
  // nameless `A=email` takes the same-email suggestion, else the directory.
  const stored = body.speakerLabels.map((l) => {
    if (!l.email) return l;
    const email = l.email.toLowerCase();
    const sameEmailGuess = suggestions[l.originalSpeaker]?.email === email ? suggestions[l.originalSpeaker]!.name : null;
    const customName = l.customName?.trim() || sameEmailGuess || DIRECTORY[email] || email.split('@')[0]!;
    return { ...l, email, customName };
  });
  puts.push(body.speakerLabels);
  labels = stored;
  return Promise.resolve(Response.json({ speakerLabels: stored }));
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
const run = (argv: string[]) => meetings.run(ctx(), ['set-speakers', ...argv]);

beforeEach(() => {
  labels = [{ originalSpeaker: 'C', customName: 'Confirmed Person C', description: 'the host', email: 'test-c@example.com' }];
  suggestions = {
    A: { name: 'Test Person A', confidence: 0.9, source: 'voice', email: 'test-a@example.com', emailSource: 'invite' },
    B: { name: 'Test Person B', confidence: 0.88, source: 'voice', email: 'test-b@example.com', emailSource: 'directory' },
    D: { name: 'Nobody Known', confidence: 0.7, source: 'voice' }, // no email: ambiguous / not on the invite
  };
  puts = [];
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

describe('the three assignment forms', () => {
  test('A="Name" sends a name only; printed as stored', async () => {
    expect(await run(['m-x', 'A=Interviewer #1'])).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.find((l) => l.originalSpeaker === 'A')).toEqual({ originalSpeaker: 'A', customName: 'Interviewer #1', description: '' });
    expect(out()).toContain('A          = Interviewer #1');
  });

  test('A=email sends the person; the server fills the name (same-email guess first) and the CLI prints name <email>', async () => {
    expect(await run(['m-x', 'A=Test-A@Example.com'])).toBe(0);
    expect(puts[0]!.find((l) => l.originalSpeaker === 'A')).toEqual({ originalSpeaker: 'A', customName: '', description: '', email: 'test-a@example.com' });
    expect(out()).toContain('A          = Test Person A <test-a@example.com>');
    // No guess for that email on this speaker → the directory spelling.
    suggestions = {};
    expect(await run(['m-x', 'B=test-b@example.com'])).toBe(0);
    expect(out()).toContain('B          = Test Person B <test-b@example.com>');
  });

  test('A="Name <email>" sends both; the SENT name is what is stored — the email never renames', async () => {
    expect(await run(['m-x', 'B=Someone Typed <test-b@example.com>'])).toBe(0);
    expect(puts[0]!.find((l) => l.originalSpeaker === 'B')).toEqual({ originalSpeaker: 'B', customName: 'Someone Typed', description: '', email: 'test-b@example.com' });
    expect(out()).toContain('B          = Someone Typed <test-b@example.com>');
    expect(out()).not.toContain('Test Person B <test-b@example.com>');
  });

  test('an unknown email with no directory row keeps the typed name', async () => {
    expect(await run(['m-x', 'A=New Person <new@example.com>'])).toBe(0);
    expect(out()).toContain('A          = New Person <new@example.com>');
  });

  test('a name-only re-assignment drops the previous email; the description is kept', async () => {
    expect(await run(['m-x', 'C=Different Person'])).toBe(0);
    const c = puts[0]!.find((l) => l.originalSpeaker === 'C')!;
    expect(c).toEqual({ originalSpeaker: 'C', customName: 'Different Person', description: 'the host' });
    expect('email' in c).toBe(false);
  });

  test('the existing confirmed label is merged, not lost', async () => {
    expect(await run(['m-x', 'A=test-a@example.com'])).toBe(0);
    expect(puts[0]!.map((l) => l.originalSpeaker).sort()).toEqual(['A', 'C']);
    expect(puts[0]!.find((l) => l.originalSpeaker === 'C')?.email).toBe('test-c@example.com');
  });

  test('a bad assignment or a bad angle-bracket email is a usage error before any network hop', async () => {
    expect(await run(['m-x', 'justaname'])).toBe(1);
    expect(err()).toContain("bad assignment 'justaname'");
    expect(await run(['m-x', 'A=Name <not-an-email>'])).toBe(1);
    expect(puts).toEqual([]);
    expect(await run([])).toBe(1);
    expect(err()).toContain('usage:');
  });
});

describe('--from-invite', () => {
  test('dry run: a table of every unconfirmed speaker whose guess names one person; nothing written', async () => {
    expect(await run(['m-x', '--from-invite'])).toBe(0);
    expect(puts).toEqual([]);
    expect(out()).toContain('would confirm from the invite on m-x:');
    expect(out()).toContain('A          = Test Person A <test-a@example.com>');
    expect(out()).toContain('B          = Test Person B <test-b@example.com>');
    expect(out()).not.toContain('Nobody Known'); // no email → not a pick
    expect(out()).not.toContain('Confirmed Person C'); // already confirmed
    expect(out()).toContain('dry run — nothing written. Re-run with --yes to confirm.');
  });

  test('--yes writes {customName: guess, email} for each pick, keeps C, leaves D alone', async () => {
    expect(await run(['m-x', '--from-invite', '--yes'])).toBe(0);
    expect(puts).toHaveLength(1);
    const sent = puts[0]!;
    expect(sent.find((l) => l.originalSpeaker === 'A')).toEqual({ originalSpeaker: 'A', customName: 'Test Person A', description: '', email: 'test-a@example.com' });
    expect(sent.find((l) => l.originalSpeaker === 'B')).toEqual({ originalSpeaker: 'B', customName: 'Test Person B', description: '', email: 'test-b@example.com' });
    expect(sent.find((l) => l.originalSpeaker === 'C')?.customName).toBe('Confirmed Person C');
    expect(sent.find((l) => l.originalSpeaker === 'D')).toBeUndefined();
    expect(out()).toContain('3 speaker(s) confirmed');
  });

  test('an explicit assignment on the same command wins over the invite pick', async () => {
    expect(await run(['m-x', '--from-invite', '--yes', 'A=Overridden Person'])).toBe(0);
    const a = puts[0]!.find((l) => l.originalSpeaker === 'A')!;
    expect(a.customName).toBe('Overridden Person');
    expect('email' in a).toBe(false);
    expect(puts[0]!.find((l) => l.originalSpeaker === 'B')?.email).toBe('test-b@example.com');
  });

  test('the id after the boolean flag is handed back (parseArgs swallows it)', async () => {
    expect(await run(['--from-invite', 'm-x'])).toBe(0);
    expect(out()).toContain('would confirm from the invite on m-x:');
  });

  test('nothing to confirm → says so, exit 0, no write', async () => {
    suggestions = { D: { name: 'Nobody Known', confidence: 0.7 } };
    expect(await run(['m-x', '--from-invite', '--yes'])).toBe(0);
    expect(puts).toEqual([]);
    expect(out()).toContain('nothing to confirm from the invite on m-x');
  });
});

describe('speakers <id> shows the person', () => {
  test('confirmed and guessed lines carry <email> and where the identity came from, and hint at --from-invite', async () => {
    expect(await meetings.run(ctx(), ['speakers', 'm-x'])).toBe(0);
    expect(out()).toContain('C          = Confirmed Person C <test-c@example.com>   [confirmed]');
    expect(out()).toContain('A          ? Test Person A <test-a@example.com> (90%, voice, on the invite)');
    expect(out()).toContain('B          ? Test Person B <test-b@example.com> (88%, voice, in the directory)');
    expect(out()).toContain('D          ? Nobody Known (70%, voice, no email match)');
    expect(out()).toContain('set-speakers m-x --from-invite');
  });
});
