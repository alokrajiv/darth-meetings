import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { ImportedMeetingInfo } from '@/db-ops/gmeet-sync';

// Cross-user "did anyone already import this Teams meeting?" lookups —
// Teams twin of gmeet-sync's findImportedByMeetingCodes. Identity facts
// live in gmeet_context->'teams' (indexed by migration 019).

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

/** Same ±12h occurrence window as the Meet lookups, same reason: one join
 * URL covers a whole recurring series. */
const OCCURRENCE_WINDOW_MS = 12 * 3600_000;

interface TeamsImportedRow extends ImportedMeetingInfo {
  join_web_url: string;
  occurrence_start: string | null;
}

const LOOKUP_SELECT = (caller: { userId: string; email: string }) => sql`
  SELECT
    t.gmeet_context->'teams'->>'joinWebUrl' AS join_web_url,
    t.gmeet_context->'teams'->>'joinWebUrl' AS meeting_code,
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
    COALESCE(
      t.gmeet_context->>'startTime',
      t.recorded_at::text
    ) AS occurrence_start
  FROM ${sql(SCHEMA)}.transcripts t
  LEFT JOIN LATERAL (
    SELECT a.user_email
    FROM ${sql(SCHEMA)}.transcript_activity a
    WHERE a.user_id = t.user_id
    ORDER BY a.at DESC
    LIMIT 1
  ) AS owner_act ON true
`;

/**
 * Which of these Teams meeting occurrences has ANYONE already imported?
 * Matched by canonical join URL + occurrence time window — the identity
 * available straight from the calendar event, before any Graph call.
 * Returns one entry per query, aligned by index (null = not imported).
 */
export async function findImportedByTeamsMeetings(
  queries: Array<{ joinWebUrl: string; startTime?: string | null }>,
  caller: { userId: string; email: string }
): Promise<(ImportedMeetingInfo | null)[]> {
  const urls = [...new Set(queries.map((q) => q.joinWebUrl).filter(Boolean))];
  if (urls.length === 0) return queries.map(() => null);

  const rows = await sql<TeamsImportedRow[]>`
    ${LOOKUP_SELECT(caller)}
    WHERE t.gmeet_context->'teams'->>'joinWebUrl' = ANY(${urls})
    ORDER BY t.created_at ASC
  `;

  return queries.map(({ joinWebUrl, startTime }) => {
    const candidates = rows.filter((r) => r.join_web_url === joinWebUrl);
    const wanted = startTime ? Date.parse(startTime) : NaN;
    const match = Number.isNaN(wanted)
      ? candidates[0]
      : candidates.find((r) => {
          const at = r.occurrence_start ? Date.parse(r.occurrence_start) : NaN;
          return !Number.isNaN(at) && Math.abs(at - wanted) <= OCCURRENCE_WINDOW_MS;
        });
    if (!match) return null;
    const { join_web_url, occurrence_start, ...info } = match;
    void join_web_url;
    void occurrence_start;
    return info;
  });
}

/**
 * Exact-occurrence dedupe by Graph callId — used at import time, after
 * artifact resolution pinned the occurrence. Strongest identity there is:
 * transcript + recording of one occurrence share it, and it never repeats
 * across occurrences.
 */
export async function findImportedByTeamsCallId(
  callId: string,
  caller: { userId: string; email: string }
): Promise<ImportedMeetingInfo | null> {
  const rows = await sql<TeamsImportedRow[]>`
    ${LOOKUP_SELECT(caller)}
    WHERE t.gmeet_context->'teams'->>'callId' = ${callId}
    ORDER BY t.created_at ASC
    LIMIT 1
  `;
  if (!rows[0]) return null;
  const { join_web_url, occurrence_start, ...info } = rows[0];
  void join_web_url;
  void occurrence_start;
  return info;
}
