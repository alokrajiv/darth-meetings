import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

// Per-user Google account rows for the background sync-and-remind poller.
// Since 2026-10-12 this is POLL BOOKKEEPING mirrored from darth-auth's
// `account_links` (lib/server/google-link-sync.ts): auth owns the link and the
// refresh token, tokens come from lib/server/google-oauth.ts. `last_poll_at`,
// `teams_chat_backfilled_at` and `connected_at` stay local.
// `refresh_token_enc` is dead (NULL on every row added after the switch;
// migration 057) — kept only as the rollback snapshot until the soak is over.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

/** `last_error` of a row whose person is not linked on darth-auth (any more):
 * status 'revoked', and the UI reads it as "not connected", not "reconnect". */
export const NOT_LINKED_ON_AUTH = 'not linked on auth';

export function isNotLinkedOnAuth(row: Pick<GoogleAccountRow, 'last_error'>): boolean {
  return row.last_error === NOT_LINKED_ON_AUTH;
}

export interface GoogleAccountRow {
  user_id: string;
  user_email: string;
  google_email: string | null;
  /** Dead since 2026-10-12 (auth holds the token) — never read. */
  refresh_token_enc: string | null;
  scopes: string;
  /** Which Workspace org's OAuth client issued the refresh token (on auth). */
  client_key: 'sg' | 'eng';
  status: 'ok' | 'revoked' | 'error';
  last_error: string | null;
  connected_at: string;
  last_refresh_at: string | null;
  last_poll_at: string | null;
  /** When the one-time 60-day Teams-chat-evidence backfill completed for
   * this user (migration 028); null = not yet run (or still partial). */
  teams_chat_backfilled_at: string | null;
}

export async function getGoogleAccount(userId: string): Promise<GoogleAccountRow | null> {
  const rows = await sql<GoogleAccountRow[]>`
    SELECT user_id, user_email, google_email, refresh_token_enc, scopes,
           client_key, status, last_error, connected_at, last_refresh_at,
           last_poll_at, teams_chat_backfilled_at
    FROM ${sql(SCHEMA)}.google_accounts
    WHERE user_id = ${userId}
  `;
  return rows[0] ?? null;
}

/**
 * Mirror one auth link onto this app's row. New person → INSERT (no token,
 * `connected_at` now, never polled yet, so the poller visits them first);
 * known person → refresh the mirrored fields only. `connected_at`,
 * `last_poll_at` and `teams_chat_backfilled_at` are this app's own history
 * and are never touched by the mirror. Returns true when a row was inserted.
 */
export async function upsertGoogleAccountMirror(input: {
  userId: string;
  userEmail: string;
  googleEmail: string | null;
  scopes: string;
  clientKey: 'sg' | 'eng';
  status: 'ok' | 'revoked' | 'error';
  lastError: string | null;
}): Promise<boolean> {
  const rows = await sql<{ inserted: boolean }[]>`
    INSERT INTO ${sql(SCHEMA)}.google_accounts
      (user_id, user_email, google_email, refresh_token_enc, scopes,
       client_key, status, last_error, connected_at, last_poll_at, updated_at)
    VALUES
      (${input.userId}, ${input.userEmail}, ${input.googleEmail}, NULL,
       ${input.scopes}, ${input.clientKey}, ${input.status}, ${input.lastError},
       now(), NULL, now())
    ON CONFLICT (user_id) DO UPDATE SET
      user_email   = EXCLUDED.user_email,
      google_email = EXCLUDED.google_email,
      scopes       = EXCLUDED.scopes,
      client_key   = EXCLUDED.client_key,
      status       = EXCLUDED.status,
      last_error   = EXCLUDED.last_error,
      updated_at   = now()
    RETURNING (xmax = 0) AS inserted
  `;
  return rows[0]?.inserted ?? false;
}

/**
 * Every row whose person is NOT linked on auth any more (absent from the
 * lookup listing) → 'revoked' so the poller stops visiting. Rows are never
 * deleted: their poll history must survive an unlink + relink. Returns how
 * many rows changed.
 */
export async function markGoogleAccountsNotLinked(keepUserIds: string[]): Promise<number> {
  const rows = await sql<{ user_id: string }[]>`
    UPDATE ${sql(SCHEMA)}.google_accounts
    SET status = 'revoked',
        last_error = ${NOT_LINKED_ON_AUTH},
        updated_at = now()
    WHERE status <> 'revoked'
      AND NOT (user_id = ANY(${keepUserIds}::uuid[]))
    RETURNING user_id
  `;
  return rows.length;
}

export async function markGoogleAccountStatus(
  userId: string,
  status: 'ok' | 'revoked' | 'error',
  lastError?: string | null
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.google_accounts
    SET status = ${status},
        last_error = ${lastError ?? null},
        last_refresh_at = CASE WHEN ${status} = 'ok' THEN now() ELSE last_refresh_at END,
        updated_at = now()
    WHERE user_id = ${userId}
  `;
}

/** Stamp the one-time Teams-chat backfill as fully done (migration 028). */
export async function markTeamsChatBackfilled(userId: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.google_accounts
    SET teams_chat_backfilled_at = now(), updated_at = now()
    WHERE user_id = ${userId}
  `;
}

export async function markGoogleAccountPolled(userId: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.google_accounts
    SET last_poll_at = now(), updated_at = now()
    WHERE user_id = ${userId}
  `;
}

/** Accounts the poller should visit. 'error' rows are retried (transient);
 * 'revoked' rows are skipped until the user reconnects. */
export async function listPollableGoogleAccounts(): Promise<GoogleAccountRow[]> {
  return sql<GoogleAccountRow[]>`
    SELECT user_id, user_email, google_email, refresh_token_enc, scopes,
           client_key, status, last_error, connected_at, last_refresh_at,
           last_poll_at, teams_chat_backfilled_at
    FROM ${sql(SCHEMA)}.google_accounts
    WHERE status <> 'revoked'
    ORDER BY last_poll_at ASC NULLS FIRST
  `;
}
