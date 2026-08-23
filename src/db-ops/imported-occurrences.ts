import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { OCCURRENCE_WINDOW_S } from '@/lib/meeting-evidence';
import {
  importedOccurrenceMatches,
  type ImportedCandidate,
  type OccurrenceQuery,
} from '@/lib/imported-occurrence';

// THE single "already imported?" lookup (Phase 3). gmeet-sync's
// findImportedByMeetingCodes, teams-import's findImportedByTeamsMeetings /
// findImportedByTeamsCallId, /api/gmeet/check, the poller's reminder
// reconciliation and the series sweep all resolve through here; the calendar
// SQL views use importedOccurrenceAntiJoin for the same rule in SQL.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface ImportedMeetingInfo {
  /** Meet meeting code, or the Teams join URL for Teams imports. */
  meeting_code: string;
  assemblyai_id: string;
  title: string | null;
  owner_user_id: string;
  /** Best-effort — resolved via the owner's activity rows; null if unknown. */
  owner_email: string | null;
  /** Whether the CALLER can open it (their own, or shared with them). */
  accessible: boolean;
  mine: boolean;
}

/** Occurrence timestamp of a stored import — the ONE COALESCE chain. */
export const IMPORTED_OCCURRENCE_START = sql`
  COALESCE(
    t.gmeet_context->>'startTime',
    t.gmeet_context->'actuals'->>'conferenceStart',
    t.recorded_at::text
  )
`;

type Fragment = ReturnType<typeof sql>;

/**
 * SQL twin of importedOccurrenceMatches for the listing views: `NOT EXISTS`
 * over live transcripts (deferred `defer-*` placeholders count — they carry
 * the same keys). `meetingCode` / `joinWebUrl` are provider keys pinned to
 * `instant` by the ±12h window; `eventIdIn` is a parenthesized subquery
 * yielding one text column of calendar event ids that identify the
 * occurrence exactly (uploads / pasted transcripts link by eventId, not
 * meeting code — D9). It is planted as a FROM item joined to the transcripts
 * eventId expression index (a correlated `IN (subquery)` can't become a
 * semi-join and degrades to a per-pair filter).
 */
