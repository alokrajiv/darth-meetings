import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { GmeetContext } from '@/lib/format';

/**
 * Offline plan rows: the meetings a device may keep offline, plus a `rev`
 * fingerprint the client compares to decide whether a pinned copy is stale.
 *
 * Visibility is the SAME predicate as listVisibleToUser (owner OR a
 * transcript_shares row for the caller's lower-cased email, not soft-
 * deleted), narrowed to status = 'completed' — an offline copy of a row
 * that is still transcribing would be frozen mid-flight.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface OfflinePlanRow {
  assemblyai_id: string;
  title: string | null;
  recorded_at: string | null;
  created_at: string;
  /** Seconds (AAI audio_duration). */
  duration: number | null;
  provider: 'gmeet' | 'teams' | null;
  local_audio_path: string | null;
  video_parts: NonNullable<GmeetContext['videoParts']> | null;
  /** md5 over everything the meeting page renders from the row. */
  rev: string;
}

/**
 * `rev` covers the row fields the transcript page shows (title, description,
 * the three AI artefact stamps, completed_at), the media identity
 * (local_audio_path + videoParts) and the newest edit to the two OWNER-
 * keyed satellite tables (transcript_edits / speaker_mappings are keyed by
 * the owner's user_id + assemblyai_id — collaborators write into the
 * owner's rows, see transcript-shares.ts). `concat` keeps every separator
 * for NULLs (unlike concat_ws) so a value moving between columns changes
 * the hash.
 */
const revExpr = () => sql`
  md5(concat(
    t.title, '|', t.description, '|',
    t.completed_at::text, '|', t.auto_notes_at::text, '|',
    t.auto_report_at::text, '|', t.speaker_id_at::text, '|',
    t.local_audio_path, '|', (t.gmeet_context->'videoParts')::text, '|',
    (SELECT max(e.updated_at) FROM ${sql(SCHEMA)}.transcript_edits e
      WHERE e.user_id = t.user_id AND e.assemblyai_id = t.assemblyai_id)::text, '|',
    (SELECT max(m.updated_at) FROM ${sql(SCHEMA)}.speaker_mappings m
      WHERE m.user_id = t.user_id AND m.assemblyai_id = t.assemblyai_id)::text
  ))
`;

/**
 * Newest `limit` completed meetings visible to the caller, or exactly the
 * given `ids` (visible ones only, no ordering promise). When the caller
 * both owns a row and was shared another user's row with the same AAI id
 * (UNIQUE is per user_id + assemblyai_id), the owned row wins — the same
 * preference resolveAccess applies — so each id appears once.
 */
export async function listOfflinePlanRows(
  userId: string,
  email: string,
  opts: { limit: number } | { ids: string[] }
): Promise<OfflinePlanRow[]> {
  const normEmail = email.trim().toLowerCase();
  const ids = 'ids' in opts ? opts.ids : null;
  const limit = 'limit' in opts ? opts.limit : null;
  if (ids !== null && ids.length === 0) return [];
  if (limit !== null && limit <= 0) return [];

  return sql<OfflinePlanRow[]>`
    WITH visible AS (
      SELECT t.id, t.assemblyai_id, t.title, t.recorded_at, t.created_at, t.duration,
             CASE
               WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
               WHEN t.assemblyai_id LIKE 'gmeet-%'
                    OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
             END AS provider,
             t.local_audio_path,
             t.gmeet_context->'videoParts' AS video_parts,
             ${revExpr()} AS rev,
             row_number() OVER (
               PARTITION BY t.assemblyai_id
               ORDER BY (t.user_id = ${userId}) DESC, t.id DESC
             ) AS rn
      FROM ${sql(SCHEMA)}.transcripts t
      LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
        ON s.transcript_id = t.id
       AND s.shared_with_email = ${normEmail}
      WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND t.status = 'completed'
        ${ids !== null ? sql`AND t.assemblyai_id = ANY(${ids})` : sql``}
    )
    SELECT assemblyai_id, title, recorded_at, created_at, duration, provider,
           local_audio_path, video_parts, rev
    FROM visible
    WHERE rn = 1
    ORDER BY COALESCE(recorded_at, created_at) DESC, id DESC
    ${limit !== null ? sql`LIMIT ${limit}` : sql``}
  `;
}
