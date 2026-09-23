import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { DuplicateMatch } from '@/lib/same-file';

/**
 * The ONE lookup behind "you have already uploaded this file"
 * (docs/recordings-same-file-spec.md). Migration 044 tables.
 *
 * PRIVACY — read this before touching anything below.
 *
 * `recordings.sha256` is a fingerprint of a file's CONTENT. Telling a caller
 * that some hash exists is telling them what somebody else holds, so this
 * module has exactly one query, it takes the owner id as its first argument,
 * and `owner_user_id = $owner` is in its WHERE clause — not in a filter
 * applied afterwards, not in a "visible to me" join through shares. There is
 * no variant that searches across owners and there must never be one:
 *  - a SHARED meeting does not widen it (a share is on the meeting, the
 *    recording's owner is unchanged);
 *  - a match the caller does not own must be indistinguishable from no match,
 *    in the answer AND in the work done to produce it — hence one query with
 *    one index (`recordings (owner_user_id, sha256)`), same plan and same
 *    round trip whether the hash exists anywhere else or not.
 *
 * What counts as a match (the spec's rules, all in SQL so none of them can be
 * forgotten by a caller):
 *  - the recording is not soft-deleted, and
 *  - at least one meeting row still clips it — "live" means the document is
 *    still there, in the archive OR in the trash; a recording whose meetings
 *    were permanently deleted matches nothing, and
 *  - its ACTIVE transcription did not fail. Re-sending a failed one is the
 *    point, so a failure never blocks.
 * `trashed: true` = every such meeting is in the trash. Still reported:
 * restoring one is cheaper than re-transcribing.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

// globalThis, not module scope: Next bundles this module once per route graph
// and each copy would otherwise run its own probe.
const g = globalThis as unknown as { __mwRecordingTables?: Promise<boolean> };

/**
 * `true` when migration 044 has been applied to this schema. Probed once; a
 * FAILED probe is not cached (a DB hiccup must not disable the feature for the
 * life of the process). Same pattern as `db-ops/aai-job-id.ts` — a server
 * deployed before 044 would otherwise break every upload on the first
 * statement that names `recordings`.
 */
export function recordingTablesExist(): Promise<boolean> {
  return (g.__mwRecordingTables ??= (async () => {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${SCHEMA}
        AND table_name IN ('recordings', 'recording_media', 'recording_transcriptions',
                           'meeting_clips')
    `;
    const present = (rows[0]?.n ?? 0) === 4;
    if (!present) {
      console.warn(
        '[same-file] migrations/044_recordings.sql is not applied — MW_SAME_FILE_CHECK is ' +
          'forced off and the same file can still be transcribed twice'
      );
    }
    return present;
  })().catch((err) => {
    g.__mwRecordingTables = undefined;
    throw err;
  }));
}

interface MatchRow {
  meeting_id: string;
  title: string | null;
  /** `when` is a reserved word in SQL, so the column comes back under this. */
  happened_at: string | null;
  status: string;
  duration: number | null;
  trashed: boolean;
}

/**
 * CALLER-SCOPED BY CONSTRUCTION — the owner's own live recording with these
 * exact bytes, or null.
 *
 * `sha256` must already be normalized (64 lowercase hex — `normalizeSha256`);
 * a junk value simply matches nothing.
 *
 * Ordering picks the answer the user most wants to see: a live meeting before
 * a trashed one, then the oldest (the one that has been around long enough to
 * have notes on it).
 */
export async function findOwnRecordingBySha256(
  ownerUserId: string,
  sha256: string
): Promise<DuplicateMatch | null> {
  const rows = await sql<MatchRow[]>`
    SELECT t.assemblyai_id AS meeting_id,
           t.title,
           COALESCE(t.recorded_at, t.created_at) AS happened_at,
           t.status,
           t.duration,
           (t.deleted_at IS NOT NULL) AS trashed
    FROM ${sql(SCHEMA)}.recordings r
    JOIN ${sql(SCHEMA)}.meeting_clips c ON c.recording_id = r.id
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
    LEFT JOIN ${sql(SCHEMA)}.recording_transcriptions rt ON rt.id = r.active_transcription_id
    WHERE r.owner_user_id = ${ownerUserId}
      AND r.sha256 = ${sha256}
      AND r.deleted_at IS NULL
      -- A failed transcription never blocks: re-sending it is the point.
      AND t.status <> 'error'
      AND (rt.id IS NULL OR rt.status <> 'error')
    ORDER BY (t.deleted_at IS NULL) DESC, t.created_at, t.id
    LIMIT 1
  `;
  // Design P7: a STANDALONE recording (born by an unlinked upload) has no
  // meeting to answer with. Its pseudo id `rec-<id>` is what the upload
  // routes answered for it, so the tray marks it uploaded and "Open" lands on
  // the recording's page. Same owner predicate; asked only once 049 exists.
  const row = rows[0] ?? (await findOwnStandaloneBySha256(ownerUserId, sha256));
  if (!row) return null;
  return {
    meetingId: row.meeting_id,
    title: row.title,
    when: row.happened_at ? new Date(row.happened_at).toISOString() : null,
    status: row.status,
    durationSec: row.duration == null ? null : Number(row.duration),
    trashed: row.trashed,
  };
}

async function findOwnStandaloneBySha256(ownerUserId: string, sha256: string): Promise<MatchRow | null> {
  const { standaloneColumnsExist } = await import('@/db-ops/standalone-recordings');
  if (!(await standaloneColumnsExist().catch(() => false))) return null;
  const rows = await sql<MatchRow[]>`
    SELECT 'rec-' || r.id::text AS meeting_id,
           r.title,
           COALESCE(r.started_at, r.created_at) AS happened_at,
           CASE WHEN rt.status = 'completed' THEN 'completed' ELSE 'processing' END AS status,
           (r.duration_ms / 1000.0)::float8 AS duration,
           false AS trashed
    FROM ${sql(SCHEMA)}.recordings r
    LEFT JOIN ${sql(SCHEMA)}.recording_transcriptions rt ON rt.id = r.active_transcription_id
    WHERE r.owner_user_id = ${ownerUserId}
      AND r.sha256 = ${sha256}
      AND r.standalone
      AND r.deleted_at IS NULL
      AND r.active_transcription_id IS NOT NULL
      AND (rt.id IS NULL OR rt.status <> 'error')
    ORDER BY r.created_at
    LIMIT 1
  `;
  return rows[0] ?? null;
}
