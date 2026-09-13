import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { strongestReport } from '@/lib/auto-marker';

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
  auto_sync_announce_dismissed_at: string | null;
  setup_reviewed_at: string | null;
  updated_at: string;
}

/** Recommended configuration (Alok, 2026-08-30): full recording + detailed
 * report with video frames — what a switch-on gets unless changed. */
export const DEFAULT_AUTO_SYNC: AutoSyncPrefs = {
  scope: 'off',
  mode: 'video',
  report: 'detailed-video',
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
           auto_sync_since, auto_sync_providers, auto_sync_announce_dismissed_at, setup_reviewed_at, updated_at
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
              auto_sync_since, auto_sync_providers, auto_sync_announce_dismissed_at, setup_reviewed_at, updated_at
  `;
  return autoSyncOf(rows[0]);
}

/** One-time "auto-sync is here" announcement: dismissed per USER (server-
 * side), so it never comes back on another device. Turning the switch on
 * also counts as seen. */
export async function dismissAutoSyncAnnounce(user: { userId: string; email: string }): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.user_prefs (user_id, email, auto_sync_announce_dismissed_at)
    VALUES (${user.userId}, ${user.email.toLowerCase()}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      auto_sync_announce_dismissed_at = COALESCE(${sql(SCHEMA)}.user_prefs.auto_sync_announce_dismissed_at, now()),
      updated_at = now()
  `;
}

/** The one-time setup review (auto-sync + Slack notification settings) is
 * done for this user — the setup dialog stops asking about those. */
export async function markSetupReviewed(user: { userId: string; email: string }): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.user_prefs (user_id, email, setup_reviewed_at, auto_sync_announce_dismissed_at)
    VALUES (${user.userId}, ${user.email.toLowerCase()}, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      setup_reviewed_at = COALESCE(${sql(SCHEMA)}.user_prefs.setup_reviewed_at, now()),
      auto_sync_announce_dismissed_at = COALESCE(${sql(SCHEMA)}.user_prefs.auto_sync_announce_dismissed_at, now()),
      updated_at = now()
  `;
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
           p.auto_sync_since, p.auto_sync_providers, p.auto_sync_announce_dismissed_at, p.setup_reviewed_at, p.updated_at,
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

/**
 * Which occurrences is the account auto-sync sweep going to take? For each
 * input occurrence, finds an OPEN 'unimported' reminder belonging to an
 * auto-sync-enabled user whose scope/since/provider prefs match — the exact
 * population sweepAccountAutoSync reads — and names the likeliest importer
 * (organiser first, mirroring the sweep's election). Powers the listing's
 * "auto-sync will pick this up" chip BEFORE any auto_sync_log claim exists.
 * Returns `<code>|<UTC ISO>` → importer email.
 */
export interface PredictedAutoSync {
  /** Likeliest importer (organiser first, mirroring the sweep's election). */
  email: string;
  /** Strongest report pref across everyone whose auto-sync covers it. */
  report: AutoSyncReport;
  interested: string[];
}

export async function predictedAutoSyncImporters(
  occs: Array<{ code: string; startIso: string }>
): Promise<Map<string, PredictedAutoSync>> {
  const batch = occs
    .filter((o) => o.code && !Number.isNaN(Date.parse(o.startIso)))
    .map((o) => ({ code: o.code, start: new Date(o.startIso).toISOString() }));
  if (batch.length === 0) return new Map();
  const rows = await sql<Array<{ code: string; start: string; email: string; report: AutoSyncReport; organizer_self: boolean | null }>>`
    SELECT o.code, o.start, p.email, p.auto_sync_report AS report, r.organizer_self
    FROM jsonb_to_recordset(${sql.json(batch as unknown as never)})
         AS o(code text, start timestamptz)
    JOIN ${sql(SCHEMA)}.gmeet_reminders r
      ON r.meeting_code = o.code
     AND r.kind = 'unimported'
     AND r.resolved_at IS NULL
     AND r.event_start IS NOT NULL
     AND abs(extract(epoch FROM (r.event_start - o.start))) <= 60
    JOIN ${sql(SCHEMA)}.user_prefs p
      ON p.user_id = r.user_id
     AND p.auto_sync <> 'off'
     AND (p.auto_sync = 'all' OR r.organizer_self)
     AND (p.auto_sync_since IS NULL OR r.event_start > p.auto_sync_since)
     AND COALESCE(
           (p.auto_sync_providers ->> CASE WHEN o.code LIKE 'teams-%' THEN 'teams' ELSE 'gmeet' END)::boolean,
           true
         )
    ORDER BY o.code, o.start, r.organizer_self DESC, p.email
  `;
  const out = new Map<string, PredictedAutoSync>();
  for (const r of rows) {
    const key = `${r.code}|${new Date(r.start).toISOString()}`;
    const cur = out.get(key);
    if (!cur) {
      out.set(key, { email: r.email, report: r.report, interested: [r.email] });
    } else {
      cur.interested.push(r.email);
      cur.report = strongestReport([cur.report, r.report]);
    }
  }
  return out;
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

// ---------------------------------------------------------------------------
// Offline support (migration 040): per-ACCOUNT auto-pin counts. The bytes
// themselves live in each device's browser (service worker + Cache Storage);
// these numbers only say how many of the newest meetings every device keeps.
// ---------------------------------------------------------------------------

export interface OfflinePrefs {
  /** Newest N meetings whose page + transcript JSON are kept offline. */
  transcripts: number;
  /** Newest N recorded meetings that also get an audio-only copy. */
  audio: number;
  /** Newest N recorded meetings that also get the full recording (video). */
  video: number;
}

export const DEFAULT_OFFLINE_PREFS: OfflinePrefs = { transcripts: 100, audio: 10, video: 0 };

/** Hard caps — a laptop's browser quota is finite and the plan query pages
 * the newest `max(counts)` rows. */
export const OFFLINE_PREFS_MAX: OfflinePrefs = { transcripts: 500, audio: 100, video: 25 };

function clampCount(v: unknown, fallback: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(n)));
}

export function offlinePrefsOf(raw: unknown): OfflinePrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    transcripts: clampCount(o.transcripts, DEFAULT_OFFLINE_PREFS.transcripts, OFFLINE_PREFS_MAX.transcripts),
    audio: clampCount(o.audio, DEFAULT_OFFLINE_PREFS.audio, OFFLINE_PREFS_MAX.audio),
    video: clampCount(o.video, DEFAULT_OFFLINE_PREFS.video, OFFLINE_PREFS_MAX.video),
  };
}

export async function getOfflinePrefs(userId: string): Promise<OfflinePrefs> {
  const rows = await sql<Array<{ offline_prefs: unknown }>>`
    SELECT offline_prefs FROM ${sql(SCHEMA)}.user_prefs WHERE user_id = ${userId}
  `;
  return offlinePrefsOf(rows[0]?.offline_prefs);
}

/** Partial update; unspecified counts keep their current value. */
export async function setOfflinePrefs(
  user: { userId: string; email: string },
  patch: Partial<OfflinePrefs>
): Promise<OfflinePrefs> {
  const cur = await getOfflinePrefs(user.userId);
  const next = offlinePrefsOf({ ...cur, ...patch });
  await sql`
    INSERT INTO ${sql(SCHEMA)}.user_prefs (user_id, email, offline_prefs)
    VALUES (${user.userId}, ${user.email.toLowerCase()}, ${sql.json(next as unknown as never)})
    ON CONFLICT (user_id) DO UPDATE SET
      offline_prefs = EXCLUDED.offline_prefs,
      updated_at = now()
  `;
  return next;
}
