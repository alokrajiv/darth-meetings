import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import {
  findImportedOccurrences,
  type ImportedMeetingInfo,
} from '@/db-ops/imported-occurrences';

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

export type { ImportedMeetingInfo } from '@/db-ops/imported-occurrences';

export interface MeetingOccurrenceQuery {
  code: string;
  /** Event start of the SPECIFIC occurrence being asked about. Recurring
   * meetings reuse one meeting code forever, so without this a single
   * imported occurrence would claim every other date in the series. */
  startTime?: string | null;
}

/**
 * Which of these meeting occurrences has ANYONE already imported? Thin
 * adapter over THE single lookup (db-ops/imported-occurrences, Phase 3):
 * meeting code + the shared ±12h occurrence window, code-only when no
 * startTime (pasted links with no calendar context). One entry per query,
 * aligned by index (null = not imported).
 */
export async function findImportedByMeetingCodes(
  meetings: MeetingOccurrenceQuery[],
  caller: { userId: string; email: string },
  opts?: { excludeAssemblyaiIds?: string[] }
): Promise<(ImportedMeetingInfo | null)[]> {
  return findImportedOccurrences(
    meetings.map((m) => ({ meetingCode: m.code, startTime: m.startTime ?? null })),
    caller,
    opts
  );
}
