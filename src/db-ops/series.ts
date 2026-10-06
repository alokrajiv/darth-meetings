import 'server-only';
import type { ReportPref } from '@/lib/report-pref';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { parseStoredPatterns, type SeriesPattern } from '@/lib/series-patterns';
import { seriesOwnershipReady } from '@/db-ops/series-ownership-schema';
import { isAuditor } from '@/db-ops/auditors';

/**
 * Curated series (docs/curated-series-spec.md, owner 2026-10-06): a small set
 * of hand-made series — name, description, patterns, default labels,
 * followers — replacing the key-based "evidence bag" series of 2026-08-11.
 *
 * This module is the plain data layer: rows in, rows out. THE membership
 * engine (who belongs to which series, and the labels + follow shares that
 * follow a membership) is lib/server/curated-series.ts — every membership
 * write goes through it, never straight through these helpers from a route.
 *
 * PRIVACY (spec §11.6 — v2, a series runs as its OWNER): a series exists
 * only for its owner, editors, followers and the auditors
 * (`seriesVisibleTo`); everyone else gets nothing — not its name, not its
 * id on a meeting, not a count. Its MEMBERS are meetings, so every function
 * here that serves members to a person takes the caller and returns only
 * meetings they own or hold a share on; counts are "visible to you".
 * Every listing here is filtered by BOTH predicates.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

/**
 * Per-series auto-import config (series.auto_import jsonb). The sweep runs
 * as the enabler (their Google connection / identity), only fires on
 * occurrences that START after `since`, and never re-fires an occurrence
 * thanks to series_auto_import_log.
 */
export interface SeriesAutoImportCfg {
  enabled: boolean;
  byUserId: string;
  byEmail: string;
  mode: 'transcript' | 'video' | 'both';
  /** Since 2026-09-21 a run writes BOTH tiers; this only picks the report's
   * flavour, or 'later'. Series configured before that carry the retired
   * 'summary' — read it with lib/report-pref storedReportPref(). */
  report: ReportPref | 'summary';
  since: string;
  lastSweepAt?: string;
  lastError?: string | null;
}

export interface SeriesRow {
  id: number;
  title: string;
  created_by: string;
  notes: string | null;
  /** One line: what the series is (migration 053). */
  description: string | null;
  /** The matcher's input (lib/series-patterns), validated on read. */
  patterns: SeriesPattern[];
  /** Display / tie-break order only (v2 §11.2): which chip shows first and
   * which auto-import series owns an occurrence. Lowest first, then id. */
  priority: number;
  auto_import: SeriesAutoImportCfg | null;
  /** The person the series runs as (migration 054) — null before it. */
  owner_user_id: string | null;
  /** Lower-cased; null before 054 or when the backfill could not map it. */
  owner_email: string | null;
  created_at: string;
  updated_at: string;
}

/** `SELECT *` works before AND after 053/054 — normalise the columns it may
 * or may not carry, and parse the patterns once. */
export function normalizeRow(raw: Record<string, unknown>): SeriesRow {
  const ownerEmail = typeof raw.owner_email === 'string' ? raw.owner_email.trim().toLowerCase() : '';
  return {
    ...(raw as unknown as SeriesRow),
    description: (raw.description as string | null | undefined) ?? null,
    patterns: parseStoredPatterns(raw.patterns),
    priority: typeof raw.priority === 'number' ? raw.priority : 100,
    owner_user_id: (raw.owner_user_id as string | null | undefined) ?? null,
    owner_email: ownerEmail || null,
  };
}

const normEmail = (e: string) => e.trim().toLowerCase();

/**
 * THE series visibility predicate (spec §11.6 canSeeSeries, in SQL): the
 * caller owns the series (by user id or email), edits it, follows it — or is
 * an auditor. `alias` is the series table's alias in the surrounding query.
 * Needs 054 (owner_email, series_editors): callers check
 * seriesOwnershipReady first.
 */
