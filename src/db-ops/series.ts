import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { keysFromContext, normalizeTitle, strongKeys, type SeriesKeyInput } from '@/lib/series-keys';
import {
  onSeriesDeleted,
  onSeriesMerged,
  onSeriesRenamed,
  preMergeLabelState,
  syncSeriesLabelOnMemberAdd,
} from '@/lib/server/series-labels';
import type { GmeetContext } from '@/lib/format';

/**
 * Recurring-call series: the curated first-class object behind the
 * "recurring call" badge. Series rows are stored org-global (no owner), but
 * as of 2026-08-24 every series API surface is scoped through
 * visibleSeriesIds/seriesVisibleToCaller — a series title IS a meeting
 * title, and its keys carry live Teams join URLs, so serving the whole
 * table was the same leak class as the unimported-view incident.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

/**
 * PRIVACY GATE (2026-08-24): series ids the caller may see — they hold an
 * accessible member transcript (own or shared), or their own calendar sweep
 * evidences the series (a cached event matching the series' meeting-code /
 * recurring-base-id key: they attend the recurring call even if nothing was
 * imported yet). Teams-only series with no accessible member stay hidden
 * until an import lands — the join-URL keys hash differently on the
 * calendar side, so there is no safe calendar arm for them.
 */
export async function visibleSeriesIds(caller: {
  userId: string;
  email: string;
}): Promise<Set<number>> {
  const email = caller.email.trim().toLowerCase();
  const rows = await sql<Array<{ id: number }>>`
    SELECT s.id
    FROM ${sql(SCHEMA)}.series s
    WHERE EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.series_members m
        JOIN ${sql(SCHEMA)}.transcripts t
          ON t.id = m.transcript_id AND t.deleted_at IS NULL
        LEFT JOIN ${sql(SCHEMA)}.transcript_shares sh
          ON sh.transcript_id = t.id AND sh.shared_with_email = ${email}
        WHERE m.series_id = s.id
          AND (t.user_id = ${caller.userId} OR sh.id IS NOT NULL)
      )
      OR EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.series_keys k
        WHERE k.series_id = s.id
          AND (
            (k.kind = 'meeting-code' AND EXISTS (
              SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_cache ce
              WHERE ce.user_id = ${caller.userId} AND ce.meeting_code = k.value
            ))
            OR (k.kind = 'recurring-base-id' AND EXISTS (
              SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_cache ce
              WHERE ce.user_id = ${caller.userId}
                AND ce.recurring_event_id IS NOT NULL
                AND regexp_replace(ce.recurring_event_id, '_R\\d{8}T\\d{6}Z?$', '') = k.value
            ))
          )
      )
  `;
  return new Set(rows.map((r) => r.id));
}

/** Single-series form of visibleSeriesIds — the detail/mutation gate. */
export async function seriesVisibleToCaller(
  id: number,
  caller: { userId: string; email: string }
): Promise<boolean> {
  const vis = await visibleSeriesIds(caller);
  return vis.has(id);
}

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
  report: 'summary' | 'detailed-video' | 'detailed-text' | 'later';
  since: string;
  lastSweepAt?: string;
  lastError?: string | null;
}

export interface SeriesRow {
  id: number;
  title: string;
  created_by: string;
  notes: string | null;
  auto_import: SeriesAutoImportCfg | null;
  created_at: string;
  updated_at: string;
}

export interface SeriesKeyRow {
  id: number;
  series_id: number;
  kind: string;
  value: string;
  source: string;
}

export interface SeriesListEntry {
  id: number;
  title: string;
  member_count: number;
  last_recorded_at: string | null;
  /** Median gap between member occurrences, seconds — null under 2 members. */
  median_gap_secs: number | null;
  /** Auto-import is switched on for this series (index badge). */
  auto_enabled: boolean;
}

export interface SeriesMemberEntry {
  transcript_id: number;
  assemblyai_id: string;
  title: string | null;
  status: string;
  recorded_at: string | null;
  created_at: string;
  duration: number | null;
  how: string;
  /** Caller can open this transcript (owner or shared). */
  accessible: boolean;
  owner_is_caller: boolean;
}

