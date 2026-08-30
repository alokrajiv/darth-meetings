import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

// Reminder rows produced by the background poller (lib/server/gmeet-poller).
// A reminder is "open" while resolved_at IS NULL; the poller resolves them
// when the meeting gets imported / muted / the config gets fixed, and users
// can dismiss from the UI.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export type ReminderKind = 'unimported' | 'autorec_off' | 'sync_requested';

/** Election input for the account auto-sync sweep (lib/server/account-
 * auto-sync): every OPEN 'unimported' reminder of the given users, with the
 * user's mutes already applied (gmeet_sync_skips + calendar_event_mutes by
 * occurrence or series) — a muted meeting must never be auto-imported. */
export interface UnimportedCandidateRow extends GmeetReminderRow {
  user_id: string;
  recurring_event_id: string | null;
  cal_event_key: string | null;
}

export async function listOpenUnimportedForUsers(
  userIds: string[]
): Promise<UnimportedCandidateRow[]> {
  if (userIds.length === 0) return [];
  return sql<UnimportedCandidateRow[]>`
    SELECT r.id, r.user_id, r.kind, r.event_key, r.meeting_code, r.title, r.event_start,
           r.organizer_self, r.has_recording, r.has_transcript,
           r.first_seen_at, r.last_seen_at,
           c.recurring_event_id, c.event_key AS cal_event_key
    FROM ${sql(SCHEMA)}.gmeet_reminders r
    LEFT JOIN LATERAL (
      SELECT c.recurring_event_id, c.event_key, c.event_id
      FROM ${sql(SCHEMA)}.calendar_event_cache c
      WHERE c.user_id = r.user_id
        AND c.meeting_code = r.meeting_code
        AND abs(extract(epoch FROM (c.event_start - r.event_start))) <= 60
      ORDER BY c.event_start
      LIMIT 1
    ) c ON true
    WHERE r.user_id = ANY(${userIds}::uuid[])
      AND r.kind = 'unimported'
      AND r.resolved_at IS NULL
      AND r.meeting_code IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.gmeet_sync_skips s
        WHERE s.user_id = r.user_id
          AND (s.event_key = r.meeting_code OR s.event_key = r.event_key)
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_mutes m
        WHERE m.user_id = r.user_id
          AND (
            (m.kind = 'occurrence' AND (m.value = r.event_key OR m.value = c.event_key))
            OR (m.kind = 'series' AND m.value = COALESCE(c.recurring_event_id, c.event_id))
          )
      )
    ORDER BY r.event_start ASC NULLS LAST
  `;
}

export interface GmeetReminderRow {
  id: number;
  kind: ReminderKind;
  event_key: string;
  meeting_code: string | null;
  title: string | null;
  event_start: string | null;
  organizer_self: boolean;
  has_recording: boolean;
  has_transcript: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export async function upsertReminder(input: {
  userId: string;
  kind: ReminderKind;
  eventKey: string;
  meetingCode: string | null;
  title: string | null;
  eventStart: string | null;
  organizerSelf: boolean;
  hasRecording: boolean;
  hasTranscript: boolean;
}): Promise<void> {
  // A resolved reminder stays resolved — a dismiss must survive later polls
  // that still see the meeting as unimported.
  await sql`
    INSERT INTO ${sql(SCHEMA)}.gmeet_reminders
      (user_id, kind, event_key, meeting_code, title, event_start,
       organizer_self, has_recording, has_transcript)
    VALUES
      (${input.userId}, ${input.kind}, ${input.eventKey}, ${input.meetingCode},
       ${input.title}, ${input.eventStart}, ${input.organizerSelf},
       ${input.hasRecording}, ${input.hasTranscript})
    ON CONFLICT (user_id, kind, event_key) DO UPDATE SET
      title          = EXCLUDED.title,
      has_recording  = EXCLUDED.has_recording,
      has_transcript = EXCLUDED.has_transcript,
      last_seen_at   = now()
  `;
}

export async function listOpenReminders(userId: string): Promise<GmeetReminderRow[]> {
  // Late mutes between polls are filtered here rather than waiting for the
  // next poller pass to resolve them.
  return sql<GmeetReminderRow[]>`
    SELECT r.id, r.kind, r.event_key, r.meeting_code, r.title, r.event_start,
           r.organizer_self, r.has_recording, r.has_transcript,
           r.first_seen_at, r.last_seen_at
    FROM ${sql(SCHEMA)}.gmeet_reminders r
    WHERE r.user_id = ${userId}
      AND r.resolved_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.gmeet_sync_skips s
        WHERE s.user_id = r.user_id
          AND (s.event_key = r.meeting_code OR s.event_key = r.event_key)
      )
    ORDER BY r.event_start DESC NULLS LAST
  `;
}

/** Open reminders regardless of mutes — the poller's reconciliation input. */
export async function listOpenRemindersRaw(userId: string): Promise<GmeetReminderRow[]> {
  return sql<GmeetReminderRow[]>`
    SELECT id, kind, event_key, meeting_code, title, event_start,
           organizer_self, has_recording, has_transcript, first_seen_at, last_seen_at
    FROM ${sql(SCHEMA)}.gmeet_reminders
    WHERE user_id = ${userId} AND resolved_at IS NULL
    ORDER BY event_start DESC NULLS LAST
    LIMIT 200
  `;
}

export async function resolveReminderById(
  userId: string,
  id: number,
  reason: string
): Promise<boolean> {
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.gmeet_reminders
    SET resolved_at = now(), resolved_reason = ${reason}
    WHERE user_id = ${userId} AND id = ${id} AND resolved_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

export async function resolveReminderByKey(
  userId: string,
  kind: ReminderKind | ReminderKind[],
  eventKey: string,
  reason: string
): Promise<void> {
  const kinds = Array.isArray(kind) ? kind : [kind];
  await sql`
    UPDATE ${sql(SCHEMA)}.gmeet_reminders
    SET resolved_at = now(), resolved_reason = ${reason}
    WHERE user_id = ${userId} AND kind = ANY(${kinds}) AND event_key = ${eventKey}
      AND resolved_at IS NULL
  `;
}
