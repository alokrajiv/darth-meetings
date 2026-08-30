import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Per-user app preferences (migration 033). Today: the account-level
 * auto-sync switch (T2). Keyed by SSO user id (unlike notify_prefs, which is
 * by email, because this switch drives imports under the user's OWN Google
 * connection — a user id is the thing we mint tokens for).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const AUTO_SYNC_SCOPES = ['off', 'mine', 'all'] as const;
export type AutoSyncScope = (typeof AUTO_SYNC_SCOPES)[number];
export const AUTO_SYNC_MODES = ['transcript', 'video', 'both'] as const;
export type AutoSyncMode = (typeof AUTO_SYNC_MODES)[number];
export const AUTO_SYNC_REPORTS = ['summary', 'detailed-video', 'detailed-text', 'later'] as const;
export type AutoSyncReport = (typeof AUTO_SYNC_REPORTS)[number];

export interface AutoSyncPrefs {
  scope: AutoSyncScope;
  mode: AutoSyncMode;
  report: AutoSyncReport;
  /** ISO — only occurrences starting after this are auto-synced. */
  since: string | null;
  providers: { gmeet: boolean; teams: boolean };
}

export interface UserPrefsRow {
  user_id: string;
  email: string;
  auto_sync: AutoSyncScope;
  auto_sync_mode: AutoSyncMode;
  auto_sync_report: AutoSyncReport;
  auto_sync_since: string | null;
  auto_sync_providers: { gmeet?: boolean; teams?: boolean } | null;
  updated_at: string;
}

export const DEFAULT_AUTO_SYNC: AutoSyncPrefs = {
  scope: 'off',
  mode: 'transcript',
  report: 'summary',
  since: null,
  providers: { gmeet: true, teams: true },
};

export function autoSyncOf(row: UserPrefsRow | null | undefined): AutoSyncPrefs {
  if (!row) return DEFAULT_AUTO_SYNC;
  return {
    scope: row.auto_sync,
    mode: row.auto_sync_mode,
    report: row.auto_sync_report,
    since: row.auto_sync_since ? new Date(row.auto_sync_since).toISOString() : null,
    providers: {
      gmeet: row.auto_sync_providers?.gmeet !== false,
      teams: row.auto_sync_providers?.teams !== false,
    },
  };
}

export async function getUserPrefs(userId: string): Promise<UserPrefsRow | null> {
  const rows = await sql<UserPrefsRow[]>`
    SELECT user_id, email, auto_sync, auto_sync_mode, auto_sync_report,
           auto_sync_since, auto_sync_providers, updated_at
    FROM ${sql(SCHEMA)}.user_prefs WHERE user_id = ${userId}
  `;
  return rows[0] ?? null;
}

/**
 * Partial update. Turning the switch on from off stamps `since = now()` so
 * enabling never backfills history; turning it off clears nothing else (the
 * mode/report survive for next time).
 */
export async function setAutoSyncPrefs(
  user: { userId: string; email: string },
  patch: Partial<Pick<AutoSyncPrefs, 'scope' | 'mode' | 'report'>> & {
    providers?: Partial<AutoSyncPrefs['providers']>;
  }
): Promise<AutoSyncPrefs> {
  const current = await getUserPrefs(user.userId);
  const cur = autoSyncOf(current);
  const scope = patch.scope ?? cur.scope;
  const mode = patch.mode ?? cur.mode;
  const report = patch.report ?? cur.report;
  const providers = {
    gmeet: patch.providers?.gmeet ?? cur.providers.gmeet,
    teams: patch.providers?.teams ?? cur.providers.teams,
  };
  const turningOn = cur.scope === 'off' && scope !== 'off';
  const rows = await sql<UserPrefsRow[]>`
    INSERT INTO ${sql(SCHEMA)}.user_prefs
      (user_id, email, auto_sync, auto_sync_mode, auto_sync_report, auto_sync_since, auto_sync_providers)
    VALUES (${user.userId}, ${user.email.toLowerCase()}, ${scope}, ${mode}, ${report},
            ${scope === 'off' ? null : sql`now()`}, ${sql.json(providers as unknown as never)})
    ON CONFLICT (user_id) DO UPDATE SET
      email = EXCLUDED.email,
      auto_sync = EXCLUDED.auto_sync,
      auto_sync_mode = EXCLUDED.auto_sync_mode,
      auto_sync_report = EXCLUDED.auto_sync_report,
      auto_sync_since = CASE
        WHEN ${turningOn} THEN now()
        WHEN EXCLUDED.auto_sync = 'off' THEN NULL
        ELSE ${sql(SCHEMA)}.user_prefs.auto_sync_since
      END,
      auto_sync_providers = EXCLUDED.auto_sync_providers,
      updated_at = now()
    RETURNING user_id, email, auto_sync, auto_sync_mode, auto_sync_report,
              auto_sync_since, auto_sync_providers, updated_at
  `;
  return autoSyncOf(rows[0]);
}