export async function createSeries(
  userId: string,
  title: string,
  notes?: string | null
): Promise<SeriesRow> {
  const [row] = await sql<SeriesRow[]>`
    INSERT INTO ${sql(SCHEMA)}.series (title, created_by, notes)
    VALUES (${title}, ${userId}, ${notes ?? null})
    RETURNING *
  `;
  return row!;
}

export async function getSeries(id: number): Promise<SeriesRow | null> {
  const [row] = await sql<SeriesRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.series WHERE id = ${id}
  `;
  return row ?? null;
}

export async function updateSeries(
  id: number,
  patch: { title?: string; notes?: string | null },
  /** Who performed the edit — threaded to the series-label rename hook so
   * label_history attributes the follow-up rename to the real actor. */
  actorUserId?: string | null
): Promise<void> {
  let oldTitle: string | null = null;
  if (patch.title !== undefined) {
    const [cur] = await sql<Array<{ title: string }>>`
      SELECT title FROM ${sql(SCHEMA)}.series WHERE id = ${id}
    `;
    oldTitle = cur?.title ?? null;
    await sql`UPDATE ${sql(SCHEMA)}.series SET title = ${patch.title}, updated_at = NOW() WHERE id = ${id}`;
  }
  if (patch.notes !== undefined) {
    await sql`UPDATE ${sql(SCHEMA)}.series SET notes = ${patch.notes}, updated_at = NOW() WHERE id = ${id}`;
  }
  // Series label follows the title (AFTER the series write — a label failure
  // must never fail a rename).
  if (patch.title !== undefined && oldTitle !== null && oldTitle !== patch.title) {
    try {
      await onSeriesRenamed(id, oldTitle, patch.title, actorUserId);
    } catch (err) {
      console.warn(`[series-labels] rename hook failed for series ${id}:`, err);
    }
  }
}

export async function deleteSeries(id: number): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.series WHERE id = ${id}`;
  try {
    await onSeriesDeleted(id);
  } catch (err) {
    console.warn(`[series-labels] delete hook failed for series ${id}:`, err);
  }
}

