import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import {
  archiveFilterSql,
  archiveParticipantsExpr,
} from '@/db-ops/meeting-filter-sql';
import { EMPTY_MEETING_FILTERS, type MeetingFilters } from '@/lib/server/meeting-filters';
import type { LabelFilter } from '@/lib/labels';
import type {
  GmeetContext,
  StoredTranscript,
  TranscriptResponse,
  TranscriptDayGroup,
  TranscriptListRow,
  TranscriptListV2Response,
  TranscriptSegment,
} from '@/lib/format';

export type TranscriptRow = StoredTranscript;

/**
 * User-scoped CRUD for the transcripts table.
 *
 * Every function takes `userId` as its first argument and every WHERE
 * clause enforces `user_id = ${userId}`. Do NOT add a function here that
 * reads or writes transcripts without this constraint — that would break
 * per-user ACL.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface TranscriptInsert {
  assemblyaiId: string;
  originalFilename: string | null;
  status: string;
  languageCode?: string | null;
  title?: string | null;
  audioUrl?: string | null;
  driveFileId?: string | null;
  gmeetContext?: GmeetContext | null;
}

export interface TranscriptStatusUpdate {
  status?: string;
  completedAt?: Date | null;
  duration?: number | null;
  speakerCount?: number | null;
  languageCode?: string | null;
  audioUrl?: string | null;
}

export interface ImportedTranscriptInsert {
  assemblyaiId: string;
  originalFilename: string | null;
  status: string;
  duration: number | null;
  speakerCount: number | null;
  languageCode: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
  audioUrl: string | null;
  importedContent: TranscriptResponse;
  title?: string | null;
  driveFileId?: string | null;
  gmeetContext?: GmeetContext | null;
}

export async function listForUser(userId: string): Promise<TranscriptRow[]> {
  const rows = await sql<TranscriptRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `;
  return rows;
}

/**
 * List every transcript visible to this user — ones they own plus ones
 * shared with their email. Each row carries a computed `access` field.
 *
 * Skinny column set: the full `imported_content` JSONB is NOT selected
 * because it can be tens of MB per row and the listing doesn't render it.
 * Fetch the full payload via /api/transcripts/:id/content on the detail
 * page instead.
 *
 * Owner identity (name/email) is not available here because we only have
 * the owner's SSO user_id, not their email.
 */
export async function listVisibleToUser(
  userId: string,
  email: string
): Promise<TranscriptListRow[]> {
  const normEmail = email.trim().toLowerCase();
  const rows = await sql<
    Array<TranscriptListRow & { __access: 'owner' | 'edit' | 'read' }>
  >`
    SELECT t.id, t.user_id, t.assemblyai_id, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.speaker_count,
           t.language_code, t.title, t.description, t.last_accessed,
           t.source, t.recorded_at, t.auto_notes_status,
           t.upload_bytes_received::float8 AS upload_bytes_received,
           t.upload_bytes_total::float8 AS upload_bytes_total,
           -- Which conferencing product the source meeting ran on (listing
           -- provider glyphs). 'teams' is stamped explicitly; anything with
           -- Meet identity (gmeet- id or a meeting code) is 'gmeet'.
           CASE
             WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
             WHEN t.assemblyai_id LIKE 'gmeet-%'
                  OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
           END AS provider,
           (t.gmeet_context->>'eventId') IS NOT NULL AS has_event,
           -- Deferred-import placeholders: mode drives the "waiting for
           -- Google to prepare the X" listing copy; error shows after give-up.
           t.gmeet_context->'deferredImport'->>'mode' AS deferred_mode,
           t.gmeet_context->'deferredImport'->>'error' AS deferred_error,
           t.gmeet_context->'deferredImport'->>'background' AS deferred_background,
           sm.series_id, se.title AS series_title,
           sus.series_id AS suspected_series_id, sus.title AS suspected_series_title,
           CASE
             WHEN t.user_id = ${userId} THEN 'owner'
             ELSE s.access
           END AS "__access"
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    LEFT JOIN ${sql(SCHEMA)}.series_members sm ON sm.transcript_id = t.id
    LEFT JOIN ${sql(SCHEMA)}.series se ON se.id = sm.series_id
    -- Suspected series for untagged rows: any evidence-key match that hasn't
    -- been excluded — surfaced as a dashed "…?" chip the user confirms/denies.
    -- The row's normalized values are computed ONCE in a MATERIALIZED CTE:
    -- without the fence the planner inlines them into the key predicates and
    -- re-runs the regexps for every (row × key) pair — measured 194ms vs
    -- 33ms for this whole listing query at 184 rows × 60 keys (2026-08-19).
    LEFT JOIN LATERAL (
      WITH norm AS MATERIALIZED (
        SELECT
          t.gmeet_context->>'meetingCode' AS meeting_code,
          regexp_replace(COALESCE(t.gmeet_context->>'recurringEventId',''), '_R\\d{8}T\\d{6}Z?$', '') AS recurring_base,
          regexp_replace(regexp_replace(COALESCE(t.gmeet_context->>'iCalUID',''), '@google\\.com$', ''), '_R\\d{8}T\\d{6}Z?$', '') AS ical_base,
          t.gmeet_context->'teams'->>'joinWebUrl' AS teams_join_url,
          t.gmeet_context->'teams'->>'graphMeetingId' AS graph_meeting_id,
          btrim(lower(regexp_replace(
            regexp_replace(COALESCE(NULLIF(t.gmeet_context->>'eventTitle',''), t.title, ''),
                           '\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}', ' ', 'g'),
            '[^a-zA-Z0-9]+', ' ', 'g'))) AS norm_title
      )
      SELECT k.series_id, se2.title
      FROM norm
      JOIN ${sql(SCHEMA)}.series_keys k ON (
        (k.kind = 'meeting-code' AND norm.meeting_code = k.value) OR
        (k.kind = 'recurring-base-id' AND norm.recurring_base = k.value) OR
        (k.kind = 'ical-uid-base' AND norm.ical_base = k.value) OR
        (k.kind = 'teams-join-url' AND norm.teams_join_url = k.value) OR
        (k.kind = 'graph-meeting-id' AND norm.graph_meeting_id = k.value) OR
        (k.kind = 'normalized-title' AND norm.norm_title = k.value)
      )
      JOIN ${sql(SCHEMA)}.series se2 ON se2.id = k.series_id
      WHERE NOT EXISTS (
              SELECT 1 FROM ${sql(SCHEMA)}.series_exclusions x
              WHERE x.series_id = k.series_id AND x.transcript_id = t.id
            )
      ORDER BY k.series_id
      LIMIT 1
    ) sus ON sm.id IS NULL
    WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
      AND t.deleted_at IS NULL
    ORDER BY t.created_at DESC
  `;

  return rows.map((r) => {
    const { __access, ...rest } = r;
    return {
      ...rest,
      access: __access,
      owner_email: null,
      owner_name: null,
    };
  });
}

