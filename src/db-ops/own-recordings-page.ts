import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { BARE_TITLE_PG } from '@/lib/meeting-title';
import {
  ilikePattern,
  type RecordingItemKind,
  type RecordingSection,
  type RecordingSectionCounts,
  type RecordingsPageQuery,
} from '@/lib/recordings-page';
import type { TranscriptListRow } from '@/lib/format';
import type { RecorderRecordingRow } from '@/db-ops/recorder';

/**
 * The Recordings surface, paginated (owner decision 2026-09-23; the pure
 * contract is lib/recordings-page.ts).
 *
 * STRICTLY THE CALLER'S OWN (invariant I2). Each of the three sources is
 * asked with its owner predicate in SQL — `recordings.owner_user_id`,
 * `transcripts.user_id`, `recorder_recordings.user_id` — on the indexes that
 * lead with it (`recordings_standalone_owner_idx` from 049,
 * `transcripts_user_created_idx`, `recorder_recordings_user_started_idx`).
 * There is no share join anywhere here: a temporary row somebody shared WITH
 * the caller is theirs, not the caller's, and is not listed. There is no day
 * window either — an upload from a year ago pages like one from today.
 *
 * "Bare" (a legacy upload attached to no meeting: no calendar event and no
 * human title) is decided IN SQL with the twin of `hasNoRealTitle`
 * (lib/meeting-title `BARE_TITLE_PG`), so it can be paged over; a test runs
 * both over the same titles.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface PageKey {
  kind: RecordingItemKind;
  id: string;
  section: RecordingSection;
  /** Microseconds since the epoch, as a string. */
  sort_us: string;
}

export interface OwnRecordingsPageResult {
  keys: PageKey[];
  /** The key the next page starts after, or null at the end. */
  next: PageKey | null;
  counts: RecordingSectionCounts;
}

function usOf(expr: ReturnType<typeof sql>) {
  // numeric in PG ≥ 14 — exact, so the microsecond key never drifts.
  return sql`floor(extract(epoch FROM ${expr}) * 1000000)::bigint`;
}

/**
 * The merged set as one CTE body. `withStandalone` = migration 049 is there
 * (it implies 044's `recordings`); without it the standalone arm and the
 * registry's "already uploaded as a recording" test are simply absent.
 */
function itemsSql(userId: string, q: RecordingsPageQuery, withStandalone: boolean) {
  const match = (cols: ReturnType<typeof sql>[]) => {
    const needle = q.q;
    if (!needle) return sql`true`;
    const one = (c: ReturnType<typeof sql>) =>
      q.regex ? sql`COALESCE(${c}, '') ~* ${needle}` : sql`COALESCE(${c}, '') ILIKE ${ilikePattern(needle)}`;
    return cols.slice(1).reduce((acc, c) => sql`${acc} OR ${one(c)}`, one(cols[0]!));
  };

  const title = sql`btrim(COALESCE(t.title, ''), E' \\t\\r\\n')`;
  const bareTitle = sql`(
    ${title} = ''
    OR (btrim(COALESCE(t.original_filename, ''), E' \\t\\r\\n') <> ''
        AND ${title} = btrim(t.original_filename, E' \\t\\r\\n'))
    OR ${title} ~* ${BARE_TITLE_PG.fileExt}
    OR ${title} ~ ${BARE_TITLE_PG.recorderName}
    OR ${title} ~* ${BARE_TITLE_PG.defaultMemo}
  )`;

  const standalone = withStandalone
    ? sql`
      SELECT 'recording'::text AS kind, r.id::text AS id,
             CASE WHEN r.expires_at IS NULL THEN 'uploaded' ELSE 'temporary' END AS section,
             ${usOf(sql`COALESCE(r.started_at, r.created_at)`)} AS sort_us
      FROM ${sql(SCHEMA)}.recordings r
      WHERE r.owner_user_id = ${userId} AND r.standalone AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${sql(SCHEMA)}.meeting_clips c
          JOIN ${sql(SCHEMA)}.transcripts tc ON tc.id = c.transcript_id
          WHERE c.recording_id = r.id AND tc.deleted_at IS NULL)
        AND (${match([sql`r.title`, sql`r.upload_state->>'originalFilename'`])})
      UNION ALL`
    : sql``;

  return sql`
    ${standalone}
    SELECT 'meeting'::text AS kind, t.assemblyai_id AS id,
           CASE WHEN t.scratch THEN 'temporary' ELSE 'uploaded' END AS section,
           ${usOf(sql`COALESCE(t.recorded_at, t.created_at)`)} AS sort_us
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE t.user_id = ${userId} AND t.deleted_at IS NULL
      AND (t.scratch OR ((t.gmeet_context->>'eventId') IS NULL AND ${bareTitle}))
      AND (${match([sql`t.title`, sql`t.original_filename`])})
    UNION ALL
    SELECT 'registry'::text AS kind, rr.id::text AS id, 'mac' AS section,
           ${usOf(sql`COALESCE(rr.started_at, rr.created_at)`)} AS sort_us
    FROM ${sql(SCHEMA)}.recorder_recordings rr
    WHERE rr.user_id = ${userId}
      AND rr.status IN ('recording', 'local', 'uploading', 'upload_failed')
      -- Not already here as an upload: a meeting row of the caller's that
      -- the bytes became, or (049) a standalone recording.
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcripts t2
        WHERE t2.user_id::text = rr.user_id AND t2.deleted_at IS NULL
          AND (t2.assemblyai_id = rr.transcript_id
               OR t2.gmeet_context->'recorder'->>'recordingId' = rr.id::text))
      ${
        withStandalone
          ? sql`AND NOT EXISTS (
                  SELECT 1 FROM ${sql(SCHEMA)}.recordings r2
                  WHERE r2.owner_user_id = rr.user_id AND r2.recorder_recording_id = rr.id
                    AND r2.deleted_at IS NULL)`
          : sql``
      }
      AND (${match([sql`rr.call->>'title'`])})
  `;
}

