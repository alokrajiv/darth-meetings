import { promises as fs } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/**
 * Which Claude login a headless run uses — shared with Darth Chat.
 *
 * Darth Chat (../chat, SPEC §20.120 + the p1/p2/p3 priority rule) owns the
 * Claude logins on .6: a profile is `<CLAUDE_CREDS_DIR>/<profile>.token`
 * (minted with `claude setup-token`, mode 600, one printable line) and the
 * admin keeps ONE allocation (`claude_allocation` row `live`: default, pins,
 * rotation) plus per-person overrides (`claude_allocation_overrides`) that it
 * writes when a login is exhausted. The claude-usage-poller reports usage per
 * profile, so whatever meetings burns on a profile shows up in chat's figures.
 *
 * Meetings does not keep a login of its own any more (the VM's `~/.claude`
 * login hit its 30-day refresh ceiling on 2026-10-08 and every AI run failed
 * with "OAuth session expired"). Instead, at every run start it FOLLOWS the
 * profile chat would hand `MW_CLAUDE_FOLLOW_EMAIL` (Alok's chat identity):
 *
 *   live override for that person  →  else their pin  →  else the default,
 *   then the rotation order as fallbacks (only when auto-swap is on),
 *   keeping only profiles whose `.token` passes chat's file check.
 *
 * The token is injected per run as CLAUDE_CODE_OAUTH_TOKEN (the SDK's `env`
 * option — note it REPLACES process.env, so we spread it). A run that fails
 * with an auth or rate-limit error is retried once per remaining candidate
 * (claude-agent.ts). Nothing here writes to chat's tables: the role is
 * read-only (deploy/vm-setup-chat-ro.sh) and meetings never moves a person's
 * override — chat's own ticker does that.
 *
 * Unset `MW_CLAUDE_CREDS_DIR` / `MW_DARTH_CHAT_DATABASE_URL` → `[]`, and the
 * runner falls back to whatever login the host has (laptop dev, tests).
 */

export interface ClaudeProfileChoice {
  profile: string;
  token: string;
  /** Why this profile is a candidate — for logs and ai_runs. */
  source: 'override' | 'pin' | 'default' | 'rotation';
}

export const TOKEN_MAX_CHARS = 4096;
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const ALLOCATION_CACHE_MS = 30_000;

type AllocationRow = {
  default_profile: string | null;
  pins: Record<string, string> | null;
  auto: { order?: string[]; enabled?: boolean } | null;
};

let chatSql: ReturnType<typeof postgres> | null = null;
function chatDb(): ReturnType<typeof postgres> | null {
  const url = process.env.MW_DARTH_CHAT_DATABASE_URL;
  if (!url) return null;
  if (!chatSql) {
    chatSql = postgres(url, { max: 1, idle_timeout: 30, connect_timeout: 5 });
  }
  return chatSql;
}

function credsDir(): string | null {
  const d = process.env.MW_CLAUDE_CREDS_DIR;
  return d ? d : null;
}

export function tokenPath(dir: string, profile: string): string {
  return path.join(dir, `${profile}.token`);
}

/**
 * Chat's token-file check (creds.ts `readProfileToken`): a regular file, mode
 * 600, exactly one printable-ASCII line (trailing newline ok), ≤ 4096 chars.
 */
export async function readProfileToken(
  file: string
): Promise<{ state: 'valid'; token: string } | { state: 'missing' } | { state: 'invalid'; reason: string }> {
  let st;
  try {
    st = await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', reason: `stat failed: ${(err as Error).message}` };
  }
  if (!st.isFile()) return { state: 'invalid', reason: 'not a regular file' };
  if ((st.mode & 0o077) !== 0) {
    return {
      state: 'invalid',
      reason: `mode ${(st.mode & 0o777).toString(8).padStart(3, '0')}: must be 600 (chmod 600)`,
    };
  }
  if (st.size > TOKEN_MAX_CHARS + 2) return { state: 'invalid', reason: 'file too large for one token' };
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split('\n').filter((l, i, a) => !(l === '' && i === a.length - 1));
  if (lines.length !== 1) return { state: 'invalid', reason: `expected one line, got ${lines.length}` };
  const token = lines[0].replace(/\r$/, '');
  if (!token || token.length > TOKEN_MAX_CHARS) return { state: 'invalid', reason: 'empty or too long' };
  if (!/^[\x21-\x7e]+$/.test(token)) return { state: 'invalid', reason: 'token must be printable ASCII without spaces' };
  return { state: 'valid', token };
}

