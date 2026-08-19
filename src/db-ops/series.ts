import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { keysFromContext, strongKeys, type SeriesKeyInput } from '@/lib/series-keys';
import type { GmeetContext } from '@/lib/format';

/**
 * Recurring-call series: the curated first-class object behind the
 * "recurring call" badge. Series are org-global (no per-user ACL — this is
 * an internal tool); per-transcript visibility is still enforced wherever
 * member transcript CONTENT is returned.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface SeriesRow {
  id: number;
  title: string;
  created_by: string;
  notes: string | null;
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
  patch: { title?: string; notes?: string | null }
): Promise<void> {
  if (patch.title !== undefined) {
    await sql`UPDATE ${sql(SCHEMA)}.series SET title = ${patch.title}, updated_at = NOW() WHERE id = ${id}`;
  }
  if (patch.notes !== undefined) {
    await sql`UPDATE ${sql(SCHEMA)}.series SET notes = ${patch.notes}, updated_at = NOW() WHERE id = ${id}`;
  }
}

export async function deleteSeries(id: number): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.series WHERE id = ${id}`;
}

export async function listSeries(): Promise<SeriesListEntry[]> {
  return sql<SeriesListEntry[]>`
    SELECT s.id, s.title,
           count(m.id)::int AS member_count,
           max(COALESCE(t.recorded_at, t.created_at))::text AS last_recorded_at
    FROM ${sql(SCHEMA)}.series s
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.series_id = s.id
    LEFT JOIN ${sql(SCHEMA)}.transcripts t
      ON t.id = m.transcript_id AND t.deleted_at IS NULL
    GROUP BY s.id, s.title
    ORDER BY max(COALESCE(t.recorded_at, t.created_at)) DESC NULLS LAST
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

/** Attach (or move) a transcript to a series. */
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
    SELECT m.transcript_id, t.assemblyai_id, t.title, t.status,
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
           array_agg(DISTINCT k.kind) AS matched_kinds
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
    GROUP BY t.id, t.assemblyai_id, t.title, t.recorded_at, t.created_at
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