/**
 * One page of keys (newest first) plus the per-section counts, in two
 * statements over the same owner-scoped CTE. `limit = 0` = counts only.
 * Throws `RecordingsRegexError` for an invalid `q` under `regex`.
 */
export async function listOwnRecordingsPage(
  userId: string,
  q: RecordingsPageQuery,
  withStandalone: boolean
): Promise<OwnRecordingsPageResult> {
  const items = itemsSql(userId, q, withStandalone);
  const c = q.cursor;
  const after = c
    ? sql`AND (i.sort_us < ${c.sortUs}::bigint
               OR (i.sort_us = ${c.sortUs}::bigint AND i.kind > ${c.kind})
               OR (i.sort_us = ${c.sortUs}::bigint AND i.kind = ${c.kind} AND i.id < ${c.id}))`
    : sql``;
  try {
    const [page, counts] = await Promise.all([
      q.limit > 0
        ? sql<PageKey[]>`
            WITH i AS (${items})
            SELECT i.kind, i.id, i.section, i.sort_us::text AS sort_us
            FROM i
            WHERE i.section = ANY(${q.sections}::text[]) ${after}
            ORDER BY i.sort_us DESC, i.kind ASC, i.id DESC
            LIMIT ${q.limit + 1}
          `
        : Promise.resolve([] as PageKey[]),
      sql<Array<{ section: RecordingSection; n: number }>>`
        WITH i AS (${items})
        SELECT i.section, count(*)::int AS n FROM i GROUP BY i.section
      `,
    ]);
    const keys = [...page];
    const hasMore = keys.length > q.limit;
    if (hasMore) keys.length = q.limit;
    const out: RecordingSectionCounts = { mac: 0, uploaded: 0, temporary: 0 };
    for (const row of counts) out[row.section] = row.n;
    return { keys, next: hasMore ? keys[keys.length - 1]! : null, counts: out };
  } catch (err) {
    if ((err as { code?: string })?.code === '2201B') {
      throw new RecordingsRegexError(`Invalid regular expression: ${(err as Error).message}`);
    }
    throw err;
  }
}

export class RecordingsRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingsRegexError';
  }
}

/**
 * CALLER-SCOPED — the legacy rows of a page, in the listing-v2 fields the
 * Recordings cards read. `user_id = caller` again: a key is never trusted to
 * be the caller's just because a page query produced it.
 */
export async function hydrateOwnMeetingRows(
  userId: string,
  assemblyaiIds: string[]
): Promise<TranscriptListRow[]> {
  if (assemblyaiIds.length === 0) return [];
  const rows = await sql<TranscriptListRow[]>`
    SELECT t.id, t.user_id, t.assemblyai_id, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.speaker_count,
           t.language_code, t.title, t.description, t.last_accessed,
           t.source, t.speech_model, t.recorded_at, t.auto_notes_status,
           t.upload_bytes_received::float8 AS upload_bytes_received,
           t.upload_bytes_total::float8 AS upload_bytes_total,
           t.gmeet_context->'recorder'->>'recordingId' AS recorder_recording_id,
           CASE
             WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
             WHEN t.assemblyai_id LIKE 'gmeet-%'
                  OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
           END AS provider,
           (t.gmeet_context->>'eventId') IS NOT NULL AS has_event,
           CASE
             WHEN jsonb_typeof(t.gmeet_context->'suggestedEvent') = 'object'
                  AND (t.gmeet_context->'suggestedEvent'->>'dismissedAt') IS NULL
                  AND (t.gmeet_context->>'eventId') IS NULL
             THEN t.gmeet_context->'suggestedEvent'
           END AS suggested_event,
           GREATEST(
             1 + COALESCE(jsonb_array_length(t.gmeet_context->'videoParts'), 0),
             COALESCE(jsonb_array_length(t.gmeet_context->'uploadedParts'), 0),
             COALESCE((t.gmeet_context->>'combinedParts')::int, 0)
           )::int AS recording_count,
           COALESCE(t.gmeet_context->'deferredImport'->>'error',
                    t.gmeet_context->'ingestFailure'->>'message') AS deferred_error,
           NULL::text AS deleted_at,
           t.scratch
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE t.user_id = ${userId} AND t.deleted_at IS NULL
      AND t.assemblyai_id = ANY(${assemblyaiIds}::text[])
  `;
  return rows.map((r) => ({ ...r, access: 'owner' as const, owner_email: null, owner_name: null }));
}

/** CALLER-SCOPED — registry rows by id (a page's 'registry' keys, and the
 * registry rows its legacy uploads came from). */
export async function ownRegistryRowsByIds(userId: string, ids: string[]): Promise<RecorderRecordingRow[]> {
  const uuids = ids.filter((id) => UUID_RE.test(id));
  if (uuids.length === 0) return [];
  return sql<RecorderRecordingRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recorder_recordings
    WHERE user_id = ${userId} AND id = ANY(${uuids}::uuid[])
  `;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
