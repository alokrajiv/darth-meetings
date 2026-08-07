import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

// Per-user Google account connections (encrypted refresh tokens) for the
// background sync-and-remind poller. The token blob is opaque here —
// encryption/decryption lives in lib/server/google-oauth.ts.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface GoogleAccountRow {
  user_id: string;
  user_email: string;
  google_email: string | null;
  refresh_token_enc: string;
  scopes: string;
  /** Which Workspace org's OAuth client issued the refresh token. */
  client_key: 'sg' | 'eng';
  status: 'ok' | 'revoked' | 'error';
  last_error: string | null;
  connected_at: string;
  last_refresh_at: string | null;
  last_poll_at: string | null;
}

export async function getGoogleAccount(userId: string): Promise<GoogleAccountRow | null> {
  const rows = await sql<GoogleAccountRow[]>`
    SELECT user_id, user_email, google_email, refresh_token_enc, scopes,
           client_key, status, last_error, connected_at, last_refresh_at, last_poll_at
    FROM ${sql(SCHEMA)}.google_accounts
    WHERE user_id = ${userId}
  `;
  return rows[0] ?? null;
}

export async function upsertGoogleAccount(input: {
  userId: string;
  userEmail: string;
  googleEmail: string | null;
  refreshTokenEnc: string;
  scopes: string;
  clientKey: 'sg' | 'eng';
}): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.google_accounts
      (user_id, user_email, google_email, refresh_token_enc, scopes,
       client_key, status, last_error, connected_at, updated_at)
    VALUES
      (${input.userId}, ${input.userEmail}, ${input.googleEmail},
       ${input.refreshTokenEnc}, ${input.scopes}, ${input.clientKey},
       'ok', NULL, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      user_email        = EXCLUDED.user_email,
      google_email      = EXCLUDED.google_email,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      scopes            = EXCLUDED.scopes,
      client_key        = EXCLUDED.client_key,
      status            = 'ok',
      last_error        = NULL,
      connected_at      = now(),
      updated_at        = now()
  `;
}

export async function deleteGoogleAccount(userId: string): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.google_accounts WHERE user_id = ${userId}`;
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
           client_key, status, last_error, connected_at, last_refresh_at, last_poll_at
    FROM ${sql(SCHEMA)}.google_accounts
    WHERE status <> 'revoked'
    ORDER BY last_poll_at ASC NULLS FIRST
  `;
}