/** Minimal row shape the AAI pending-refresh fan-out needs. */
export type PendingRefreshRow = Pick<
  TranscriptListRow,
  'user_id' | 'assemblyai_id' | 'status' | 'completed_at' | 'duration' | 'speaker_count'
>;

/**
 * Every visible row still in flight at AssemblyAI (queued/processing),
 * regardless of which listing page it would land on. Powers the v2 refresh
 * fan-out, which is decoupled from pagination so pending rows outside the
 * requested page keep getting refreshed. Synthetic `up-…`/`defer-…`/`ext-…`
 * placeholder ids never reached AAI, so they are excluded by id as well as
 * by status ('ext-' rows can sit in 'processing' while a background text
 * import normalizes).
 */
export async function listPendingVisibleToUser(
  userId: string,
  email: string
): Promise<PendingRefreshRow[]> {
  const normEmail = email.trim().toLowerCase();
  return sql<PendingRefreshRow[]>`
    SELECT t.user_id, t.assemblyai_id, t.status, t.completed_at, t.duration,
           t.speaker_count
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
      AND t.deleted_at IS NULL
      AND t.status NOT IN ('completed', 'error', 'uploading', 'waiting')
      AND t.assemblyai_id NOT LIKE 'up-%'
      AND t.assemblyai_id NOT LIKE 'defer-%'
      AND t.assemblyai_id NOT LIKE 'ext-%'
  `;
}

export interface TranscriptListPageOpts {
  tab: 'all' | 'mine' | 'shared' | 'trash';
  /** YYYY-MM-DD inclusive bounds on the day key, interpreted in `tz`. */
  from: string | null;
  to: string | null;
  /** Validated IANA timezone name (caller falls back to 'UTC'). */
  tz: string;
  /** Active search text (>= 2 chars) or null. */
  q: string | null;
  /** Max day buckets per page (1..60). */
  days: number;
  /** Soft row target: stop adding whole days once reached (1..200). */
  minRows: number;
  /** Exclusive day-key cursor: only days strictly older. */
  cursor: string | null;
  /** Shared people/provider filters (lib/server/meeting-filters) — applied
   * to the page AND the tab counts. `q` inside it is ignored here (the
   * listing's own `q` above carries the matched_in/snippet semantics). */
  filters?: MeetingFilters;
  /** Label filter (`?label=<id|none>&exact=1`, lib/labels parseLabelFilter) —
   * applied to the page AND the tab counts, like `filters`. null/undefined =
   * no label filter. */
  labelFilter?: LabelFilter | null;
}

/**
 * `AND (…)` fragment for the `?label=` listing filter against a transcripts
 * query aliased `t` (docs/labels-design.md §7). Subtree-inclusive unless
 * `exact`; `none` = no label at all. Empty fragment when no filter — the
 * legacy listing never passes one, so it stays byte-identical.
 */
function labelFilterSql(f: LabelFilter | null | undefined): ReturnType<typeof sql> {
  if (!f) return sql``;
  if (f.kind === 'none') {
    return sql`AND NOT EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.transcript_labels tl WHERE tl.transcript_id = t.id
    )`;
  }
  if (f.exact) {
    return sql`AND EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.transcript_labels tl
      WHERE tl.transcript_id = t.id AND tl.label_id = ${f.id}
    )`;
  }
  // Descendants: the assignment's label is the filter label itself or has
  // its path_key as a '/'-terminated prefix (resolved once via a scalar
  // subquery; prefix compare instead of LIKE so no pattern escaping is
  // needed — the EXISTS is per transcript, so the assignment index does the
  // work).
  return sql`AND EXISTS (
    SELECT 1 FROM ${sql(SCHEMA)}.transcript_labels tl
    JOIN ${sql(SCHEMA)}.labels l ON l.id = tl.label_id
    CROSS JOIN (SELECT path_key FROM ${sql(SCHEMA)}.labels WHERE id = ${f.id}) root
    WHERE tl.transcript_id = t.id
      AND (l.id = ${f.id}
           OR left(l.path_key, length(root.path_key) + 1) = root.path_key || '/')
  )`;
}

/** Raw shape of the paged listing query before JS post-mapping. */
type PagedRawRow = Omit<TranscriptListRow, 'access' | 'owner_email' | 'owner_name'> & {
  /** Organizer + attendee emails (lower-cased, de-duplicated) — the optional
   * `participants` field of v2 rows. */
  participants: string[];
  __access: 'owner' | 'edit' | 'read' | null;
  day_key: string;
  __total_days: number;
  __page_days: number;
};

/**
 * Day-bucketed page of the listing (GET /api/transcripts?v=2). Same
 * visibility, skinny column set, and computed columns as listVisibleToUser
 * (incl. the MATERIALIZED suspected-series fence — applied only to the
 * page's rows here), but:
 *  - sort key everywhere is COALESCE(recorded_at, created_at) DESC, id DESC;
 *  - rows are bucketed by that key's date in the caller's timezone and pages
 *    NEVER split a day: whole days are added until `minRows` rows or `days`
 *    buckets are reached;
 *  - `q` (>= 2 chars) filters server-side across title/filename/description/
 *    auto_notes/imported text and stamps matched_in + a SQL-cut snippet on
 *    each row (same approach as searchVisibleTranscripts);
 *  - tab=trash serves the caller's own soft-deleted rows (owner-only, no
 *    series joins) with the same bucketing.
 */