export async function listSeries(): Promise<SeriesListEntry[]> {
  return sql<SeriesListEntry[]>`
    WITH gaps AS (
      SELECT m.series_id,
             extract(epoch FROM (
               lead(COALESCE(t.recorded_at, t.created_at)) OVER (
                 PARTITION BY m.series_id
                 ORDER BY COALESCE(t.recorded_at, t.created_at)
               ) - COALESCE(t.recorded_at, t.created_at)
             ))::float8 AS gap
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t
        ON t.id = m.transcript_id AND t.deleted_at IS NULL
    ),
    cadence AS (
      SELECT series_id,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap_secs
      FROM gaps WHERE gap IS NOT NULL
      GROUP BY series_id
    )
    SELECT s.id, s.title,
           count(m.id)::int AS member_count,
           max(COALESCE(t.recorded_at, t.created_at))::text AS last_recorded_at,
           c.median_gap_secs,
           COALESCE((s.auto_import->>'enabled')::boolean, false) AS auto_enabled
    FROM ${sql(SCHEMA)}.series s
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.series_id = s.id
    LEFT JOIN ${sql(SCHEMA)}.transcripts t
      ON t.id = m.transcript_id AND t.deleted_at IS NULL
    LEFT JOIN cadence c ON c.series_id = s.id
    GROUP BY s.id, s.title, c.median_gap_secs, s.auto_import
    ORDER BY max(COALESCE(t.recorded_at, t.created_at)) DESC NULLS LAST
  `;
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
  return sql<SeriesRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.series
    WHERE COALESCE((auto_import->>'enabled')::boolean, false)
    ORDER BY id
  `;
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
  outcome: 'imported' | 'deferred' | 'already' | 'failed';
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

/** Live memberships + transcripts outside any series — the index footer. */
export async function seriesTotals(): Promise<{ memberships: number; unattached: number }> {
  const [row] = await sql<Array<{ memberships: number; unattached: number }>>`
    SELECT
      count(m.id)::int AS memberships,
      count(t.id) FILTER (WHERE m.id IS NULL)::int AS unattached
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.transcript_id = t.id
    WHERE t.deleted_at IS NULL
      AND t.status NOT IN ('uploading', 'waiting')
  `;
  return row ?? { memberships: 0, unattached: 0 };
}

export type DupReason = 'same Meet code' | 'same recurring event' | 'same Teams meeting' | 'same name';

export interface DupSibling {
  id: number;
  title: string;
  member_count: number;
  /** Newest member's date — disambiguates same-named siblings in the UI. */
  last_recorded_at: string | null;
  reason: DupReason;
}

const DUP_REASON_BY_KIND: Record<string, DupReason> = {
  'meeting-code': 'same Meet code',
  'recurring-base-id': 'same recurring event',
  'ical-uid-base': 'same recurring event',
  'teams-join-url': 'same Teams meeting',
  'graph-meeting-id': 'same Teams meeting',
  'normalized-title': 'same name',
};
const DUP_REASON_RANK: DupReason[] = [
  'same recurring event',
  'same Meet code',
  'same Teams meeting',
  'same name',
];

/**
 * Probable-duplicate series, keyed by series id → its siblings. Two series
 * are siblings when they share evidence: a series key of the same kind+value,
 * OR their MEMBER transcripts point at the same Meet code / recurring event /
 * Teams meeting (series split by the backfill often differ only in which
 * keys got claimed — e.g. one holds the recurring-base-id, the other the
 * meeting code, while every member on both sides carries both). Title-only
 * matches are reported too, ranked last.
 */
export async function findDuplicateSeries(): Promise<Map<number, DupSibling[]>> {
  const pairs = await sql<Array<{ a: number; b: number; kind: string }>>`
    WITH sig AS (
      SELECT series_id, kind, value FROM ${sql(SCHEMA)}.series_keys
      UNION
      SELECT m.series_id, 'meeting-code', t.gmeet_context->>'meetingCode'
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
      WHERE t.gmeet_context->>'meetingCode' IS NOT NULL
      UNION
      SELECT m.series_id, 'recurring-base-id',
             regexp_replace(t.gmeet_context->>'recurringEventId', '_R\\d{8}T\\d{6}Z?$', '')
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
      WHERE t.gmeet_context->>'recurringEventId' IS NOT NULL
      UNION
      -- recurring instance ids are '<base>_YYYYMMDDTHHMMSSZ' — the base is
      -- the series even when recurringEventId was never captured
      SELECT m.series_id, 'recurring-base-id',
             regexp_replace(t.gmeet_context->>'eventId', '_\\d{8}T\\d{6}Z?$', '')
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
      WHERE t.gmeet_context->>'eventId' ~ '_\\d{8}T\\d{6}Z?$'
      UNION
      SELECT m.series_id, 'teams-join-url', t.gmeet_context->'teams'->>'joinWebUrl'
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
      WHERE t.gmeet_context->'teams'->>'joinWebUrl' IS NOT NULL
    )
    SELECT DISTINCT a.series_id AS a, b.series_id AS b, a.kind
    FROM sig a
    JOIN sig b ON b.kind = a.kind AND b.value = a.value AND b.series_id > a.series_id
    WHERE a.value IS NOT NULL AND a.value <> ''
  `;
  const series = await sql<
    Array<{ id: number; title: string; member_count: number; last_recorded_at: string | null }>
  >`
    SELECT s.id, s.title, count(m.id)::int AS member_count,
           max(COALESCE(t.recorded_at, t.created_at))::text AS last_recorded_at
    FROM ${sql(SCHEMA)}.series s
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.series_id = s.id
    LEFT JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
    GROUP BY s.id, s.title
  `;
  const byId = new Map(series.map((s) => [s.id, s]));

  // Best reason per unordered pair (strong evidence beats a shared name).
  const best = new Map<string, { a: number; b: number; reason: DupReason }>();
  const consider = (a: number, b: number, reason: DupReason) => {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    const cur = best.get(k);
    if (!cur || DUP_REASON_RANK.indexOf(reason) < DUP_REASON_RANK.indexOf(cur.reason)) {
      best.set(k, { a: Math.min(a, b), b: Math.max(a, b), reason });
    }
  };
  for (const p of pairs) {
    const reason = DUP_REASON_BY_KIND[p.kind];
    if (reason) consider(p.a, p.b, reason);
  }
  // Title-only matches (series_keys only hold normalized-title when a
  // transcript contributed one — the series' own title is checked here).
  const byNorm = new Map<string, number[]>();
  for (const s of series) {
    const n = normalizeTitle(s.title);
    if (n.length < 4) continue;
    byNorm.set(n, [...(byNorm.get(n) ?? []), s.id]);
  }
  for (const ids of byNorm.values()) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) consider(ids[i]!, ids[j]!, 'same name');
  }

  const out = new Map<number, DupSibling[]>();
  const push = (from: number, to: number, reason: DupReason) => {
    const s = byId.get(to);
    if (!s) return;
    out.set(from, [...(out.get(from) ?? []), { ...s, reason }]);
  };
  for (const { a, b, reason } of best.values()) {
    push(a, b, reason);
    push(b, a, reason);
  }
  for (const list of out.values()) list.sort((x, y) => y.member_count - x.member_count);
  return out;
}

/**
 * Fold one series into another (dupe repair): keys, members, and exclusions
 * move to the survivor, the loser is deleted — all in one transaction. Keys
 * can't collide (UNIQUE(kind,value) means a value lives in exactly one
 * series) and members can't either (transcript_id UNIQUE, series_id is the
 * moving part); exclusions may exist on both sides → keep-first.
 */
export async function mergeSeries(
  intoId: number,
  fromId: number,
  /** Who clicked the merge — attribution for the label follow-up. */
  actorUserId?: string | null
): Promise<{ movedMembers: number; movedKeys: number }> {
  // Snapshot label-rule state BEFORE the txn — the loser row dies inside it.
  const labelState = await preMergeLabelState(intoId, fromId).catch((err) => {
    console.warn(`[series-labels] pre-merge snapshot failed (${intoId}<-${fromId}):`, err);
    return null;
  });
  const result = await sql.begin(async (tx) => {
    const keys = await tx`
      UPDATE ${sql(SCHEMA)}.series_keys SET series_id = ${intoId}
      WHERE series_id = ${fromId} RETURNING id
    `;
    const members = await tx`
      UPDATE ${sql(SCHEMA)}.series_members SET series_id = ${intoId}
      WHERE series_id = ${fromId} RETURNING id
    `;
    await tx`
      INSERT INTO ${sql(SCHEMA)}.series_exclusions (series_id, transcript_id, excluded_by)
      SELECT ${intoId}, transcript_id, excluded_by
      FROM ${sql(SCHEMA)}.series_exclusions WHERE series_id = ${fromId}
      ON CONFLICT DO NOTHING
    `;
    await tx`DELETE FROM ${sql(SCHEMA)}.series WHERE id = ${fromId}`;
    return { movedMembers: members.length, movedKeys: keys.length };
  });
  // Series-label follow-up AFTER the merge commits: winner keeps/gets its
  // label, loser's rule dies, its assignments migrate (log-and-continue).
  if (labelState) {
    try {
      await onSeriesMerged(intoId, fromId, labelState, actorUserId);
    } catch (err) {
      // Idempotent hook — re-running applySeriesLabel(intoId) heals the
      // missing winner assignments.
      console.warn(
        `[series-labels] merge hook failed (${intoId}<-${fromId}) — heal: applySeriesLabel(${intoId}):`,
        err
      );
    }
  }
  // The loser's rule must never outlive its series: delete it even when the
  // snapshot failed or the hook threw mid-way (idempotent — the happy path
  // already removed it; assignments keep their labels, rule_id nulls out).
  try {
    await onSeriesDeleted(fromId);
  } catch (err) {
    console.warn(`[series-labels] loser-rule cleanup failed (series ${fromId}):`, err);
  }
  return result;
}

/** Transcripts in no series — the retro-attach sweep's work list. */
export async function listUnattachedTranscripts(): Promise<
  Array<{
    id: number;
    assemblyai_id: string;
    title: string | null;
    gmeet_context: GmeetContext | null;
    user_id: string;
  }>
> {
  return sql<
    Array<{
      id: number;
      assemblyai_id: string;
      title: string | null;
      gmeet_context: GmeetContext | null;
      user_id: string;
    }>
  >`
    SELECT t.id, t.assemblyai_id, t.title, t.gmeet_context, t.user_id
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.transcript_id = t.id
    WHERE m.id IS NULL
      AND t.deleted_at IS NULL
      AND t.status NOT IN ('uploading', 'waiting')
    ORDER BY COALESCE(t.recorded_at, t.created_at) DESC
  `;
}

/** Batch series lookup for calendar rows by stripped recurringEventId. */
export interface SeriesKeyHit {
  series_id: number;
  title: string;
  auto_import: SeriesAutoImportCfg | null;
}

export async function findSeriesByRecurringBaseIds(baseIds: string[]): Promise<Map<string, SeriesKeyHit>> {
  if (baseIds.length === 0) return new Map();
  const rows = await sql<Array<{ value: string } & SeriesKeyHit>>`
    SELECT k.value, k.series_id, s.title, s.auto_import
    FROM ${sql(SCHEMA)}.series_keys k
    JOIN ${sql(SCHEMA)}.series s ON s.id = k.series_id
    WHERE k.kind = 'recurring-base-id' AND k.value = ANY(${baseIds})
  `;
  return new Map(rows.map((r) => [r.value, { series_id: r.series_id, title: r.title, auto_import: r.auto_import }]));
}

/** Same, keyed by Meet code (series attach on codes too — a listing row
 * with no recurring id can still belong to an auto-importing series). */
export async function findSeriesByMeetingCodes(codes: string[]): Promise<Map<string, SeriesKeyHit>> {
  if (codes.length === 0) return new Map();
  const rows = await sql<Array<{ value: string } & SeriesKeyHit>>`
    SELECT k.value, k.series_id, s.title, s.auto_import
    FROM ${sql(SCHEMA)}.series_keys k
    JOIN ${sql(SCHEMA)}.series s ON s.id = k.series_id
    WHERE k.kind = 'meeting-code' AND k.value = ANY(${codes})
  `;
  return new Map(rows.map((r) => [r.value, { series_id: r.series_id, title: r.title, auto_import: r.auto_import }]));
}

/** Every series carrying an explicit auto-import setting (on OR off) — the
 * ones that override account auto-sync for their occurrences. */
export async function listSeriesWithAutoImport(): Promise<SeriesRow[]> {
  return sql<SeriesRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.series WHERE auto_import IS NOT NULL ORDER BY title
  `;
}

