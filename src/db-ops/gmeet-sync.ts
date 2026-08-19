import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

// Per-user Meet sync state: last full-sync timestamp + "never sync" mutes,
// plus the cross-user "who already imported this meeting?" lookup that the
// sync list uses for dedupe and colleague markers.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface GmeetSyncSkip {
  event_key: string;
  title: string | null;
  event_start: string | null;
  created_at: string;
}

export async function getSyncState(
  userId: string
): Promise<{ lastSyncedAt: string | null; skips: GmeetSyncSkip[] }> {
  const stateRows = await sql<Array<{ last_synced_at: string | null }>>`
    SELECT last_synced_at FROM ${sql(SCHEMA)}.gmeet_sync_state
    WHERE user_id = ${userId}
  `;
  const skips = await sql<GmeetSyncSkip[]>`
    SELECT event_key, title, event_start, created_at
    FROM ${sql(SCHEMA)}.gmeet_sync_skips
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  return { lastSyncedAt: stateRows[0]?.last_synced_at ?? null, skips };
}

export async function setLastSyncedAt(userId: string, atIso?: string): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.gmeet_sync_state (user_id, last_synced_at, updated_at)
    VALUES (${userId}, ${atIso ?? sql`now()`}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET last_synced_at = EXCLUDED.last_synced_at, updated_at = now()
  `;
}

export async function addSkip(
  userId: string,
  input: { eventKey: string; title?: string | null; eventStart?: string | null }
): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.gmeet_sync_skips (user_id, event_key, title, event_start)
    VALUES (${userId}, ${input.eventKey}, ${input.title ?? null}, ${input.eventStart ?? null})
    ON CONFLICT (user_id, event_key) DO NOTHING
  `;
}

export async function removeSkip(userId: string, eventKey: string): Promise<void> {
  await sql`
    DELETE FROM ${sql(SCHEMA)}.gmeet_sync_skips
    WHERE user_id = ${userId} AND event_key = ${eventKey}
  `;
}

export interface ImportedMeetingInfo {
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

export interface MeetingOccurrenceQuery {
  code: string;
  /** Event start of the SPECIFIC occurrence being asked about. Recurring
   * meetings reuse one meeting code forever, so without this a single
   * imported occurrence would claim every other date in the series. */
  startTime?: string | null;
}

/** A recurring Meet's occurrences are at least a day apart (weekly usually),
 * so a stored occurrence within ±12h of the asked-about event start is the
 * same call. Matches the conferenceRecord↔event window in gmeet/import. */
const OCCURRENCE_WINDOW_MS = 12 * 3600_000;

/**
 * Which of these meeting occurrences has ANYONE already imported? Unlike the
 * per-user 409 conflict check at import time, this looks across all users —
 * a teammate's un-shared import still shows up (as an inaccessible marker).
 *
 * Returns one entry per query, aligned by index (null = not imported).
 * Matching is meeting code + occurrence time: a stored row counts only when
 * its occurrence start (event start, else Meet's conference start, else
 * recorded_at) lands within ±12h of the query's startTime. Queries without a
 * startTime fall back to code-only matching (pasted links with no calendar
 * context). Earliest import wins for attribution.
 */
export async function findImportedByMeetingCodes(
  meetings: MeetingOccurrenceQuery[],
  caller: { userId: string; email: string },
  opts?: {
    /** Rows to ignore — the deferred-import poller passes its own `defer-…`
     * placeholder here so executing a queued import doesn't 409 against
     * itself (the placeholder carries the same meetingCode). */
    excludeAssemblyaiIds?: string[];
  }
): Promise<(ImportedMeetingInfo | null)[]> {
  const cleaned = meetings.map((m) => ({
    code: m.code.trim(),
    startTime: m.startTime ?? null,
  }));
  const codes = [...new Set(cleaned.map((m) => m.code).filter(Boolean))];
  if (codes.length === 0) return meetings.map(() => null);

  const rows = await sql<
    Array<ImportedMeetingInfo & { occurrence_start: string | null }>
  >`
    SELECT
      t.gmeet_context->>'meetingCode' AS meeting_code,
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
        t.gmeet_context->'actuals'->>'conferenceStart',
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
    WHERE t.gmeet_context->>'meetingCode' = ANY(${codes})
      AND t.deleted_at IS NULL
    ORDER BY t.created_at ASC
  `;

  const excluded = new Set(opts?.excludeAssemblyaiIds ?? []);
  return cleaned.map(({ code, startTime }) => {
    if (!code) return null;
    const candidates = rows.filter(
      (r) => r.meeting_code === code && !excluded.has(r.assemblyai_id)
    );
    const wanted = startTime ? Date.parse(startTime) : NaN;
    const match = Number.isNaN(wanted)
      ? candidates[0]
      : candidates.find((r) => {
          const at = r.occurrence_start ? Date.parse(r.occurrence_start) : NaN;
          return !Number.isNaN(at) && Math.abs(at - wanted) <= OCCURRENCE_WINDOW_MS;
        });
    if (!match) return null;
    const { occurrence_start, ...info } = match;
    void occurrence_start;
    return info;
  });
}
