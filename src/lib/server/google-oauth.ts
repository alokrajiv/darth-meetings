import 'server-only';
import { config } from '@/config';
import { markGoogleAccountStatus, NOT_LINKED_ON_AUTH } from '@/db-ops/google-accounts';
import { connectionsHref, DARTH_AUTH_CONNECTIONS_URL } from '@/lib/darth-family';

/**
 * Server-side Google access tokens — FETCHED FROM darth-auth (since
 * 2026-10-12, plans/connectors/SWITCH-2026-10-12.md).
 *
 * darth-auth owns every Google account link: the person connects, reconnects
 * and disconnects on `auth…/connections`, auth holds the refresh token and
 * refreshes it. This app no longer runs an OAuth flow, holds a client secret
 * or decrypts anything — it asks auth for a short-lived access token,
 * service-to-service:
 *
 *   POST {DARTH_AUTH_INTERNAL_URL}/api/links/google/token {userId, group:"calendar"}
 *   Authorization: Bearer <DARTH_APP_TOKEN>   (the darth-meetings dapp_)
 *
 * `userId` is auth's `users.id` (= DarthUser.userId here). `group` is only
 * auth's allow-list key — darth-meetings is listed for calendar, drive and
 * directory, and the served token carries every scope the person granted, so
 * "calendar" is always passed. `google_accounts` stays as this app's POLL
 * BOOKKEEPING, mirrored from auth (`google-link-sync.ts`); its
 * `refresh_token_enc` is dead (migration 057).
 */

/**
 * One Internal OAuth client per Workspace org at Google: 'sg' = trames.sg,
 * 'eng' = trames-engineering.com. Auth picks the client the same way; we only
 * keep the value on the mirror row (google_accounts.client_key) for the record.
 */
export type GoogleClientKey = 'sg' | 'eng';

export function clientKeyForEmail(email: string): GoogleClientKey {
  return email.toLowerCase().endsWith('@trames-engineering.com') ? 'eng' : 'sg';
}

export { DARTH_AUTH_CONNECTIONS_URL };

/**
 * auth's Connections page with `?return=` back to this app. A relative
 * `returnTo` ('/settings') is made absolute on APP_BASE_URL — auth only
 * honours same-site absolute URLs.
 */
export function connectionsUrl(returnTo: string): string {
  return connectionsHref(returnTo, config.google.appBaseUrl);
}

const TOKEN_TIMEOUT_MS = 5000;
/** auth answered without an expiry (should not happen for Google) — cache
 * briefly rather than not at all. */
const FALLBACK_TTL_MS = 10 * 60 * 1000;
/** How long a "no usable link" answer is remembered. Before the switch an
 * unlinked user cost a local row read; now it is an auth call, and auth's
 * token route allows 60 calls/min for the whole app — so routes that ask on
 * every request for a person without a link must not burn that window. */
const NEGATIVE_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Caches live in process memory only (single pm2 process), keyed by user:
// served tokens until 2 min before expiry, "not linked" answers for a minute,
// and one app-wide back-off after a 429.

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const negativeCache = new Map<string, number>();
let rateLimitedUntil = 0;

/** Forget the user's cached token AND any cached "not linked" answer — after
 * a Google 401, or when the auth sync just saw them (re)link. */
export function invalidateServerToken(userId: string): void {
  tokenCache.delete(userId);
  negativeCache.delete(userId);
}

/** Drop only the cached "not linked" answer — the auth sync just saw the
 * person linked, so the next token ask goes to auth instead of waiting out
 * the minute. A live cached token is kept. */
export function clearNotLinkedCache(userId: string): void {
  negativeCache.delete(userId);
}

type AuthTokenBody = {
  token?: string;
  expiresAt?: string | null;
  error?: string;
  retryAfterMs?: number;
};

/**
 * Fetch (or reuse) an access token for a linked user. Returns null when the
 * user has no usable link, and mirrors why onto their google_accounts row
 * (an UPDATE — a user without a row stays without one):
 *  - 404 not linked / 410 link expired / 403 group not granted / 403 user
 *    disabled → 'revoked' (the poller stops visiting; the UI says reconnect
 *    on Connections). The next auth sync flips it back once they relink.
 *  - 401 / 403 app not allowed / 429 / 5xx / transport → 'error' (transient
 *    or operator-side; the poller keeps retrying).
 * Never logs the token.
 */
export async function getServerAccessToken(
  userId: string
): Promise<{ token: string; expiresAt: number } | null> {
  const hit = tokenCache.get(userId);
  if (hit && hit.expiresAt - Date.now() > 120_000) return hit;
  const negativeUntil = negativeCache.get(userId);
  if (negativeUntil && negativeUntil > Date.now()) return null;
  if (rateLimitedUntil > Date.now()) return null;

  const appToken = process.env.DARTH_APP_TOKEN;
  if (!appToken) {
    await markGoogleAccountStatus(userId, 'error', 'DARTH_APP_TOKEN not set on darth-meetings');
    return null;
  }

  let res: Response;
  let body: AuthTokenBody | null;
  try {
    res = await fetch(`${config.auth.internalUrl}/api/links/google/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ userId, group: 'calendar' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    body = (await res.json().catch(() => null)) as AuthTokenBody | null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markGoogleAccountStatus(userId, 'error', `darth-auth unreachable: ${msg}`);
    return null;
  }

  if (res.ok && typeof body?.token === 'string') {
    const parsed = body.expiresAt ? Date.parse(body.expiresAt) : NaN;
    const entry = {
      token: body.token,
      expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + FALLBACK_TTL_MS,
    };
    tokenCache.set(userId, entry);
    negativeCache.delete(userId);
    await markGoogleAccountStatus(userId, 'ok', null);
    return entry;
  }

  tokenCache.delete(userId);
  const authError = body?.error ?? `HTTP ${res.status}`;
  const deadLink =
    res.status === 404 ||
    res.status === 410 ||
    (res.status === 403 && (authError === 'group not granted' || authError === 'user disabled'));
  if (deadLink) {
    negativeCache.set(userId, Date.now() + NEGATIVE_TTL_MS);
    await markGoogleAccountStatus(
      userId,
      'revoked',
      res.status === 404 ? NOT_LINKED_ON_AUTH : `darth-auth: ${authError}`
    );
    return null;
  }
  let detail = authError;
  if (res.status === 429) {
    const wait = typeof body?.retryAfterMs === 'number' ? body.retryAfterMs : 60_000;
    rateLimitedUntil = Date.now() + wait;
    detail = `${authError} (retry in ${Math.ceil(wait / 1000)}s)`;
    console.warn(`[google-oauth] darth-auth rate-limited token fetches for ${Math.ceil(wait / 1000)}s`);
  }
  await markGoogleAccountStatus(userId, 'error', `darth-auth ${res.status}: ${detail}`);
  return null;
}