export async function listKeys(seriesId: number): Promise<SeriesKeyRow[]> {
  return sql<SeriesKeyRow[]>`
    SELECT id, series_id, kind, value, source
    FROM ${sql(SCHEMA)}.series_keys WHERE series_id = ${seriesId}
  `;
}

/** Attach evidence keys; a value already claimed by another series is left
 * with its current owner (first claim wins — human curation resolves fights). */
export async function addKeys(
  seriesId: number,
  keys: SeriesKeyInput[],
  source: 'import' | 'user' | 'backfill',
  userId: string | null
): Promise<void> {
  for (const k of keys) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.series_keys (series_id, kind, value, source, added_by)
      VALUES (${seriesId}, ${k.kind}, ${k.value}, ${source}, ${userId})
      ON CONFLICT (kind, value) DO NOTHING
    `;
  }
}

/** Series whose key bag matches any of these keys, most-matched first.
 * Returns which kinds matched so callers can tell strong from weak. */
export async function findSeriesByKeys(
  keys: SeriesKeyInput[]
): Promise<Array<{ series_id: number; title: string; matched_kinds: string[] }>> {
  if (keys.length === 0) return [];
  const kinds = keys.map((k) => k.kind);
  const values = keys.map((k) => k.value);
  return sql<Array<{ series_id: number; title: string; matched_kinds: string[] }>>`
    SELECT k.series_id, s.title,
           array_agg(DISTINCT k.kind) AS matched_kinds
    FROM ${sql(SCHEMA)}.series_keys k
    JOIN ${sql(SCHEMA)}.series s ON s.id = k.series_id
    JOIN unnest(${kinds}::text[], ${values}::text[]) AS q(kind, value)
      ON q.kind = k.kind AND q.value = k.value
    GROUP BY k.series_id, s.title
    ORDER BY count(*) DESC
  `;
}

export async function getMembership(
  transcriptId: number
): Promise<{ series_id: number; title: string; how: string } | null> {
  const [row] = await sql<Array<{ series_id: number; title: string; how: string }>>`
    SELECT m.series_id, s.title, m.how
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.series s ON s.id = m.series_id
    WHERE m.transcript_id = ${transcriptId}
  `;
  return row ?? null;
}

/** Attach (or move) a transcript to a series. Every membership-insert path
 * (routes, import auto-attach, retro sweep) funnels through here, so the
 * series-label hook after the insert covers them all. Label failures are
 * logged, never propagated — labels must not break series ops. */
export async function addMember(
  seriesId: number,
  transcriptId: number,
  how: 'auto' | 'confirmed' | 'manual',
  userId: string | null
): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.series_members (series_id, transcript_id, how, added_by)
    VALUES (${seriesId}, ${transcriptId}, ${how}, ${userId})
    ON CONFLICT (transcript_id)
    DO UPDATE SET series_id = ${seriesId}, how = ${how}, added_by = ${userId}, added_at = NOW()
  `;
  try {
    await syncSeriesLabelOnMemberAdd(seriesId, userId);
  } catch (err) {
    console.warn(`[series-labels] member-add hook failed for series ${seriesId}:`, err);
  }
}