export function seriesVisibleTo(
  alias: string,
  caller: { userId: string; email: string },
  callerIsAuditor: boolean
) {
  if (callerIsAuditor) return sql`true`;
  const email = normEmail(caller.email);
  const id = sql.unsafe(`${alias}.id`);
  return sql`(
    ${sql.unsafe(`${alias}.owner_email`)} = ${email}
    OR ${sql.unsafe(`${alias}.owner_user_id`)} = ${caller.userId}::uuid
    OR EXISTS (SELECT 1 FROM ${sql(SCHEMA)}.series_editors ed
               WHERE ed.series_id = ${id} AND ed.email = ${email})
    OR EXISTS (SELECT 1 FROM ${sql(SCHEMA)}.series_followers fo
               WHERE fo.series_id = ${id} AND fo.email = ${email})
  )`;
}

/**
 * The listing's series chip (db-ops/transcripts — legacy + v2 listing): for
 * the row aliased `rowAlias`, the FIRST series by priority then id that the
 * meeting is in AND the caller may see (§11.6). A meeting can be in several
 * series; one the caller cannot see is never named. Before 054 → NULL (no
 * owner, nobody can be shown a series).
 *
 * Returns the select-list columns (`series_id`, `series_title`) and the
 * LATERAL join that feeds them; use both or neither.
 */
export async function listingSeriesSql(
  rowAlias: string,
  caller: { userId: string; email: string }
) {
  const ready = await seriesOwnershipReady().catch(() => false);
  if (!ready) {
    return {
      cols: () => sql`NULL::int AS series_id, NULL::text AS series_title,`,
      join: () => sql``,
    };
  }
  const callerIsAuditor = await isAuditor(caller.email).catch(() => false);
  const tid = sql.unsafe(`${rowAlias}.id`);
  return {
    cols: () => sql`ser.series_id, ser.series_title,`,
    join: () => sql`
      LEFT JOIN LATERAL (
        SELECT sm.series_id, se.title AS series_title
        FROM ${sql(SCHEMA)}.series_members sm
        JOIN ${sql(SCHEMA)}.series se ON se.id = sm.series_id
        WHERE sm.transcript_id = ${tid}
          AND ${seriesVisibleTo('se', caller, callerIsAuditor)}
        ORDER BY se.priority, se.id
        LIMIT 1
      ) ser ON true`,
  };
}

/** Ids of every series the caller may see (§11.6). */
export async function visibleSeriesIds(
  caller: { userId: string; email: string },
  callerIsAuditor: boolean
): Promise<Set<number>> {
  const rows = await sql<Array<{ id: number }>>`
    SELECT s.id FROM ${sql(SCHEMA)}.series s
    WHERE ${seriesVisibleTo('s', caller, callerIsAuditor)}
  `;
  return new Set(rows.map((r) => r.id));
}

export interface SeriesListEntry extends SeriesRow {
  /** Members the CALLER can open (owner or share) — never the global count. */
  visible_member_count: number;
  /** Newest caller-visible member's date. */
  last_recorded_at: string | null;
  /** Median gap between caller-visible members, seconds — null under 2. */
  median_gap_secs: number | null;
}

export interface SeriesMemberEntry {
  transcript_id: number;
  assemblyai_id: string;
  title: string | null;
  status: string;
  recorded_at: string | null;
  created_at: string;
  duration: number | null;
  /** 'auto' (patterns matched) | 'manual' (a person attached it). */
  how: string;
  owner_is_caller: boolean;
  /** The caller's access to the meeting. */
  access: 'owner' | 'edit' | 'read';
}

/** Create a series; the creator is its owner (053 + 054 columns — callers
 * check seriesOwnershipReady first). */
export async function createSeries(input: {
  userId: string;
  email: string;
  title: string;
  description?: string | null;
  patterns?: SeriesPattern[];
  priority?: number;
}): Promise<SeriesRow> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    INSERT INTO ${sql(SCHEMA)}.series
      (title, created_by, description, patterns, priority, owner_user_id, owner_email)
    VALUES (
      ${input.title}, ${input.userId}, ${input.description ?? null},
      ${sql.json((input.patterns ?? []) as unknown as never)}, ${input.priority ?? 100},
      ${input.userId}, ${normEmail(input.email)}
    )
    RETURNING *
  `;
  return normalizeRow(row!);
}

/** Hand the series to a new owner (the route checked who may, §11.1). */
export async function setSeriesOwner(id: number, owner: { userId: string; email: string }): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.series
    SET owner_user_id = ${owner.userId}, owner_email = ${normEmail(owner.email)}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function getSeries(id: number): Promise<SeriesRow | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM ${sql(SCHEMA)}.series WHERE id = ${id}
  `;
  return row ? normalizeRow(row) : null;
}