let allocationCache: { at: number; rows: { allocation: AllocationRow | null; override: string | null; email: string } } | null = null;

async function loadAllocation(email: string): Promise<{ allocation: AllocationRow | null; override: string | null; email: string }> {
  const now = Date.now();
  if (allocationCache && allocationCache.rows.email === email && now - allocationCache.at < ALLOCATION_CACHE_MS) {
    return allocationCache.rows;
  }
  const db = chatDb();
  if (!db) return { allocation: null, override: null, email };
  const [allocRows, overrideRows] = await Promise.all([
    db<AllocationRow[]>`SELECT default_profile, pins, auto FROM claude_allocation WHERE id = 'live'`,
    db<Array<{ profile: string }>>`
      SELECT o.profile
      FROM claude_allocation_overrides o
      JOIN envs e ON e.user_id = o.user_id
      WHERE lower(e.email) = lower(${email}) AND o.until > now()
      ORDER BY o.created_at DESC
      LIMIT 1
    `,
  ]);
  const rows = { allocation: allocRows[0] ?? null, override: overrideRows[0]?.profile ?? null, email };
  allocationCache = { at: now, rows };
  return rows;
}

/** Drop the 30 s allocation cache (after a failed run, so the retry re-reads chat's state). */
export function invalidateClaudeProfileCache(): void {
  allocationCache = null;
}

/**
 * The ordered candidates for one run, best first, each with a usable token.
 * Empty when the shared-login env is not configured (host login is used).
 */
export async function resolveClaudeProfiles(): Promise<ClaudeProfileChoice[]> {
  const dir = credsDir();
  if (!dir) return [];
  const email = process.env.MW_CLAUDE_FOLLOW_EMAIL || '';
  let allocation: AllocationRow | null = null;
  let override: string | null = null;
  if (email && chatDb()) {
    try {
      ({ allocation, override } = await loadAllocation(email));
    } catch (err) {
      console.warn('[claude-profile] chat allocation unreadable, using the default from env only:', (err as Error).message);
    }
  }
  const ordered: Array<{ profile: string; source: ClaudeProfileChoice['source'] }> = [];
  const push = (profile: string | null | undefined, source: ClaudeProfileChoice['source']) => {
    if (!profile || !PROFILE_NAME_RE.test(profile)) return;
    if (ordered.some((o) => o.profile === profile)) return;
    ordered.push({ profile, source });
  };
  const autoOn = allocation?.auto?.enabled !== false;
  if (autoOn) push(override, 'override');
  const pin = allocation?.pins?.[email.toLowerCase()] ?? allocation?.pins?.[email];
  push(pin, 'pin');
  push(allocation?.default_profile ?? process.env.MW_CLAUDE_PROFILE_DEFAULT, 'default');
  if (autoOn) for (const p of allocation?.auto?.order ?? []) push(p, 'rotation');

  const out: ClaudeProfileChoice[] = [];
  for (const o of ordered) {
    const t = await readProfileToken(tokenPath(dir, o.profile));
    if (t.state === 'valid') out.push({ profile: o.profile, token: t.token, source: o.source });
    else if (t.state === 'invalid') console.warn(`[claude-profile] ${o.profile}.token unusable: ${t.reason}`);
  }
  return out;
}

/** Chat's two swap triggers, by message text: an expired/revoked login, or a usage window hit. */
export function classifyClaudeFailure(message: string): 'auth' | 'rate_limit' | null {
  const m = message.toLowerCase();
  if (/failed to authenticate|oauth|not logged in|invalid authentication|invalid api key|401/.test(m)) return 'auth';
  if (/rate limit|rate_limit|limit reached|usage limit|hit your limit|too many requests|429|out of extra usage/.test(m)) return 'rate_limit';
  return null;
}
