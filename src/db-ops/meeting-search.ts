import 'server-only';
import type postgres from 'postgres';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import {
  SEARCH_HIT_LIMIT,
  SQL_WINDOW_BEFORE,
  SQL_WINDOW_LEN,
  type MeetingSearchRawRow,
  type ShapedSearch,
} from '@/lib/meeting-search';

// The results panel's search (GET /api/search; lib/meeting-search.ts has the
// semantics). Same visibility as every listing: owned + shared-with-email,
// not trashed, not temporary. Every term must occur in one of the five
// fields — one OR per term over the per-field trigram indexes (migration
// 012), ANDed, so the planner can BitmapAnd the BitmapOrs. Hits whose title
// holds every term rank first, then newest. Only the ≤30 hit rows ever get
// their snippet window cut (lower() of a transcript is not free), and only
// a 400-char window leaves the database.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/** AND of `per(pattern)` over every pattern (≥1 pattern guaranteed). */
function allOf(patterns: readonly string[], per: (p: string) => Fragment): Fragment {
  return patterns.slice(1).reduce((acc, p) => sql`${acc} AND ${per(p)}`, per(patterns[0]!));
}

export async function searchMeetingsForPanel(
  userId: string,
  email: string,
  shaped: ShapedSearch,
  limit = SEARCH_HIT_LIMIT
): Promise<MeetingSearchRawRow[]> {
  const normEmail = email.trim().toLowerCase();
  const anyField = (p: string) => sql`(
    t.title ILIKE ${p}
    OR t.original_filename ILIKE ${p}
    OR t.description ILIKE ${p}
    OR t.auto_notes ILIKE ${p}
    OR t.imported_content->>'text' ILIKE ${p}
  )`;
  const inTitle = (p: string) => sql`COALESCE(t.title ILIKE ${p}, false)`;
  // Earliest position of any term in the lower-cased body (LEAST skips NULLs).
  const earliest = sql`LEAST(${shaped.lowered
    .slice(1)
    .reduce(
      (acc, t) => sql`${acc}, NULLIF(strpos(lb.body, ${t}), 0)`,
      sql`NULLIF(strpos(lb.body, ${shaped.lowered[0]!}), 0)`
    )})`;

  return sql<MeetingSearchRawRow[]>`
    WITH hits AS (
      SELECT t.id,
             CASE WHEN t.user_id = ${userId} THEN 'owner' ELSE s.access END AS access,
             (${allOf(shaped.patterns, inTitle)}) AS title_hit,
             COALESCE(t.recorded_at, t.created_at) AS sort_key
      FROM ${sql(SCHEMA)}.transcripts t
      LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
        ON s.transcript_id = t.id
       AND s.shared_with_email = ${normEmail}
      WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND NOT t.scratch
        AND ${allOf(shaped.patterns, anyField)}
      ORDER BY title_hit DESC, sort_key DESC, t.id DESC
      LIMIT ${limit}
    )
    SELECT t.assemblyai_id AS id, t.user_id, t.title, t.original_filename,
           t.recorded_at, t.created_at, t.duration, t.source,
           h.access,
           (t.gmeet_context->>'eventId') IS NOT NULL AS has_event,
           t.gmeet_context->'recorder'->>'recordingId' AS recorder_recording_id,
           CASE
             WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
             WHEN t.assemblyai_id LIKE 'gmeet-%'
                  OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
           END AS provider,
           lbl.labels,
           snip.field AS snip_field,
           snip.win AS snip_window,
           snip.win_start AS snip_window_start,
           snip.at_end AS snip_at_end
    FROM hits h
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = h.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(
               jsonb_build_object('id', l.id, 'name', l.name, 'path', l.path, 'color', l.color)
               ORDER BY l.path_key), '[]'::jsonb) AS labels
      FROM ${sql(SCHEMA)}.transcript_labels tl
      JOIN ${sql(SCHEMA)}.labels l ON l.id = tl.label_id
      WHERE tl.transcript_id = t.id
    ) lbl ON true
    LEFT JOIN LATERAL (
      SELECT b.field,
             substring(b.body FROM greatest(p.pos - ${SQL_WINDOW_BEFORE}::int, 1) FOR ${SQL_WINDOW_LEN}::int) AS win,
             greatest(p.pos - ${SQL_WINDOW_BEFORE}::int, 1) AS win_start,
             char_length(b.body) < greatest(p.pos - ${SQL_WINDOW_BEFORE}::int, 1) + ${SQL_WINDOW_LEN}::int AS at_end
      FROM (VALUES (1, 'description', t.description),
                   (2, 'notes', t.auto_notes),
                   (3, 'content', t.imported_content->>'text')) AS b(ord, field, body)
      CROSS JOIN LATERAL (SELECT lower(b.body) AS body) lb
      CROSS JOIN LATERAL (SELECT ${earliest} AS pos) p
      WHERE b.body IS NOT NULL AND p.pos IS NOT NULL
      ORDER BY b.ord
      LIMIT 1
    ) snip ON true
    ORDER BY h.title_hit DESC, h.sort_key DESC, h.id DESC
  `;
}