/** Find a series by its exact name (the seed's idempotency key). */
export async function getSeriesByTitle(title: string): Promise<SeriesRow | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM ${sql(SCHEMA)}.series WHERE title = ${title} ORDER BY id LIMIT 1
  `;
  return row ? normalizeRow(row) : null;
}

/** Every series, for the matcher (lib/server/curated-series caches it). */
export async function listAllSeries(): Promise<SeriesRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM ${sql(SCHEMA)}.series ORDER BY id
  `;
  return rows.map(normalizeRow);
}

/** Field edits. Patterns/priority change who belongs — the engine re-matches
 * after (lib/server/curated-series `updateSeriesDefinition`). */
export async function updateSeries(
  id: number,
  patch: {
    title?: string;
    description?: string | null;
    notes?: string | null;
    patterns?: SeriesPattern[];
    priority?: number;
  }
): Promise<void> {
  if (patch.title !== undefined) {
    await sql`UPDATE ${sql(SCHEMA)}.series SET title = ${patch.title}, updated_at = NOW() WHERE id = ${id}`;
  }
  if (patch.description !== undefined) {
    await sql`UPDATE ${sql(SCHEMA)}.series SET description = ${patch.description}, updated_at = NOW() WHERE id = ${id}`;
  }
  if (patch.notes !== undefined) {
    await sql`UPDATE ${sql(SCHEMA)}.series SET notes = ${patch.notes}, updated_at = NOW() WHERE id = ${id}`;
  }
  if (patch.patterns !== undefined) {
    await sql`
      UPDATE ${sql(SCHEMA)}.series
      SET patterns = ${sql.json(patch.patterns as unknown as never)}, updated_at = NOW()
      WHERE id = ${id}
    `;
  }
  if (patch.priority !== undefined) {
    await sql`UPDATE ${sql(SCHEMA)}.series SET priority = ${patch.priority}, updated_at = NOW() WHERE id = ${id}`;
  }
}

/** The row delete (cascades members, exclusions, followers, the auto-import
 * log). The engine's `deleteSeriesFully` takes labels and follow shares off
 * the members first — call that, not this. */