export function importedOccurrenceAntiJoin(input: {
  meetingCode: Fragment;
  joinWebUrl?: Fragment | null;
  eventIdIn?: Fragment | null;
  instant: Fragment;
}): Fragment {
  const occ = sql`${IMPORTED_OCCURRENCE_START}::timestamptz`;
  // One NOT EXISTS per arm (De Morgan of the old single OR chain — same
  // semantics) so each probes its expression index: a combined OR forces a
  // per-(candidate x transcript) join filter that re-extracts (= detoasts)
  // the ~16KB gmeet_context jsonb tens of thousands of times per listing
  // query. The explicit `gmeet_context IS NOT NULL` is implied by the `->>`
  // match but stated so the planner can use the partial indexes.
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.transcripts t
      WHERE t.deleted_at IS NULL
        AND t.gmeet_context IS NOT NULL
        AND t.gmeet_context->>'meetingCode' = ${input.meetingCode}
        AND abs(extract(epoch FROM (${occ} - ${input.instant}))) <= ${OCCURRENCE_WINDOW_S}
    )
    ${
      input.joinWebUrl
        ? sql`AND NOT EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.transcripts t
      WHERE t.deleted_at IS NULL
        AND ${input.joinWebUrl} IS NOT NULL
        AND t.gmeet_context IS NOT NULL
        AND t.gmeet_context->'teams'->>'joinWebUrl' = ${input.joinWebUrl}
        AND abs(extract(epoch FROM (${occ} - ${input.instant}))) <= ${OCCURRENCE_WINDOW_S}
    )`
        : sql``
    }
    ${
      input.eventIdIn
        ? sql`AND NOT EXISTS (
      SELECT 1
      FROM ${input.eventIdIn} AS _ids(event_id)
      JOIN ${sql(SCHEMA)}.transcripts t
        ON t.gmeet_context->>'eventId' = _ids.event_id
      WHERE t.deleted_at IS NULL
        AND t.gmeet_context IS NOT NULL
    )`
        : sql``
    }
  )`;
}

type Row = ImportedMeetingInfo & ImportedCandidate;

/**
 * Which of these occurrences has ANYONE already imported? Cross-user: a
 * teammate's un-shared import still shows up (as an inaccessible marker).
 * Returns one entry per query, aligned by index (null = not imported).
 * Earliest import wins for attribution.
 */
export async function findImportedOccurrences(
  queries: OccurrenceQuery[],
  caller: { userId: string; email: string },
  opts?: {
    /** Rows to ignore — the deferred-import poller passes its own `defer-…`
     * placeholder here so executing a queued import doesn't 409 against
     * itself (the placeholder carries the same meetingCode). */
    excludeAssemblyaiIds?: string[];
  }
): Promise<(ImportedMeetingInfo | null)[]> {
  const cleaned: OccurrenceQuery[] = queries.map((q) => ({
    meetingCode: q.meetingCode?.trim() || null,
    joinWebUrl: q.joinWebUrl?.trim() || null,
    eventId: q.eventId?.trim() || null,
    videoFileId: q.videoFileId?.trim() || null,
    transcriptDocId: q.transcriptDocId?.trim() || null,
    teamsCallId: q.teamsCallId?.trim() || null,
    startTime: q.startTime ?? null,
  }));
  const uniq = (pick: (q: OccurrenceQuery) => string | null | undefined): string[] => [
    ...new Set(cleaned.map(pick).filter((v): v is string => !!v)),
  ];
  const codes = uniq((q) => q.meetingCode);
  const urls = uniq((q) => q.joinWebUrl);
  const eventIds = uniq((q) => q.eventId);
  const videoIds = uniq((q) => q.videoFileId);
  const docIds = uniq((q) => q.transcriptDocId);
  const callIds = uniq((q) => q.teamsCallId);
  if (
    codes.length + urls.length + eventIds.length + videoIds.length + docIds.length + callIds.length ===
    0
  ) {
    return queries.map(() => null);
  }

  // Only the arms with values — an always-present 7-way OR defeats the
  // per-key expression indexes (meetingCode / joinWebUrl / callId) and turns
  // the hot-path dedupe check into a seq scan.
  const arms: Fragment[] = [];
  if (codes.length) arms.push(sql`t.gmeet_context->>'meetingCode' = ANY(${codes})`);
  if (urls.length) arms.push(sql`t.gmeet_context->'teams'->>'joinWebUrl' = ANY(${urls})`);
  if (eventIds.length) arms.push(sql`t.gmeet_context->>'eventId' = ANY(${eventIds})`);
  if (videoIds.length) {
    arms.push(sql`t.gmeet_context->>'videoFileId' = ANY(${videoIds})`);
    arms.push(sql`t.drive_file_id = ANY(${videoIds})`);
  }
  if (docIds.length) arms.push(sql`t.gmeet_context->>'transcriptDocId' = ANY(${docIds})`);
  if (callIds.length) arms.push(sql`t.gmeet_context->'teams'->>'callId' = ANY(${callIds})`);
  const where = arms.reduce((acc, a) => sql`${acc} OR ${a}`);

  const rows = await sql<Row[]>`
    SELECT
      t.gmeet_context->>'meetingCode' AS meeting_code,
      t.gmeet_context->'teams'->>'joinWebUrl' AS join_web_url,
      t.gmeet_context->>'eventId' AS event_id,
      t.gmeet_context->>'videoFileId' AS video_file_id,
      t.drive_file_id,
      t.gmeet_context->>'transcriptDocId' AS transcript_doc_id,
      t.gmeet_context->'teams'->>'callId' AS teams_call_id,
      t.assemblyai_id,
      t.title,
      t.user_id AS owner_user_id,
      owner_act.user_email AS owner_email,
      (t.user_id = ${caller.userId} OR EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares s
        WHERE s.transcript_id = t.id
          AND LOWER(s.shared_with_email) = ${caller.email.toLowerCase()}
      )) AS accessible,
      (t.user_id = ${caller.userId}) AS mine,
      ${IMPORTED_OCCURRENCE_START} AS occurrence_start
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN LATERAL (
      SELECT a.user_email
      FROM ${sql(SCHEMA)}.transcript_activity a
      WHERE a.user_id = t.user_id
      ORDER BY a.at DESC
      LIMIT 1
    ) AS owner_act ON true
    WHERE t.deleted_at IS NULL
      AND (${where})
    ORDER BY t.created_at ASC
  `;

  const excluded = new Set(opts?.excludeAssemblyaiIds ?? []);
  return cleaned.map((q) => {
    const match = rows.find(
      (r) => !excluded.has(r.assemblyai_id) && importedOccurrenceMatches(r, q)
    );
    if (!match) return null;
    return {
      // Meet code, else the Teams join URL (legacy ImportedMeetingInfo
      // contract), else '' for rows matched by a strong id only.
      meeting_code: match.meeting_code ?? match.join_web_url ?? '',
      assemblyai_id: match.assemblyai_id,
      title: match.title,
      owner_user_id: match.owner_user_id,
      owner_email: match.owner_email,
      accessible: match.accessible,
      mine: match.mine,
    };
  });
}