/** Detach; `remember` writes an exclusion so guesses never resurface it. */
export async function removeMember(
  transcriptId: number,
  opts?: { rememberExclusionFor?: number; userId?: string }
): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.series_members WHERE transcript_id = ${transcriptId}`;
  if (opts?.rememberExclusionFor) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.series_exclusions (series_id, transcript_id, excluded_by)
      VALUES (${opts.rememberExclusionFor}, ${transcriptId}, ${opts.userId ?? null})
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function isExcluded(seriesId: number, transcriptId: number): Promise<boolean> {
  const [row] = await sql<Array<{ one: number }>>`
    SELECT 1 AS one FROM ${sql(SCHEMA)}.series_exclusions
    WHERE series_id = ${seriesId} AND transcript_id = ${transcriptId}
  `;
  return Boolean(row);
}

/** Members with a caller-visibility flag — inaccessible members render as
 * date + owner only, never content. */
export async function listMembers(
  seriesId: number,
  caller: { userId: string; email: string }
): Promise<SeriesMemberEntry[]> {
  const normEmail = caller.email.trim().toLowerCase();
  return sql<SeriesMemberEntry[]>`
    -- Title only for accessible members — the row-shape below promises
    -- "date + owner only, never content" for the rest, so enforce it in the
    -- contract, not just in what the component chooses to paint.
    SELECT m.transcript_id, t.assemblyai_id,
           CASE WHEN t.user_id = ${caller.userId} OR sh.id IS NOT NULL
                THEN t.title END AS title,
           t.status,
           t.recorded_at::text AS recorded_at, t.created_at::text AS created_at,
           t.duration, m.how,
           (t.user_id = ${caller.userId} OR sh.id IS NOT NULL) AS accessible,
           (t.user_id = ${caller.userId}) AS owner_is_caller
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares sh
      ON sh.transcript_id = t.id AND sh.shared_with_email = ${normEmail}
    WHERE m.series_id = ${seriesId}
      AND t.deleted_at IS NULL
    ORDER BY COALESCE(t.recorded_at, t.created_at) DESC
  `;
}

export interface SeriesSuggestion {
  transcript_id: number;
  assemblyai_id: string;
  title: string | null;
  recorded_at: string | null;
  created_at: string;
  matched_kinds: string[];
  /** Context so the "confirm?" row can say WHAT this meeting is. */
  status: string;
  duration: number | null;
  source: 'uploaded' | 'imported';
  /** Caller owns it (vs shared with them). */
  owned: boolean;
  provider: 'gmeet' | 'teams' | null;
  event_title: string | null;
  event_start: string | null;
  organizer_email: string | null;
  attendee_count: number;
}

/**
 * Caller-visible transcripts that match this series' key bag but aren't
 * members of ANY series and weren't explicitly excluded from this one —
 * the "we think these belong here, confirm?" list.
 */
export async function listSuggestedMembers(
  seriesId: number,
  caller: { userId: string; email: string }
): Promise<SeriesSuggestion[]> {
  const normEmail = caller.email.trim().toLowerCase();
  return sql<SeriesSuggestion[]>`
    SELECT t.id AS transcript_id, t.assemblyai_id, t.title,
           t.recorded_at::text AS recorded_at, t.created_at::text AS created_at,
           array_agg(DISTINCT k.kind) AS matched_kinds,
           t.status, t.duration, t.source,
           (t.user_id = ${caller.userId}) AS owned,
           CASE
             WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
             WHEN t.assemblyai_id LIKE 'gmeet-%'
                  OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
           END AS provider,
           NULLIF(t.gmeet_context->>'eventTitle', '') AS event_title,
           NULLIF(t.gmeet_context->>'startTime', '') AS event_start,
           NULLIF(t.gmeet_context->>'organizerEmail', '') AS organizer_email,
           COALESCE(jsonb_array_length(
             CASE WHEN jsonb_typeof(t.gmeet_context->'attendees') = 'array'
                  THEN t.gmeet_context->'attendees' END), 0)::int AS attendee_count
    FROM ${sql(SCHEMA)}.series_keys k
    JOIN ${sql(SCHEMA)}.transcripts t ON (
      (k.kind = 'meeting-code' AND t.gmeet_context->>'meetingCode' = k.value) OR
      (k.kind = 'recurring-base-id' AND
       regexp_replace(COALESCE(t.gmeet_context->>'recurringEventId',''), '_R\\d{8}T\\d{6}Z?$', '') = k.value) OR
      (k.kind = 'ical-uid-base' AND
       regexp_replace(regexp_replace(COALESCE(t.gmeet_context->>'iCalUID',''), '@google\\.com$', ''), '_R\\d{8}T\\d{6}Z?$', '') = k.value) OR
      (k.kind = 'teams-join-url' AND t.gmeet_context->'teams'->>'joinWebUrl' = k.value) OR
      (k.kind = 'graph-meeting-id' AND t.gmeet_context->'teams'->>'graphMeetingId' = k.value) OR
      -- mirror lib/series-keys normalizeTitle: strip date tokens, collapse
      -- punctuation, lowercase, trim (ascii approximation is fine here)
      (k.kind = 'normalized-title' AND
       btrim(lower(regexp_replace(
         regexp_replace(COALESCE(NULLIF(t.gmeet_context->>'eventTitle',''), t.title, ''),
                        '\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}', ' ', 'g'),
         '[^a-zA-Z0-9]+', ' ', 'g'))) = k.value)
    )
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.transcript_id = t.id
    LEFT JOIN ${sql(SCHEMA)}.series_exclusions x
      ON x.series_id = ${seriesId} AND x.transcript_id = t.id
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares sh
      ON sh.transcript_id = t.id AND sh.shared_with_email = ${normEmail}
    WHERE k.series_id = ${seriesId}
      AND m.id IS NULL
      AND x.transcript_id IS NULL
      AND (t.user_id = ${caller.userId} OR sh.id IS NOT NULL)
      AND t.status NOT IN ('uploading', 'waiting')
      AND t.deleted_at IS NULL
    GROUP BY t.id
    ORDER BY COALESCE(t.recorded_at, t.created_at) DESC
  `;
}

/**
 * Candidate series for one transcript (badge popover): all key matches, with
 * exclusions filtered out. Strong-kind matches first.
 */
export async function suggestSeriesForTranscript(
  transcriptId: number,
  ctx: GmeetContext | null,
  title: string | null
): Promise<Array<{ series_id: number; title: string; matched_kinds: string[]; strong: boolean }>> {
  const keys = keysFromContext(ctx, title);
  const matches = await findSeriesByKeys(keys);
  if (matches.length === 0) return [];
  const excluded = await sql<Array<{ series_id: number }>>`
    SELECT series_id FROM ${sql(SCHEMA)}.series_exclusions
    WHERE transcript_id = ${transcriptId}
  `;
  const excludedIds = new Set(excluded.map((e) => e.series_id));
  const strongSet = new Set(strongKeys(keys).map((k) => k.kind as string));
  return matches
    .filter((m) => !excludedIds.has(m.series_id))
    .map((m) => ({
      ...m,
      strong: m.matched_kinds.some((k) => strongSet.has(k)),
    }))
    .sort((a, b) => Number(b.strong) - Number(a.strong));
}