export async function deleteSeriesRow(id: number): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.series WHERE id = ${id}`;
}

/**
 * The /series index: the series the CALLER may see (§11.6 — owner, editor,
 * follower, auditor), with counts and cadence over the members the caller
 * can open — the global member count would say how many meetings of a
 * series exist that they cannot see. Needs 054.
 */
export async function listSeries(
  caller: { userId: string; email: string },
  callerIsAuditor: boolean
): Promise<SeriesListEntry[]> {
  const email = caller.email.trim().toLowerCase();
  const rows = await sql<Array<Record<string, unknown>>>`
    WITH vis AS (
      SELECT m.series_id, COALESCE(t.recorded_at, t.created_at) AS at
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t
        ON t.id = m.transcript_id AND t.deleted_at IS NULL
      WHERE t.user_id = ${caller.userId}
         OR EXISTS (
           SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares sh
           WHERE sh.transcript_id = t.id AND sh.shared_with_email = ${email}
         )
    ),
    gaps AS (
      SELECT series_id,
             extract(epoch FROM (lead(at) OVER (PARTITION BY series_id ORDER BY at) - at))::float8 AS gap
      FROM vis
    ),
    cadence AS (
      SELECT series_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap_secs
      FROM gaps WHERE gap IS NOT NULL
      GROUP BY series_id
    ),
    counts AS (
      SELECT series_id, count(*)::int AS n, max(at)::text AS last_at
      FROM vis GROUP BY series_id
    )
    SELECT s.*,
           COALESCE(c.n, 0) AS visible_member_count,
           c.last_at AS last_recorded_at,
           cd.median_gap_secs
    FROM ${sql(SCHEMA)}.series s
    LEFT JOIN counts c ON c.series_id = s.id
    LEFT JOIN cadence cd ON cd.series_id = s.id
    WHERE ${seriesVisibleTo('s', caller, callerIsAuditor)}
    ORDER BY lower(s.title), s.id
  `;
  return rows.map((r) => ({
    ...normalizeRow(r),
    visible_member_count: Number(r.visible_member_count ?? 0),
    last_recorded_at: (r.last_recorded_at as string | null) ?? null,
    median_gap_secs: (r.median_gap_secs as number | null) ?? null,
  }));
}

/** Index footer: the caller's own view — their visible meetings in a series
 * THEY can see vs in none of those (never org-wide totals). */
export async function seriesTotals(
  caller: { userId: string; email: string },
  callerIsAuditor: boolean
): Promise<{ memberships: number; unattached: number }> {
  const email = caller.email.trim().toLowerCase();
  const [row] = await sql<Array<{ memberships: number; unattached: number }>>`
    SELECT
      count(t.id) FILTER (WHERE inv.n > 0)::int AS memberships,
      count(t.id) FILTER (WHERE inv.n = 0)::int AS unattached
    FROM ${sql(SCHEMA)}.transcripts t
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.series s ON s.id = m.series_id
      WHERE m.transcript_id = t.id AND ${seriesVisibleTo('s', caller, callerIsAuditor)}
    ) inv
    WHERE t.deleted_at IS NULL
      AND NOT t.scratch
      AND t.status NOT IN ('uploading', 'waiting')
      AND (
        t.user_id = ${caller.userId}
        OR EXISTS (
          SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares sh
          WHERE sh.transcript_id = t.id AND sh.shared_with_email = ${email}
        )
      )
  `;
  return row ?? { memberships: 0, unattached: 0 };
}

/**
 * Series that hold at least one meeting the caller can open — "series you
 * are in" (the auto-sync card's overriding-series list). NOT a visibility
 * gate: intersect with `visibleSeriesIds` before naming any of them.
 */
export async function seriesWithCallerMembers(caller: {
  userId: string;
  email: string;
}): Promise<Set<number>> {
  const email = caller.email.trim().toLowerCase();
  const rows = await sql<Array<{ series_id: number }>>`
    SELECT DISTINCT m.series_id
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
    WHERE t.user_id = ${caller.userId}
       OR EXISTS (
         SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares sh
         WHERE sh.transcript_id = t.id AND sh.shared_with_email = ${email}
       )
  `;
  return new Set(rows.map((r) => r.series_id));
}

export async function setSeriesAutoImport(
  id: number,
  cfg: SeriesAutoImportCfg | null
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.series
    SET auto_import = ${cfg ? sql.json(cfg as unknown as never) : null}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function listAutoImportEnabledSeries(): Promise<SeriesRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM ${sql(SCHEMA)}.series
    WHERE COALESCE((auto_import->>'enabled')::boolean, false)
    ORDER BY id
  `;
  return rows.map(normalizeRow);
}

export interface AutoImportLogRow {
  series_id: number;
  occ_key: string;
  occ_start: string | null;
  title: string | null;
  outcome: string;
  assemblyai_id: string | null;
  detail: string | null;
  fired_at: string;
}

/** Everything the sweep has fired for this series, keyed by occurrence. */
export async function listAutoImportLog(seriesId: number): Promise<Map<string, AutoImportLogRow>> {
  const rows = await sql<AutoImportLogRow[]>`
    SELECT series_id, occ_key, occ_start::text, title, outcome, assemblyai_id, detail, fired_at::text
    FROM ${sql(SCHEMA)}.series_auto_import_log
    WHERE series_id = ${seriesId}
  `;
  return new Map(rows.map((r) => [r.occ_key, r]));
}

/** Series-sweep ledger rows for many series at once, keyed
 * `<series_id>|<occ_start UTC ISO>` — the listing's chip reads it so a
 * series-owned row shows what the sweep actually did (imported / queued /
 * gave up) instead of a forever "pending". */
export async function listAutoImportLogForSeries(seriesIds: number[]): Promise<Map<string, AutoImportLogRow>> {
  if (seriesIds.length === 0) return new Map();
  const rows = await sql<AutoImportLogRow[]>`
    SELECT series_id, occ_key, occ_start::text, title, outcome, assemblyai_id, detail, fired_at::text
    FROM ${sql(SCHEMA)}.series_auto_import_log
    WHERE series_id = ANY(${seriesIds}) AND occ_start IS NOT NULL
  `;
  return new Map(rows.map((r) => [`${r.series_id}|${new Date(r.occ_start!).toISOString()}`, r]));
}