export async function listPagedForUser(
  userId: string,
  email: string,
  opts: TranscriptListPageOpts
): Promise<TranscriptListV2Response> {
  const { tab, from, to, tz, q, days, minRows, cursor } = opts;
  const filters = opts.filters ?? EMPTY_MEETING_FILTERS;
  const labelFilter = opts.labelFilter ?? null;
  const normEmail = email.trim().toLowerCase();
  const isTrash = tab === 'trash';
  const pattern = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;

  // Fragment builders (fresh fragment per use site).
  const dayKey = () => sql`(COALESCE(t.recorded_at, t.created_at) AT TIME ZONE ${tz}::text)::date`;
  const rangeAndSearch = () => sql`
    ${from ? sql`AND ${dayKey()} >= ${from}::date` : sql``}
    ${to ? sql`AND ${dayKey()} <= ${to}::date` : sql``}
    ${
      pattern && q
        ? sql`AND (
            t.title ILIKE ${pattern}
            OR t.original_filename ILIKE ${pattern}
            OR t.description ILIKE ${pattern}
            OR t.auto_notes ILIKE ${pattern}
            OR t.imported_content->>'text' ILIKE ${pattern}
          )`
        : sql``
    }
    ${archiveFilterSql(filters)}
    ${labelFilterSql(labelFilter)}
  `;

  const pagePromise = sql<PagedRawRow[]>`
    WITH base AS (
      SELECT t.id, t.user_id, t.assemblyai_id, t.original_filename, t.status,
             t.created_at, t.completed_at, t.duration, t.speaker_count,
             t.language_code, t.title, t.description, t.last_accessed,
             t.source, t.recorded_at, t.auto_notes_status,
             t.upload_bytes_received::float8 AS upload_bytes_received,
             t.upload_bytes_total::float8 AS upload_bytes_total,
             CASE
               WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
               WHEN t.assemblyai_id LIKE 'gmeet-%'
                    OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
             END AS provider,
             (t.gmeet_context->>'eventId') IS NOT NULL AS has_event,
             t.gmeet_context->'deferredImport'->>'mode' AS deferred_mode,
             t.gmeet_context->'deferredImport'->>'error' AS deferred_error,
             t.gmeet_context->'deferredImport'->>'background' AS deferred_background,
             -- Meetings with more than one recording: extra Meet segments
             -- (videoParts, on top of the primary), a stitched multi-file
             -- upload (uploadedParts), or a combined re-transcription.
             GREATEST(
               1 + COALESCE(jsonb_array_length(t.gmeet_context->'videoParts'), 0),
               COALESCE(jsonb_array_length(t.gmeet_context->'uploadedParts'), 0),
               COALESCE((t.gmeet_context->>'combinedParts')::int, 0)
             )::int AS recording_count,
             -- Series auto-import lifecycle: 'passed' = imported AND speaker
             -- review jumped through automatically (report generated
             -- unattended — the blue dot), 'gated' = auto-imported but held
             -- for human review, 'auto' = auto-imported, not yet evaluated.
             CASE
               WHEN (t.gmeet_context->'autoReview'->>'passed')::boolean THEN 'passed'
               WHEN t.gmeet_context ? 'autoReview' THEN 'gated'
               WHEN t.gmeet_context ? 'autoImport' THEN 'auto'
             END AS auto_state,
             ${isTrash ? sql`t.deleted_at::text` : sql`NULL::text`} AS deleted_at,
             ${
               isTrash
                 ? sql`'owner'`
                 : sql`CASE WHEN t.user_id = ${userId} THEN 'owner' ELSE s.access END`
             } AS __access,
             COALESCE(t.recorded_at, t.created_at) AS sort_key,
             ${dayKey()} AS day_key,
             ${
               pattern && q
                 ? sql`CASE
                     WHEN t.title ILIKE ${pattern} THEN 'title'
                     WHEN t.original_filename ILIKE ${pattern} THEN 'filename'
                     WHEN t.description ILIKE ${pattern} THEN 'description'
                     WHEN t.auto_notes ILIKE ${pattern} THEN 'notes'
                     ELSE 'content'
                   END`
                 : sql`NULL::text`
             } AS matched_in,
             ${
               pattern && q
                 ? sql`CASE
                     WHEN t.title ILIKE ${pattern} OR t.original_filename ILIKE ${pattern} THEN NULL
                     WHEN t.description ILIKE ${pattern} THEN
                       substring(t.description FROM greatest(position(lower(${q}) IN lower(t.description)) - 40, 1) FOR 140)
                     WHEN t.auto_notes ILIKE ${pattern} THEN
                       substring(t.auto_notes FROM greatest(position(lower(${q}) IN lower(t.auto_notes)) - 40, 1) FOR 140)
                     ELSE
                       substring(t.imported_content->>'text' FROM greatest(position(lower(${q}) IN lower(t.imported_content->>'text')) - 40, 1) FOR 140)
                   END`
                 : sql`NULL::text`
             } AS snippet
      FROM ${sql(SCHEMA)}.transcripts t
      ${
        isTrash
          ? sql``
          : sql`LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
                  ON s.transcript_id = t.id
                  AND s.shared_with_email = ${normEmail}`
      }
      WHERE ${
        isTrash
          ? sql`t.user_id = ${userId} AND t.deleted_at IS NOT NULL`
          : sql`(t.user_id = ${userId} OR s.id IS NOT NULL) AND t.deleted_at IS NULL`
      }
        ${tab === 'mine' ? sql`AND t.user_id = ${userId}` : sql``}
        ${tab === 'shared' ? sql`AND t.user_id <> ${userId}` : sql``}
        ${rangeAndSearch()}
        ${cursor ? sql`AND ${dayKey()} < ${cursor}::date` : sql``}
    ),
    day_counts AS (
      SELECT day_key, count(*)::int AS n FROM base GROUP BY day_key
    ),
    ordered AS (
      SELECT day_key, n,
             sum(n) OVER (ORDER BY day_key DESC) AS cum,
             row_number() OVER (ORDER BY day_key DESC) AS rn
      FROM day_counts
    ),
    -- Whole days only: keep taking days (newest first) while the running row
    -- count BEFORE the day is still short of minRows, hard-capped at the
    -- days param. The first day is always taken even if it alone exceeds
    -- minRows.
    page_days AS (
      SELECT day_key FROM ordered
      WHERE rn <= ${days}::int AND (rn = 1 OR (cum - n) < ${minRows}::int)
    )
    SELECT b.id, b.user_id, b.assemblyai_id, b.original_filename, b.status,
           b.created_at, b.completed_at, b.duration, b.speaker_count,
           b.language_code, b.title, b.description, b.last_accessed,
           b.source, b.recorded_at, b.auto_notes_status,
           b.upload_bytes_received, b.upload_bytes_total,
           b.provider, b.has_event, b.deferred_mode, b.deferred_error,
           b.recording_count, b.auto_state,
           -- Evaluated for the page's rows only (t is joined below for both
           -- branches) — base is materialized for day_counts, so anything
           -- computed there runs for every visible row in range.
           ${archiveParticipantsExpr()} AS participants,
           -- Org-wide labels on the row (docs/labels-design.md §7), page rows
           -- only — outside the materialized base, next to the series join.
           lbl.labels AS labels,
           b.deleted_at, b.__access, b.matched_in, b.snippet,
           b.day_key::text AS day_key,
           ${
             isTrash
               ? sql`NULL::int AS series_id, NULL::text AS series_title,
                     NULL::int AS suspected_series_id, NULL::text AS suspected_series_title,`
               : sql`sm.series_id, se.title AS series_title,
                     sus.series_id AS suspected_series_id, sus.title AS suspected_series_title,`
           }
           (SELECT count(*)::int FROM day_counts) AS __total_days,
           (SELECT count(*)::int FROM page_days) AS __page_days
    FROM base b
    JOIN page_days pd ON pd.day_key = b.day_key
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = b.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(
               jsonb_build_object('id', l.id, 'name', l.name, 'path', l.path, 'color', l.color)
               ORDER BY l.path_key), '[]'::jsonb) AS labels
      FROM ${sql(SCHEMA)}.transcript_labels tl
      JOIN ${sql(SCHEMA)}.labels l ON l.id = tl.label_id
      WHERE tl.transcript_id = b.id
    ) lbl ON true
    ${
      isTrash
        ? sql``
        : sql`
          LEFT JOIN ${sql(SCHEMA)}.series_members sm ON sm.transcript_id = b.id
          LEFT JOIN ${sql(SCHEMA)}.series se ON se.id = sm.series_id
          -- Same suspected-series lookup as listVisibleToUser, applied only to
          -- the page's rows. The MATERIALIZED fence is load-bearing (see the
          -- perf note there): without it the planner re-runs the regexps for
          -- every (row × key) pair.
          LEFT JOIN LATERAL (
            WITH norm AS MATERIALIZED (
              SELECT
                t.gmeet_context->>'meetingCode' AS meeting_code,
                regexp_replace(COALESCE(t.gmeet_context->>'recurringEventId',''), '_R\\d{8}T\\d{6}Z?$', '') AS recurring_base,
                regexp_replace(regexp_replace(COALESCE(t.gmeet_context->>'iCalUID',''), '@google\\.com$', ''), '_R\\d{8}T\\d{6}Z?$', '') AS ical_base,
                t.gmeet_context->'teams'->>'joinWebUrl' AS teams_join_url,
                t.gmeet_context->'teams'->>'graphMeetingId' AS graph_meeting_id,
                btrim(lower(regexp_replace(
                  regexp_replace(COALESCE(NULLIF(t.gmeet_context->>'eventTitle',''), t.title, ''),
                                 '\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}', ' ', 'g'),
                  '[^a-zA-Z0-9]+', ' ', 'g'))) AS norm_title
            )
            SELECT k.series_id, se2.title
            FROM norm
            JOIN ${sql(SCHEMA)}.series_keys k ON (
              (k.kind = 'meeting-code' AND norm.meeting_code = k.value) OR
              (k.kind = 'recurring-base-id' AND norm.recurring_base = k.value) OR
              (k.kind = 'ical-uid-base' AND norm.ical_base = k.value) OR
              (k.kind = 'teams-join-url' AND norm.teams_join_url = k.value) OR
              (k.kind = 'graph-meeting-id' AND norm.graph_meeting_id = k.value) OR
              (k.kind = 'normalized-title' AND norm.norm_title = k.value)
            )
            JOIN ${sql(SCHEMA)}.series se2 ON se2.id = k.series_id
            WHERE NOT EXISTS (
                    SELECT 1 FROM ${sql(SCHEMA)}.series_exclusions x
                    WHERE x.series_id = k.series_id AND x.transcript_id = b.id
                  )
            ORDER BY k.series_id
            LIMIT 1
          ) sus ON sm.id IS NULL`
    }
    ORDER BY b.sort_key DESC, b.id DESC
  `;

  // Tab badge counts: all/mine/shared respect the from/to + q filters (they
  // label the tabs above the FILTERED list); trash is the caller's trashed-row
  // count, global over from/to/q (as it always was) but narrowed by the
  // people/provider filters so the badge agrees with the filtered trash tab
  // (the scalar subquery re-aliases transcripts as `t` for archiveFilterSql).
  const countsPromise = sql<
    [{ all_count: number; mine_count: number; shared_count: number; trash_count: number }]
  >`
    SELECT
      count(*)::int AS all_count,
      count(*) FILTER (WHERE t.user_id = ${userId})::int AS mine_count,
      count(*) FILTER (WHERE t.user_id <> ${userId})::int AS shared_count,
      (SELECT count(*)::int FROM ${sql(SCHEMA)}.transcripts t
        WHERE t.user_id = ${userId} AND t.deleted_at IS NOT NULL
        ${archiveFilterSql(filters)}
        ${labelFilterSql(labelFilter)}) AS trash_count
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
      AND t.deleted_at IS NULL
      ${rangeAndSearch()}
  `;

  const [raw, countsRows] = await Promise.all([pagePromise, countsPromise]);

  const dayGroups: TranscriptDayGroup[] = [];
  let current: TranscriptDayGroup | null = null;
  for (const r of raw) {
    // __total_days/__page_days are window metadata stamped on every row, not row fields.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { day_key, __access, __total_days: _t, __page_days: _p, matched_in, snippet, deleted_at, ...rest } = r;
    const row: TranscriptListRow = {
      ...rest,
      ...(isTrash ? { deleted_at } : {}),
      ...(q ? { matched_in, snippet } : {}),
      access: __access ?? 'read',
      owner_email: null,
      owner_name: null,
    };
    if (!current || current.key !== day_key) {
      current = { key: day_key, rows: [], totalSecs: 0 };
      dayGroups.push(current);
    }
    current.rows.push(row);
    current.totalSecs += Number(row.duration ?? 0) || 0;
  }

  const totalDays = raw[0]?.__total_days ?? 0;
  const pageDays = raw[0]?.__page_days ?? 0;
  const hasMore = totalDays > pageDays;
  const c = countsRows[0];

  return {
    days: dayGroups,
    counts: {
      all: c?.all_count ?? 0,
      mine: c?.mine_count ?? 0,
      shared: c?.shared_count ?? 0,
      trash: c?.trash_count ?? 0,
    },
    nextCursor: hasMore && dayGroups.length > 0 ? dayGroups[dayGroups.length - 1]!.key : null,
    hasMore,
  };
}

