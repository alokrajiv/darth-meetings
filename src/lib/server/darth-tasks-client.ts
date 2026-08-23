import 'server-only';
import type { ChatCallEventsResponse } from '@/lib/teams-chat-evidence';

/**
 * Server-to-server client for Darth Tasks (plagueis) internal endpoints,
 * authenticated with the same DARTH_APP_TOKEN the notify pipe uses
 * (lib/server/darth-notify.ts sits next door on the same credential).
 *
 * Feature-off-by-absence: no DARTH_APP_TOKEN → every function returns null
 * and the Teams-chat-evidence feature simply doesn't exist. Network
 * failures, timeouts, 4xx/5xx → null too (callers treat null as "couldn't
 * ask", never as a verdict). The only structured errors are the contract's
 * ok:false bodies, which come back as parsed 200s.
 */

const DEFAULT_BASE = 'https://tasks.darth-internal.trames.io';
const TIMEOUT_MS = 5000;

function baseUrl(): string {
  return process.env.DARTH_TASKS_URL || DEFAULT_BASE;
}

/** Token read at call time so tmp scripts / dev restarts can flip it. */
function appToken(): string | null {
  return process.env.DARTH_APP_TOKEN || null;
}

export function isDarthTasksConfigured(): boolean {
  return !!appToken();
}

async function getJsonRaw<T>(path: string): Promise<{ body: T | null; status: number | null }> {
  const token = appToken();
  if (!token) return { body: null, status: null };
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[darth-tasks] ${res.status} for ${path.split('?')[0]}`);
      return { body: null, status: res.status };
    }
    return { body: (await res.json()) as T, status: res.status };
  } catch (e) {
    console.warn(
      `[darth-tasks] request failed for ${path.split('?')[0]}:`,
      e instanceof Error ? e.message : e
    );
    return { body: null, status: null };
  }
}

async function getJson<T>(path: string): Promise<T | null> {
  return (await getJsonRaw<T>(path)).body;
}

export interface MsLinkStatus {
  linked: boolean;
  status: string | null;
  ms_upn?: string;
  connected_at?: string;
}

/**
 * GET /api/ms/internal/link-status — which of these SSO emails have a live
 * delegated Microsoft link at Darth Tasks. Keys in the returned map are
 * exactly the emails plagueis echoed (we also fold in lowercase lookups on
 * our side). Null = feature off / plagueis unreachable.
 */
export async function fetchMsLinkStatus(
  emails: string[]
): Promise<Record<string, MsLinkStatus> | null> {
  const cleaned = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (cleaned.length === 0) return {};
  const body = await getJson<{ accounts?: Record<string, MsLinkStatus> }>(
    `/api/ms/internal/link-status?emails=${encodeURIComponent(cleaned.join(','))}`
  );
  if (!body || typeof body.accounts !== 'object' || body.accounts === null) return null;
  return body.accounts;
}

/** One user's link state, case-insensitive. Null = couldn't ask. */
export async function fetchMsLinkStatusOne(email: string): Promise<MsLinkStatus | null> {
  const map = await fetchMsLinkStatus([email]);
  if (!map) return null;
  const hit =
    map[email] ??
    map[email.toLowerCase()] ??
    Object.entries(map).find(([k]) => k.toLowerCase() === email.toLowerCase())?.[1];
  return hit ?? null;
}

/**
 * GET /api/ms/internal/chat-call-events — the system events of one meeting
 * chat over a window, summarized (held / callStart / callEnd / recorded /
 * transcribed / humanMessages). `chatId` is the thread id embedded in every
 * Teams join link (lib/teams-link threadIdFromJoinUrl) — own-tenant AND
 * external. Returns the contract body verbatim (ok:false bodies included);
 * null = feature off / transport failure / non-200 — EXCEPT a 400: bad
 * params are deterministic (this exact chat id will 400 forever), so it
 * comes back as a synthetic ok:false graph_error the caller can persist;
 * otherwise the sweep would retry the same doomed lookup every pass and the
 * one-time backfill could never finish.
 */
export async function fetchTeamsChatCallEvents(
  email: string,
  chatId: string,
  fromIso: string,
  toIso: string
): Promise<ChatCallEventsResponse | null> {
  const q = new URLSearchParams({ email, chat: chatId, from: fromIso, to: toIso });
  const { body, status } = await getJsonRaw<ChatCallEventsResponse>(
    `/api/ms/internal/chat-call-events?${q.toString()}`
  );
  if (!body || typeof body.ok !== 'boolean') {
    if (status === 400) return { ok: false, reason: 'graph_error', status: 400 };
    return null;
  }
  return body;
}