/** The series sweep's ledger row for ONE occurrence, by series + instant
 * (its occ_key is the calendar instance id, not the `code|iso` key the
 * account ledger uses — so match on occ_start, ±60s). */
export async function findAutoImportLogByStart(
  seriesId: number,
  startIso: string
): Promise<AutoImportLogRow | null> {
  const rows = await sql<AutoImportLogRow[]>`
    SELECT series_id, occ_key, occ_start::text, title, outcome, assemblyai_id, detail, fired_at::text
    FROM ${sql(SCHEMA)}.series_auto_import_log
    WHERE series_id = ${seriesId}
      AND occ_start IS NOT NULL
      AND abs(extract(epoch FROM (occ_start - ${startIso}::timestamptz))) <= 60
    ORDER BY fired_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function recordAutoImportFire(input: {
  seriesId: number;
  occKey: string;
  occStart: string | null;
  title: string | null;
  /** 'no-artifact' (2026-09-18): the mode's artifact never appeared within
   * its dependency window — terminal for the UI/CLI ("pending" forever was
   * the alternative); the sweep still fires it if an artifact turns up. */
  outcome: 'imported' | 'deferred' | 'already' | 'failed' | 'no-artifact';
  assemblyaiId?: string | null;
  detail?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.series_auto_import_log
      (series_id, occ_key, occ_start, title, outcome, assemblyai_id, detail)
    VALUES
      (${input.seriesId}, ${input.occKey}, ${input.occStart}, ${input.title},
       ${input.outcome}, ${input.assemblyaiId ?? null}, ${input.detail ?? null})
    ON CONFLICT (series_id, occ_key) DO UPDATE SET
      outcome       = EXCLUDED.outcome,
      assemblyai_id = EXCLUDED.assemblyai_id,
      detail        = EXCLUDED.detail,
      fired_at      = now()
  `;
}

/** Every series carrying an explicit auto-import setting (on OR off) — the
 * ones that override account auto-sync for their occurrences. */