export interface AutoSyncUser {
  userId: string;
  email: string;
  prefs: AutoSyncPrefs;
  /** google_accounts.connected_at — election tie-break (earliest wins). */
  connectedAt: string | null;
  googleStatus: 'ok' | 'revoked' | 'error' | null;
}

/** Everyone with the switch on, with their Google connection state. */
export async function listAutoSyncUsers(): Promise<AutoSyncUser[]> {
  const rows = await sql<
    Array<UserPrefsRow & { connected_at: string | null; google_status: 'ok' | 'revoked' | 'error' | null }>
  >`
    SELECT p.user_id, p.email, p.auto_sync, p.auto_sync_mode, p.auto_sync_report,
           p.auto_sync_since, p.auto_sync_providers, p.updated_at,
           g.connected_at, g.status AS google_status
    FROM ${sql(SCHEMA)}.user_prefs p
    LEFT JOIN ${sql(SCHEMA)}.google_accounts g ON g.user_id = p.user_id
    WHERE p.auto_sync <> 'off'
    ORDER BY g.connected_at ASC NULLS LAST
  `;
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    prefs: autoSyncOf(r),
    connectedAt: r.connected_at ? new Date(r.connected_at).toISOString() : null,
    googleStatus: r.google_status,
  }));
}

// ---------------------------------------------------------------------------
// auto_sync_log — the one-import-per-occurrence ledger
// ---------------------------------------------------------------------------

export type AutoSyncOutcome = 'imported' | 'deferred' | 'already' | 'failed' | 'no_access' | 'nudged';

export interface AutoSyncLogRow {
  occ_key: string;
  meeting_code: string | null;
  occ_start: string | null;
  title: string | null;
  outcome: AutoSyncOutcome;
  importer_user_id: string | null;
  importer_email: string | null;
  assemblyai_id: string | null;
  watchers: string[];
  detail: string | null;
  attempts: number;
  fired_at: string;
  updated_at: string;
}

export async function getAutoSyncLog(occKeys: string[]): Promise<Map<string, AutoSyncLogRow>> {
  if (occKeys.length === 0) return new Map();
  const rows = await sql<AutoSyncLogRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.auto_sync_log WHERE occ_key = ANY(${occKeys})
  `;
  return new Map(rows.map((r) => [r.occ_key, r]));
}

/**
 * Claim an occurrence for this sweep pass. Returns false when another
 * writer holds a NON-retryable claim — the PK is the lock, so two processes
 * can't both fire. A retryable prior outcome (failed / no_access / nudged
 * past its cool-off) is overwritten in place with attempts+1.
 */
export async function claimAutoSync(input: {
  occKey: string;
  meetingCode: string | null;
  occStart: string | null;
  title: string | null;
  importerUserId: string | null;
  importerEmail: string | null;
  watchers: string[];
  retryableBefore: Date;
}): Promise<boolean> {
  const rows = await sql<Array<{ occ_key: string }>>`
    INSERT INTO ${sql(SCHEMA)}.auto_sync_log
      (occ_key, meeting_code, occ_start, title, outcome, importer_user_id, importer_email, watchers, detail)
    VALUES (${input.occKey}, ${input.meetingCode}, ${input.occStart}, ${input.title}, 'failed',
            ${input.importerUserId}, ${input.importerEmail}, ${sql.array(input.watchers)}, 'claimed')
    ON CONFLICT (occ_key) DO UPDATE SET
      importer_user_id = EXCLUDED.importer_user_id,
      importer_email = EXCLUDED.importer_email,
      watchers = EXCLUDED.watchers,
      detail = 'claimed',
      attempts = ${sql(SCHEMA)}.auto_sync_log.attempts + 1,
      updated_at = now()
    WHERE ${sql(SCHEMA)}.auto_sync_log.outcome IN ('failed', 'no_access', 'nudged')
      AND ${sql(SCHEMA)}.auto_sync_log.updated_at < ${input.retryableBefore}
    RETURNING occ_key
  `;
  return rows.length > 0;
}

export async function settleAutoSync(
  occKey: string,
  patch: {
    outcome: AutoSyncOutcome;
    assemblyaiId?: string | null;
    detail?: string | null;
    importerUserId?: string | null;
    importerEmail?: string | null;
  }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.auto_sync_log SET
      outcome = ${patch.outcome},
      assemblyai_id = COALESCE(${patch.assemblyaiId ?? null}, assemblyai_id),
      detail = ${patch.detail ?? null},
      importer_user_id = COALESCE(${patch.importerUserId ?? null}, importer_user_id),
      importer_email = COALESCE(${patch.importerEmail ?? null}, importer_email),
      updated_at = now()
    WHERE occ_key = ${occKey}
  `;
}

/** Recent ledger rows — settings card "what auto-sync did" + CLI status. */
export async function listAutoSyncActivityFor(
  user: { userId: string; email: string },
  limit = 20
): Promise<AutoSyncLogRow[]> {
  return sql<AutoSyncLogRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.auto_sync_log
    WHERE importer_user_id = ${user.userId} OR ${user.email.toLowerCase()} = ANY(watchers)
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
}