/**
 * Owner-agnostic lookup, for the Meet "join existing import" flow ONLY. The
 * caller has deliberately NOT been granted visibility yet — the join route
 * proves their access against Google (their own token) before anything from
 * this row reaches them.
 */
export async function getAnyByAssemblyaiId(
  assemblyaiId: string
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcripts
    WHERE assemblyai_id = ${assemblyaiId} AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getForUser(
  userId: string,
  assemblyaiId: string
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createForUser(
  userId: string,
  data: TranscriptInsert
): Promise<TranscriptRow> {
  const rows = await sql<TranscriptRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcripts (
      user_id, assemblyai_id, original_filename, status, language_code, title, audio_url, source,
      drive_file_id, gmeet_context
    ) VALUES (
      ${userId}, ${data.assemblyaiId}, ${data.originalFilename ?? null},
      ${data.status}, ${data.languageCode ?? null}, ${data.title ?? null},
      ${data.audioUrl ?? null}, 'uploaded',
      ${data.driveFileId ?? null},
      ${data.gmeetContext ? sql.json(data.gmeetContext as unknown as never) : null}
    )
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET original_filename = EXCLUDED.original_filename,
          status = EXCLUDED.status,
          language_code = COALESCE(EXCLUDED.language_code, ${sql(SCHEMA)}.transcripts.language_code),
          title = COALESCE(EXCLUDED.title, ${sql(SCHEMA)}.transcripts.title),
          audio_url = COALESCE(EXCLUDED.audio_url, ${sql(SCHEMA)}.transcripts.audio_url),
          drive_file_id = COALESCE(EXCLUDED.drive_file_id, ${sql(SCHEMA)}.transcripts.drive_file_id),
          gmeet_context = COALESCE(EXCLUDED.gmeet_context, ${sql(SCHEMA)}.transcripts.gmeet_context)
    RETURNING *
  `;
  publishEvent({ kind: 'created', assemblyaiId: data.assemblyaiId });
  return rows[0]!;
}

export interface DeferredPlaceholderInsert {
  /** Synthetic `defer-<uuid>` id. Video-mode executions promote it to the
   * real AAI id; transcript-mode executions delete it in favor of the
   * `gmeet-…` imported row. */
  placeholderId: string;
  title?: string | null;
  /** Event start — so the queued row sorts on the meeting's day. */
  recordedAt?: string | null;
  /** Must carry `deferredImport` (the poller's work marker). */
  gmeetContext: GmeetContext;
}

/**
 * Create the placeholder row for an import queued while Google is still
 * preparing the needed artifact (gmeet_context.deferredImport). Status
 * 'waiting' — a sixth row status alongside uploading/queued/processing/
 * completed/error; excluded from AAI refresh, series eligibility, and row
 * navigation the same way 'uploading' is.
 */
export async function createDeferredPlaceholder(
  userId: string,
  data: DeferredPlaceholderInsert
): Promise<TranscriptRow> {
  const recordedAt =
    data.recordedAt && !Number.isNaN(Date.parse(data.recordedAt))
      ? new Date(data.recordedAt)
      : null;
  const rows = await sql<TranscriptRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcripts (
      user_id, assemblyai_id, original_filename, status, title,
      source, recorded_at, gmeet_context
    ) VALUES (
      ${userId}, ${data.placeholderId}, null,
      'waiting', ${data.title ?? null},
      'uploaded', ${recordedAt},
      ${sql.json(data.gmeetContext as unknown as never)}
    )
    RETURNING *
  `;
  publishEvent({ kind: 'created', assemblyaiId: data.placeholderId });
  return rows[0]!;
}

/**
 * Deferred imports still waiting on Google (the deferred-import poller's
 * work list). Same jsonb-scan reasoning as listRecordingPendingRows.
 */
export async function listDeferredImportRows(limit: number): Promise<
  Array<{
    id: number;
    user_id: string;
    assemblyai_id: string;
    gmeet_context: GmeetContext;
  }>
> {
  return sql<
    Array<{ id: number; user_id: string; assemblyai_id: string; gmeet_context: GmeetContext }>
  >`
    SELECT id, user_id, assemblyai_id, gmeet_context
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'waiting'
      AND deleted_at IS NULL
      AND gmeet_context->'deferredImport'->>'status' = 'waiting'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

/**
 * An already-queued Teams deferred import for the same occurrence (join URL
 * is shared by every occurrence of a recurring meeting, so the event start
 * disambiguates). Second Import click returns this row instead of queueing a
 * twin placeholder.
 */
export async function findWaitingTeamsDeferred(
  userId: string,
  joinWebUrl: string,
  startTime: string | null
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId}
      AND status = 'waiting'
      AND deleted_at IS NULL
      AND assemblyai_id LIKE 'defer-%'
      AND gmeet_context->'teams'->>'joinWebUrl' = ${joinWebUrl}
      AND gmeet_context->>'startTime' IS NOT DISTINCT FROM ${startTime}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Terminal failure for a deferred import: flip the placeholder row to
 * 'error' (so the listing shows Failed instead of an eternal spinner) and
 * write the resolved marker in the same statement.
 */
export async function markDeferredImportFailed(
  userId: string,
  placeholderId: string,
  marker: NonNullable<GmeetContext['deferredImport']>
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET status = 'error',
        gmeet_context = COALESCE(gmeet_context, '{}'::jsonb) ||
          ${sql.json({ deferredImport: marker } as unknown as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${placeholderId}
  `;
  publishEvent({ kind: 'status', assemblyaiId: placeholderId });
}

export interface UploadingPlaceholderInsert {
  /** Synthetic `up-<uuid>` id — rewritten to the real AAI id on promote. */
  placeholderId: string;
  originalFilename: string | null;
  languageCode?: string | null;
  title?: string | null;
  gmeetContext?: GmeetContext | null;
  /** Content-Length of the incoming body; null when the client omitted it. */
  bytesTotal?: number | null;
}

/**
 * Create the row for an upload whose bytes are still arriving. Exists so the
 * upload is visible (to the owner AND anyone auto-shared) from the first
 * byte, not only once AAI accepts the job. `upload_progress_at` starts
 * ticking immediately so the stale-upload sweeper can reap orphans.
 */
export async function createUploadingPlaceholder(
  userId: string,
  data: UploadingPlaceholderInsert
): Promise<TranscriptRow> {
  const rows = await sql<TranscriptRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcripts (
      user_id, assemblyai_id, original_filename, status, language_code, title,
      source, gmeet_context, upload_bytes_received, upload_bytes_total,
      upload_progress_at
    ) VALUES (
      ${userId}, ${data.placeholderId}, ${data.originalFilename ?? null},
      'uploading', ${data.languageCode ?? null}, ${data.title ?? null},
      'uploaded',
      ${data.gmeetContext ? sql.json(data.gmeetContext as unknown as never) : null},
      0, ${data.bytesTotal ?? null}, now()
    )
    RETURNING *
  `;
  publishEvent({ kind: 'created', assemblyaiId: data.placeholderId });
  return rows[0]!;
}

/**
 * Debounced progress write during the byte stream. Called with `bytes` it
 * also notifies listing pages over SSE; called without (the heartbeat used
 * during the AAI re-upload leg, where byte count no longer moves) it only
 * bumps `upload_progress_at` so the sweeper knows the upload is alive.
 */
export async function updateUploadProgress(
  userId: string,
  placeholderId: string,
  bytesReceived?: number
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET upload_bytes_received = COALESCE(${bytesReceived ?? null}, upload_bytes_received),
        upload_progress_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${placeholderId} AND status = 'uploading'
  `;
  if (bytesReceived !== undefined) {
    publishEvent({ kind: 'status', assemblyaiId: placeholderId });
  }
}

/**
 * Swap the placeholder's synthetic id for the real AAI id once the
 * transcription is accepted. Shares survive (they key on the numeric row id).
 * Covers both placeholder kinds: `up-…` uploads (status 'uploading') and
 * `defer-…` deferred imports (status 'waiting'). Returns null when the row
 * is gone — e.g. the sweeper reaped it, or the user deleted the queued
 * import — so the caller can fall back to a fresh insert.
 */
export async function promoteUploadingRow(
  userId: string,
  placeholderId: string,
  data: { assemblyaiId: string; status: string; audioUrl?: string | null }
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET assemblyai_id = ${data.assemblyaiId},
        status = ${data.status},
        audio_url = ${data.audioUrl ?? null}
    WHERE user_id = ${userId} AND assemblyai_id = ${placeholderId}
      AND status IN ('uploading', 'waiting')
    RETURNING *
  `;
  if (rows[0]) publishEvent({ kind: 'status', assemblyaiId: data.assemblyaiId });
  return rows[0] ?? null;
}

/**
 * The live placeholder row of a multi-file single-meeting upload group
 * (gmeet_context.uploadGroup.id). Parts 2..N of the group land on this row.
 */
export async function findUploadGroupRow(
  userId: string,
  groupId: string
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId}
      AND status = 'uploading'
      AND deleted_at IS NULL
      AND gmeet_context->'uploadGroup'->>'id' = ${groupId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Uploads whose heartbeat went quiet — closed tab, network drop, or pm2
 * restart mid-stream. Nothing is recoverable (the byte stream is gone), so
 * the sweeper deletes row + temp file.
 */
export async function listStaleUploads(
  stallMinutes: number,
  limit: number
): Promise<Array<{ user_id: string; assemblyai_id: string }>> {
  return sql<Array<{ user_id: string; assemblyai_id: string }>>`
    SELECT user_id, assemblyai_id
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'uploading'
      AND deleted_at IS NULL
      AND COALESCE(upload_progress_at, created_at) < now() - make_interval(mins => ${stallMinutes})
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

/**
 * Insert an imported transcript with its frozen content. The user_id is the
 * importing user — they own the imported copy. Other users importing the same
 * AAI transcript get their own row (per-user ACL preserved).
 */
export async function createImportedForUser(
  userId: string,
  data: ImportedTranscriptInsert
): Promise<TranscriptRow> {
  const rows = await sql<TranscriptRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcripts (
      user_id, assemblyai_id, original_filename, status,
      created_at, completed_at, duration, speaker_count, language_code,
      audio_url, source, imported_content, title, drive_file_id, gmeet_context
    ) VALUES (
      ${userId}, ${data.assemblyaiId}, ${data.originalFilename ?? null}, ${data.status},
      ${data.createdAt ?? sql`now()`}, ${data.completedAt ?? null},
      ${data.duration ?? null}, ${data.speakerCount ?? null},
      ${data.languageCode ?? null}, ${data.audioUrl ?? null}, 'imported',
      ${sql.json(data.importedContent as unknown as never)},
      ${data.title ?? null},
      ${data.driveFileId ?? null},
      ${data.gmeetContext ? sql.json(data.gmeetContext as unknown as never) : null}
    )
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET status = EXCLUDED.status,
          created_at = COALESCE(EXCLUDED.created_at, ${sql(SCHEMA)}.transcripts.created_at),
          completed_at = COALESCE(EXCLUDED.completed_at, ${sql(SCHEMA)}.transcripts.completed_at),
          duration = COALESCE(EXCLUDED.duration, ${sql(SCHEMA)}.transcripts.duration),
          speaker_count = COALESCE(EXCLUDED.speaker_count, ${sql(SCHEMA)}.transcripts.speaker_count),
          language_code = COALESCE(EXCLUDED.language_code, ${sql(SCHEMA)}.transcripts.language_code),
          audio_url = COALESCE(EXCLUDED.audio_url, ${sql(SCHEMA)}.transcripts.audio_url),
          imported_content = EXCLUDED.imported_content,
          title = COALESCE(EXCLUDED.title, ${sql(SCHEMA)}.transcripts.title),
          drive_file_id = COALESCE(EXCLUDED.drive_file_id, ${sql(SCHEMA)}.transcripts.drive_file_id),
          gmeet_context = COALESCE(EXCLUDED.gmeet_context, ${sql(SCHEMA)}.transcripts.gmeet_context),
          source = 'imported'
    RETURNING *
  `;
  publishEvent({ kind: 'created', assemblyaiId: data.assemblyaiId });
  return rows[0]!;
}

export interface VisibleDupe {
  assemblyai_id: string;
  title: string | null;
  user_id: string;
  created_at: string;
}

/**
 * Dedupe lookup for the Google Meet import: find any transcript visible to
 * this user (owned or shared with their email) that was imported from the
 * same Drive recording. Returns a skinny descriptor for the conflict UI.
 */
export async function findVisibleByDriveFileId(
  userId: string,
  email: string,
  driveFileId: string
): Promise<VisibleDupe | null> {
  const normEmail = email.trim().toLowerCase();
  const rows = await sql<VisibleDupe[]>`
    SELECT t.assemblyai_id, t.title, t.user_id, t.created_at
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    WHERE t.drive_file_id = ${driveFileId}
      AND t.deleted_at IS NULL
      AND (t.user_id = ${userId} OR s.id IS NOT NULL)
    ORDER BY (t.user_id = ${userId}) DESC, t.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Same dedupe, keyed by assemblyai_id — used for Meet-transcript-only imports
 * whose synthetic id (`gmeet-<docId>`) is identical for every importer of the
 * same Doc.
 */
export async function findVisibleByAssemblyaiId(
  userId: string,
  email: string,
  assemblyaiId: string
): Promise<VisibleDupe | null> {
  const normEmail = email.trim().toLowerCase();
  const rows = await sql<VisibleDupe[]>`
    SELECT t.assemblyai_id, t.title, t.user_id, t.created_at
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    WHERE t.assemblyai_id = ${assemblyaiId}
      AND t.deleted_at IS NULL
      AND (t.user_id = ${userId} OR s.id IS NOT NULL)
    ORDER BY (t.user_id = ${userId}) DESC, t.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Set the local audio path after we've successfully downloaded the bytes
 * during an import. Stored as an absolute path on the server filesystem.
 */
export async function setLocalAudioPathForUser(
  userId: string,
  assemblyaiId: string,
  localAudioPath: string
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET local_audio_path = ${localAudioPath}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

/**
 * Cache the full AAI transcript payload on the row. The `imported_content`
 * column was originally added for the import flow (where the bytes are
 * frozen at import time), but it doubles as a content cache for uploaded
 * transcripts too — AAI content is immutable once `completed`, so once we
 * fetch it once we never need to hit AAI for that row again. This makes the
 * transcript detail page load almost entirely from Postgres.
 */
export async function setCachedContentForUser(
  userId: string,
  assemblyaiId: string,
  content: TranscriptResponse
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET imported_content = ${sql.json(content as unknown as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

/** @deprecated use setCachedContentForUser — kept for the import flow's clarity */
export const setImportedContentForUser = setCachedContentForUser;

/**
 * Sweep candidates for the auto-notes watchdog: completed transcripts whose
 * notes never ran (status NULL, older than the grace window) or whose run is
 * stuck in 'running' — a pm2 restart kills in-flight generations and nothing
 * else ever retries them.
 */
/**
 * Notes runs that died mid-flight (status stuck at 'running' — pm2 restarts
 * kill in-flight generations). Never-ran transcripts are deliberately NOT
 * picked up any more: notes generation is human-gated behind the speaker
 * review step, so only runs a human already triggered get recovered.
 */
export async function listNotesBacklog(
  stuckMinutes: number,
  limit: number
): Promise<Array<{ user_id: string; assemblyai_id: string; auto_notes_status: string | null }>> {
  return sql<Array<{ user_id: string; assemblyai_id: string; auto_notes_status: string | null }>>`
    SELECT user_id, assemblyai_id, auto_notes_status
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'completed'
      AND deleted_at IS NULL
      AND auto_notes_status = 'running'
      AND auto_notes_at < now() - make_interval(mins => ${stuckMinutes})
    ORDER BY COALESCE(completed_at, created_at) DESC
    LIMIT ${limit}
  `;
}

/**
 * Speaker-ID passes that never ran (upload paths that skip the
 * post-completion hook) or died mid-flight. Only transcripts still awaiting
 * notes are interesting — once notes exist the review moment has passed.
 */
export async function listSpeakerIdBacklog(
  graceMinutes: number,
  stuckMinutes: number,
  limit: number
): Promise<Array<{ user_id: string; assemblyai_id: string; speaker_id_status: string | null }>> {
  return sql<Array<{ user_id: string; assemblyai_id: string; speaker_id_status: string | null }>>`
    SELECT user_id, assemblyai_id, speaker_id_status
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'completed'
      AND deleted_at IS NULL
      AND auto_notes_status IS NULL
      AND (
        (speaker_id_status IS NULL
          AND COALESCE(completed_at, created_at) < now() - make_interval(mins => ${graceMinutes})
          AND COALESCE(completed_at, created_at) > now() - interval '7 days')
        OR
        (speaker_id_status = 'running'
          AND speaker_id_at < now() - make_interval(mins => ${stuckMinutes}))
      )
    ORDER BY COALESCE(completed_at, created_at) DESC
    LIMIT ${limit}
  `;
}

/**
 * Auto-notes state machine writes. `status` transitions:
 * null -> 'running' -> 'completed' | 'error'. Notes/error are set atomically
 * with the status so the UI never sees a half-written state.
 */
export async function setAutoNotesForUser(
  userId: string,
  assemblyaiId: string,
  update: { status: string; notes?: string | null; error?: string | null }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET auto_notes_status = ${update.status},
        auto_notes = ${update.notes !== undefined ? update.notes : sql`auto_notes`},
        auto_notes_error = ${update.error ?? null},
        auto_notes_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'notes', assemblyaiId });
}

/** Same status-machine contract as setAutoNotesForUser, for the detailed
 * report tier. Reuses the 'notes' live event so open pages refresh. */
export async function setAutoReportForUser(
  userId: string,
  assemblyaiId: string,
  update: { status: string; report?: string | null; error?: string | null }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET auto_report_status = ${update.status},
        auto_report = ${update.report !== undefined ? update.report : sql`auto_report`},
        auto_report_error = ${update.error ?? null},
        auto_report_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'notes', assemblyaiId });
}

/** Same status-machine contract, for the speaker-identification pass. */
export async function setSpeakerIdForUser(
  userId: string,
  assemblyaiId: string,
  update: { status: string; error?: string | null }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET speaker_id_status = ${update.status},
        speaker_id_error = ${update.error ?? null},
        speaker_id_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'notes', assemblyaiId });
}

export async function setAutoSegmentsForUser(
  userId: string,
  assemblyaiId: string,
  segments: TranscriptSegment[]
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET auto_segments = ${sql.json(segments as unknown as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

export async function updateStatusForUser(
  userId: string,
  assemblyaiId: string,
  update: TranscriptStatusUpdate
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET
      status = COALESCE(${update.status ?? null}, status),
      completed_at = COALESCE(${update.completedAt ?? null}, completed_at),
      duration = COALESCE(${update.duration ?? null}, duration),
      speaker_count = COALESCE(${update.speakerCount ?? null}, speaker_count),
      language_code = COALESCE(${update.languageCode ?? null}, language_code),
      audio_url = COALESCE(${update.audioUrl ?? null}, audio_url)
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING *
  `;
  if (rows[0]) publishEvent({ kind: 'status', assemblyaiId });
  return rows[0] ?? null;
}

export async function updateMetaForUser(
  userId: string,
  assemblyaiId: string,
  meta: { title?: string | null; description?: string | null }
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET
      title = COALESCE(${meta.title ?? null}, title),
      description = COALESCE(${meta.description ?? null}, description)
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING *
  `;
  if (rows[0]) publishEvent({ kind: 'meta', assemblyaiId });
  return rows[0] ?? null;
}

/** Set (or clear) when the meeting actually happened. */
export async function setRecordedAtForUser(
  userId: string,
  assemblyaiId: string,
  recordedAt: Date | null
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET recorded_at = ${recordedAt}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

/**
 * Merge calendar-event metadata into gmeet_context (retro-linking an
 * uploaded recording to its real invite). Existing keys not present in the
 * patch are preserved.
 */
export async function mergeGmeetContextForUser(
  userId: string,
  assemblyaiId: string,
  patch: Partial<GmeetContext>,
  opts?: {
    /** Skip the SSE fan-out — for bookkeeping writes (poller heartbeats)
     * that shouldn't make every open page re-fetch. */
    quiet?: boolean;
  }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = COALESCE(gmeet_context, '{}'::jsonb) || ${sql.json(patch as unknown as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  if (!opts?.quiet) publishEvent({ kind: 'meta', assemblyaiId });
}

/**
 * Stamp a videoParts entry (matched by fileId) with its stored filename and
 * byte count after a successful Drive pull. Atomic in SQL — the poller and
 * the sweeper both fetch parts, and a read-modify-write in JS could clobber
 * a concurrent stamp of a DIFFERENT part on the same row.
 */
export async function setVideoPartStoredForUser(
  userId: string,
  assemblyaiId: string,
  fileId: string,
  patch: { filename: string; bytes: number }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = jsonb_set(
      gmeet_context,
      '{videoParts}',
      (
        SELECT jsonb_agg(
          CASE WHEN p->>'fileId' = ${fileId}
            THEN p || ${sql.json({ ...patch, fetchedAt: new Date().toISOString() } as unknown as never)}
            ELSE p
          END
          ORDER BY ord
        )
        FROM jsonb_array_elements(gmeet_context->'videoParts') WITH ORDINALITY AS t(p, ord)
      )
    )
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
      AND jsonb_typeof(gmeet_context->'videoParts') = 'array'
      AND jsonb_array_length(gmeet_context->'videoParts') > 0
  `;
  publishEvent({ kind: 'meta', assemblyaiId });
}

/**
 * Rows waiting on Google to finish generating a Meet recording file
 * (gmeet_context.recordingPending.status = 'waiting'). Sequential scan over
 * the jsonb is fine at this table's size; oldest first so long-waiting rows
 * aren't starved by fresh imports.
 */
export async function listRecordingPendingRows(limit: number): Promise<
  Array<{
    id: number;
    user_id: string;
    assemblyai_id: string;
    gmeet_context: GmeetContext;
  }>
> {
  return sql<
    Array<{ id: number; user_id: string; assemblyai_id: string; gmeet_context: GmeetContext }>
  >`
    SELECT id, user_id, assemblyai_id, gmeet_context
    FROM ${sql(SCHEMA)}.transcripts
    WHERE gmeet_context->'recordingPending'->>'status' = 'waiting'
      AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

/**
 * Rows with known-but-unfetched recording bytes — the video-fetch sweeper's
 * work list: no local audio yet (Meet videoFileId / Teams recordingId), OR
 * extra videoParts whose files are known on Drive but not stored. Excludes
 * rows still waiting on Google to GENERATE a file (recording-poller's job)
 * and rows the sweeper already gave up on; backoff between attempts is
 * applied by the sweeper in JS. Recent rows first — that's where people are
 * looking.
 */
export async function listVideoFetchCandidates(limit: number): Promise<
  Array<{
    id: number;
    user_id: string;
    assemblyai_id: string;
    local_audio_path: string | null;
    gmeet_context: GmeetContext;
  }>
> {
  return sql<
    Array<{
      id: number;
      user_id: string;
      assemblyai_id: string;
      local_audio_path: string | null;
      gmeet_context: GmeetContext;
    }>
  >`
    SELECT id, user_id, assemblyai_id, local_audio_path, gmeet_context
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'completed'
      AND deleted_at IS NULL
      AND gmeet_context IS NOT NULL
      AND COALESCE(gmeet_context->'recordingPending'->>'status', '') <> 'waiting'
      AND COALESCE(gmeet_context->'videoAutoFetch'->>'status', 'pending') = 'pending'
      AND created_at > now() - interval '30 days'
      AND (
        (local_audio_path IS NULL
         AND (gmeet_context->>'videoFileId' IS NOT NULL
              OR gmeet_context->'teams'->>'recordingId' IS NOT NULL))
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(gmeet_context->'videoParts') = 'array'
              THEN gmeet_context->'videoParts' ELSE '[]'::jsonb END
          ) p
          WHERE p->>'filename' IS NULL AND p->>'fileId' IS NOT NULL
        )
      )
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export async function touchLastAccessedForUser(
  userId: string,
  assemblyaiId: string
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET last_accessed = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

export async function deleteForUser(
  userId: string,
  assemblyaiId: string
): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    DELETE FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING id
  `;
  if (rows.length > 0) publishEvent({ kind: 'deleted', assemblyaiId });
  return rows.length > 0;
}

/**
 * Soft delete: stamp deleted_at so the row vanishes from listings, search,
 * series, dedupe, and every background job, while keeping the AAI
 * transcript, audio files, shares, and notes intact for restore. Publishes
 * 'deleted' so open listings drop the row like a hard delete.
 */
export async function softDeleteForUser(
  userId: string,
  assemblyaiId: string
): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET deleted_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (rows.length > 0) publishEvent({ kind: 'deleted', assemblyaiId });
  return rows.length > 0;
}

/** Undo a soft delete. Publishes 'created' so open listings pick it back up. */
export async function restoreForUser(
  userId: string,
  assemblyaiId: string
): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET deleted_at = NULL
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId} AND deleted_at IS NOT NULL
    RETURNING id
  `;
  if (rows.length > 0) publishEvent({ kind: 'created', assemblyaiId });
  return rows.length > 0;
}

/**
 * The trash view: the caller's OWN soft-deleted rows, newest deletion first.
 * Sharees never see trashed rows anywhere — trash is owner-only. Same skinny
 * column set as listVisibleToUser (no imported_content).
 */
export async function listDeletedForUser(userId: string): Promise<TranscriptListRow[]> {
  const rows = await sql<TranscriptListRow[]>`
    SELECT t.id, t.user_id, t.assemblyai_id, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.speaker_count,
           t.language_code, t.title, t.description, t.last_accessed,
           t.source, t.recorded_at, t.auto_notes_status,
           t.upload_bytes_received::float8 AS upload_bytes_received,
           t.upload_bytes_total::float8 AS upload_bytes_total,
           CASE
             WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
             WHEN t.assemblyai_id LIKE 'gmeet-%'
                  OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
           END AS provider,
           (t.gmeet_context->>'eventId') IS NOT NULL AS has_event,
           t.gmeet_context->'deferredImport'->>'mode' AS deferred_mode,
           t.gmeet_context->'deferredImport'->>'error' AS deferred_error,
           t.deleted_at::text AS deleted_at
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE t.user_id = ${userId} AND t.deleted_at IS NOT NULL
    ORDER BY t.deleted_at DESC
  `;
  return rows.map((r) => ({ ...r, access: 'owner' as const, owner_email: null, owner_name: null }));
}