export async function listSeriesWithAutoImport(): Promise<SeriesRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM ${sql(SCHEMA)}.series WHERE auto_import IS NOT NULL ORDER BY title
  `;
  return rows.map(normalizeRow);
}

export interface SeriesMembershipRef {
  series_id: number;
  title: string;
  how: string;
  priority: number;
}

/**
 * The series a meeting is in that the CALLER may see (§11.6) — first by
 * priority, then id. A meeting can be in several series (§11.2); a series
 * the caller cannot see is never named. Needs 054.
 */
export async function listVisibleMemberships(
  transcriptId: number,
  caller: { userId: string; email: string },
  callerIsAuditor: boolean
): Promise<SeriesMembershipRef[]> {
  return sql<SeriesMembershipRef[]>`
    SELECT m.series_id, s.title, m.how, s.priority
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.series s ON s.id = m.series_id
    WHERE m.transcript_id = ${transcriptId}
      AND ${seriesVisibleTo('s', caller, callerIsAuditor)}
    ORDER BY s.priority, s.id
  `;
}

/** Is the meeting a member of THIS series? ENGINE / ROUTE-GATE USE — never
 * served as such. */
export async function isMemberOf(seriesId: number, transcriptId: number): Promise<boolean> {
  const rows = await sql<Array<{ one: number }>>`
    SELECT 1 AS one FROM ${sql(SCHEMA)}.series_members
    WHERE series_id = ${seriesId} AND transcript_id = ${transcriptId}
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Membership rows — written ONLY by lib/server/curated-series (the engine
// runs labels + follow shares around every one of these).
// ---------------------------------------------------------------------------

/** Add an 'auto' membership in this series unless it is already there (a
 * manual membership written concurrently wins). true = inserted.
 *
 * `ON CONFLICT DO NOTHING` with NO target on purpose: it is correct both
 * before migration 055 (transcript_id still UNIQUE — a meeting stays in its
 * first series) and after it (unique per (series, transcript)). */
export async function insertAutoMembership(seriesId: number, transcriptId: number): Promise<boolean> {
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO ${sql(SCHEMA)}.series_members (series_id, transcript_id, how, added_by)
    VALUES (${seriesId}, ${transcriptId}, 'auto', NULL)
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

/** Drop an 'auto' membership in exactly this series (a concurrent manual
 * re-attach is left alone). true = removed. */
export async function deleteAutoMembership(seriesId: number, transcriptId: number): Promise<boolean> {
  const rows = await sql<Array<{ id: number }>>`
    DELETE FROM ${sql(SCHEMA)}.series_members
    WHERE transcript_id = ${transcriptId} AND series_id = ${seriesId} AND how = 'auto'
    RETURNING id
  `;
  return rows.length > 0;
}

/** A person attached the meeting to this series: insert it 'manual', or
 * make an existing membership in THIS series manual. Other series the
 * meeting is in are untouched (a meeting can be in several, §11.2).
 * true = it is a member of this series now (false only before migration
 * 055, when it already sits in another series). */
export async function upsertManualMembership(
  seriesId: number,
  transcriptId: number,
  userId: string
): Promise<boolean> {
  const ins = await sql<Array<{ id: number }>>`
    INSERT INTO ${sql(SCHEMA)}.series_members (series_id, transcript_id, how, added_by)
    VALUES (${seriesId}, ${transcriptId}, 'manual', ${userId})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (ins.length > 0) return true;
  const upd = await sql<Array<{ id: number }>>`
    UPDATE ${sql(SCHEMA)}.series_members
    SET how = 'manual', added_by = ${userId}, added_at = NOW()
    WHERE series_id = ${seriesId} AND transcript_id = ${transcriptId}
    RETURNING id
  `;
  return upd.length > 0;
}

/** Detach the meeting from THIS series (any how). true = it was a member. */
export async function deleteMembershipIn(seriesId: number, transcriptId: number): Promise<boolean> {
  const rows = await sql<Array<{ id: number }>>`
    DELETE FROM ${sql(SCHEMA)}.series_members
    WHERE transcript_id = ${transcriptId} AND series_id = ${seriesId}
    RETURNING id
  `;
  return rows.length > 0;
}

/** "Not this series" — a human answer that beats the patterns. */
export async function addExclusion(seriesId: number, transcriptId: number, userId: string | null): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.series_exclusions (series_id, transcript_id, excluded_by)
    VALUES (${seriesId}, ${transcriptId}, ${userId})
    ON CONFLICT DO NOTHING
  `;
}

/** Live member ids + owners of a series — ENGINE USE ONLY (labels/shares
 * fan-out); never served to a person, whose view is `listMembers`. */
export async function listMemberRefs(
  seriesId: number
): Promise<Array<{ transcript_id: number; user_id: string; assemblyai_id: string }>> {
  return sql<Array<{ transcript_id: number; user_id: string; assemblyai_id: string }>>`
    SELECT m.transcript_id, t.user_id, t.assemblyai_id
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
    WHERE m.series_id = ${seriesId}
  `;
}

/** Every member id of a series, trashed rows included — the delete path,
 * which must undo labels/shares on all of them. ENGINE USE ONLY. */
export async function listAllMemberIds(seriesId: number): Promise<number[]> {
  const rows = await sql<Array<{ transcript_id: number }>>`
    SELECT transcript_id FROM ${sql(SCHEMA)}.series_members WHERE series_id = ${seriesId}
  `;
  return rows.map((r) => r.transcript_id);
}

/**
 * The members a PERSON may see: meetings they own or hold a share on, and
 * nothing else — not a placeholder row, not a count, not a date of someone
 * else's meeting (spec §6).
 */
export async function listMembers(
  seriesId: number,
  caller: { userId: string; email: string }
): Promise<SeriesMemberEntry[]> {
  const normEmail = caller.email.trim().toLowerCase();
  return sql<SeriesMemberEntry[]>`
    SELECT m.transcript_id, t.assemblyai_id, t.title, t.status,
           t.recorded_at::text AS recorded_at, t.created_at::text AS created_at,
           t.duration, m.how,
           (t.user_id = ${caller.userId}) AS owner_is_caller,
           CASE WHEN t.user_id = ${caller.userId} THEN 'owner' ELSE sh.access END AS access
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares sh
      ON sh.transcript_id = t.id AND sh.shared_with_email = ${normEmail}
    WHERE m.series_id = ${seriesId}
      AND t.deleted_at IS NULL
      AND (t.user_id = ${caller.userId} OR sh.id IS NOT NULL)
    ORDER BY COALESCE(t.recorded_at, t.created_at) DESC
  `;
}
