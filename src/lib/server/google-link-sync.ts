import 'server-only';
import { config } from '@/config';
import {
  NOT_LINKED_ON_AUTH,
  markGoogleAccountStatus,
  markGoogleAccountsNotLinked,
  upsertGoogleAccountMirror,
} from '@/db-ops/google-accounts';
import { clearNotLinkedCache, clientKeyForEmail } from '@/lib/server/google-oauth';

/**
 * Mirror darth-auth's Google links into `google_accounts` (since 2026-10-12,
 * plans/connectors/SWITCH-2026-10-12.md).
 *
 * auth owns the link; this app keeps one row per linked person as POLL
 * BOOKKEEPING — the poller's list of who to sweep plus `last_poll_at` and
 * friends. The source of truth is auth's lookup route (dapp_ only, never
 * decrypts, not counted in the token route's rate window):
 *
 *   POST {DARTH_AUTH_INTERNAL_URL}/api/links/google/lookup  {}  | {emails:[…]}
 *   → { provider, accounts: { "<email>": {userId, linked:true, status, groups,
 *        accountLabel, lastOkAt?, lastError?} | {userId, linked:false}
 *        | {userId:null, linked:false} } }
 *
 * `{}` lists EVERY linked person (keys = their auth email, lower-case). A
 * person who linked only on auth gets a row here (so the poller visits them);
 * a row whose person is no longer linked is marked 'revoked', never deleted.
 * When auth is unreachable or refuses, NOTHING is changed — the poller keeps
 * using the rows it has.
 */

const LOOKUP_TIMEOUT_MS = 5000;

type LookupEntry =
  | {
      userId: string;
      linked: true;
      status: 'ok' | 'revoked' | 'error';
      groups?: string[];
      accountLabel?: string | null;
      lastOkAt?: string | null;
      lastError?: string | null;
    }
  | { userId: string | null; linked: false };

async function lookup(emails?: string[]): Promise<Record<string, LookupEntry> | null> {
  const appToken = process.env.DARTH_APP_TOKEN;
  if (!appToken) {
    console.warn('[google-link-sync] DARTH_APP_TOKEN not set — cannot read links from darth-auth');
    return null;
  }
  try {
    const res = await fetch(`${config.auth.internalUrl}/api/links/google/lookup`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(emails ? { emails } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as {
      accounts?: Record<string, LookupEntry>;
      error?: string;
    } | null;
    if (!res.ok || !body?.accounts || typeof body.accounts !== 'object') {
      console.warn(
        `[google-link-sync] darth-auth lookup refused: ${res.status} ${body?.error ?? 'malformed answer'}`
      );
      return null;
    }
    return body.accounts;
  } catch (err) {
    console.warn(
      '[google-link-sync] darth-auth lookup unreachable:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function normalizeStatus(s: unknown): 'ok' | 'revoked' | 'error' {
  return s === 'revoked' || s === 'error' ? s : 'ok';
}

/** Upsert one linked person's mirror row. Returns true when it was new. */
async function mirrorLinked(
  userId: string,
  email: string,
  entry: Extract<LookupEntry, { linked: true }>
): Promise<boolean> {
  const status = normalizeStatus(entry.status);
  const inserted = await upsertGoogleAccountMirror({
    userId,
    userEmail: email,
    googleEmail: entry.accountLabel ?? null,
    // auth's lookup reports scope GROUPS, not the raw scope string — the
    // column is informational only (nothing reads it).
    scopes: (entry.groups ?? []).join(' '),
    clientKey: clientKeyForEmail(email),
    status,
    lastError: status === 'ok' ? null : (entry.lastError ?? null),
  });
  if (status !== 'revoked') clearNotLinkedCache(userId);
  return inserted;
}

/**
 * Full mirror pass — top of every poller sweep. `linked` = people auth lists
 * as linked, `added` = rows created for people we had never seen, `marked` =
 * rows flipped to 'revoked' because their person is gone from auth. Null when
 * auth could not be read (rows untouched).
 */
export async function syncGoogleAccountsFromAuth(): Promise<{
  linked: number;
  added: number;
  marked: number;
} | null> {
  const accounts = await lookup();
  if (!accounts) return null;

  const keep: string[] = [];
  let added = 0;
  for (const [rawEmail, entry] of Object.entries(accounts)) {
    if (!entry?.linked || !entry.userId) continue;
    const email = rawEmail.trim().toLowerCase();
    keep.push(entry.userId);
    try {
      if (await mirrorLinked(entry.userId, email, entry)) added++;
    } catch (err) {
      console.warn(
        `[google-link-sync] mirror failed for ${email}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  const marked = await markGoogleAccountsNotLinked(keep);
  return { linked: keep.length, added, marked };
}

/**
 * Mirror ONE person (Settings status card, "Sync now"): a person who just
 * linked on auth gets their row immediately instead of at the next sweep.
 * Returns 'linked' / 'not_linked', or null when auth could not be read (row
 * untouched).
 */
export async function syncOneGoogleAccountFromAuth(
  userId: string,
  email: string
): Promise<'linked' | 'not_linked' | null> {
  const key = email.trim().toLowerCase();
  const accounts = await lookup([key]);
  if (!accounts) return null;
  const entry = accounts[key];
  if (entry?.linked && entry.userId) {
    if (entry.userId !== userId) {
      // Same email, different auth user id — should be impossible (this
      // app's userId IS auth's users.id). Do not cross-wire rows.
      console.warn(`[google-link-sync] lookup for ${key} returned another user id — skipped`);
      return null;
    }
    await mirrorLinked(userId, key, entry);
    return 'linked';
  }
  await markGoogleAccountStatus(userId, 'revoked', NOT_LINKED_ON_AUTH);
  return 'not_linked';
}
