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

/**
 * Which of these meeting codes has ANYONE already imported? Unlike the
 * per-user 409 conflict check at import time, this looks across all users —
 * a teammate's un-shared import still shows up (as an inaccessible marker).
 * One row per code (the earliest import wins for attribution).
 */
export async function findImportedByMeetingCodes(
  codes: string[],
  caller: { userId: string; email: string }
): Promise<ImportedMeetingInfo[]> {
  const cleaned = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (cleaned.length === 0) return [];

  return sql<ImportedMeetingInfo[]>`
    SELECT DISTINCT ON (t.gmeet_context->>'meetingCode')
      t.gmeet_context->>'meetingCode' AS meeting_code,
      t.assemblyai_id,
      t.title,
      t.user_id AS owner_user_id,
      owner_act.user_email AS owner_email,
      (t.user_id = ${caller.userId} OR s.id IS NOT NULL) AS accessible,
      (t.user_id = ${caller.userId}) AS mine
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
     AND LOWER(s.shared_with_email) = ${caller.email.toLowerCase()}
    LEFT JOIN LATERAL (
      SELECT a.user_email
      FROM ${sql(SCHEMA)}.transcript_activity a
      WHERE a.user_id = t.user_id
      ORDER BY a.at DESC
      LIMIT 1
    ) AS owner_act ON true
    WHERE t.gmeet_context->>'meetingCode' = ANY(${cleaned})
    ORDER BY t.gmeet_context->>'meetingCode', t.created_at ASC
  `;
}
