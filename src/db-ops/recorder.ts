import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { RecorderMatch } from '@/lib/recorder';

/**
 * Darth Recorder registry (migration 041) — devices, telemetry events and
 * recordings. See docs/recorder-beta-plan.md (Stream S1).
 *
 * PRIVACY: every row is owned by one darth user. Writes are owner-only by
 * construction (`user_id = caller` in the WHERE clause, never a client-sent
 * owner). The only cross-user read is "is there a recording of this
 * occurrence?", and it is gated by the caller's involvement in the
 * occurrence (callerInvolvedCodes) and redacted to existence + owner email
 * + status — local paths, window titles and segment files never leave the
 * owner (feedback_privacy_caller_scoping_gate).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const RECORDING_STATUSES = [
  'recording',
  'local',
  'uploading',
  'uploaded',
  'upload_failed',
  'deleted',
] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export function isRecordingStatus(v: unknown): v is RecordingStatus {
  return typeof v === 'string' && (RECORDING_STATUSES as readonly string[]).includes(v);
}

export interface RecorderDeviceRow {
  device_id: string;
  user_id: string;
  email: string | null;
  hostname: string | null;
  os: string | null;
  app_version: string | null;
  first_seen: string;
  last_seen: string;
  last_ip: string | null;
  last_status: Record<string, unknown> | null;
}

export interface RecorderRecordingRow {
  id: string;
  device_id: string | null;
  user_id: string;
  email: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  bytes: number | null;
  segments: unknown;
  call: RecorderCall | null;
  shares: unknown;
  matched: RecorderMatch | null;
  transcript_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** What the tray knows about the call it recorded (companion-client's CompanionCall). */
export interface RecorderCall {
  id?: string;
  app?: string;
  bundle_id?: string;
  kind?: string;
  title?: string;
  started_at?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function upsertRecorderDevice(input: {
  deviceId: string;
  userId: string;
  email: string | null;
  hostname: string | null;
  os: string | null;
  appVersion: string | null;
  ip: string | null;
  status: unknown;
}): Promise<RecorderDeviceRow> {
  const rows = await sql<RecorderDeviceRow[]>`
    INSERT INTO ${sql(SCHEMA)}.recorder_devices
      (device_id, user_id, email, hostname, os, app_version, last_ip, last_status)
    VALUES (${input.deviceId}, ${input.userId}, ${input.email}, ${input.hostname},
            ${input.os}, ${input.appVersion}, ${input.ip},
            ${input.status === undefined || input.status === null ? null : sql.json(input.status as never)})
    ON CONFLICT (device_id) DO UPDATE SET
      user_id     = EXCLUDED.user_id,
      email       = COALESCE(EXCLUDED.email, recorder_devices.email),
      hostname    = COALESCE(EXCLUDED.hostname, recorder_devices.hostname),
      os          = COALESCE(EXCLUDED.os, recorder_devices.os),
      app_version = COALESCE(EXCLUDED.app_version, recorder_devices.app_version),
      last_ip     = COALESCE(EXCLUDED.last_ip, recorder_devices.last_ip),
      last_status = COALESCE(EXCLUDED.last_status, recorder_devices.last_status),
      last_seen   = now()
    RETURNING *
  `;
  return rows[0]!;
}

export async function listRecorderDevices(userId: string): Promise<RecorderDeviceRow[]> {
  return sql<RecorderDeviceRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recorder_devices
    WHERE user_id = ${userId}
    ORDER BY last_seen DESC
  `;
}

// ---------------------------------------------------------------------------
// Events (telemetry firehose)
// ---------------------------------------------------------------------------

export interface RecorderEventInput {
  ts: string;
  kind: string;
  payload: unknown;
}

/** Bulk insert. Returns the number of rows accepted. */
export async function insertRecorderEvents(
  userId: string,
  deviceId: string | null,
  events: RecorderEventInput[]
): Promise<number> {
  if (events.length === 0) return 0;
  const batch = events.map((e) => ({
    ts: e.ts,
    kind: e.kind,
    payload: e.payload === undefined ? null : e.payload,
  }));
  // Skip exact duplicates (same device, ts, kind, payload). A tray whose main queue died
  // (2026-09-17) re-sent the same batch every minute for 12 h — 21,095 rows for 34 events —
  // because its commit callback never ran. The tray now guards in-flight sends too; this is
  // the server-side belt. Uses recorder_events_device_ts_idx.
  const rows = await sql<Array<{ n: string }>>`
    WITH ins AS (
      INSERT INTO ${sql(SCHEMA)}.recorder_events (device_id, user_id, ts, kind, payload)
      SELECT ${deviceId}::uuid, ${userId}, e.ts, e.kind, e.payload
      FROM jsonb_to_recordset(${sql.json(batch as unknown as never)})
           AS e(ts timestamptz, kind text, payload jsonb)
      WHERE NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.recorder_events r
        WHERE r.device_id = ${deviceId}::uuid AND r.ts = e.ts AND r.kind = e.kind
          AND r.payload IS NOT DISTINCT FROM e.payload
      )
      RETURNING 1
    )
    SELECT count(*)::text AS n FROM ins
  `;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

export interface RecordingWrite {
  deviceId?: string | null;
  status?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationS?: number | null;
  bytes?: number | null;
  segments?: unknown;
  call?: unknown;
  shares?: unknown;
  error?: string | null;
  transcriptId?: string | null;
}

/** The owner's row, or null (never another user's — callers that need the
 * cross-user view go through `recordingsForOccurrence`). */
export async function getOwnRecording(
  userId: string,
  id: string
): Promise<RecorderRecordingRow | null> {
  const rows = await sql<RecorderRecordingRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recorder_recordings
    WHERE id = ${id}::uuid AND user_id = ${userId}
  `;
  return rows[0] ?? null;
}

/** Any owner's row — for the nudge route, which gates on occurrence
 * involvement instead of ownership. */
export async function getRecordingAnyOwner(id: string): Promise<RecorderRecordingRow | null> {
  const rows = await sql<RecorderRecordingRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recorder_recordings WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
}

/** Does the id exist under another user? (409 instead of a silent no-op.) */
export async function recordingOwnerOf(id: string): Promise<string | null> {
  const rows = await sql<Array<{ user_id: string }>>`
    SELECT user_id FROM ${sql(SCHEMA)}.recorder_recordings WHERE id = ${id}::uuid
  `;
  return rows[0]?.user_id ?? null;
}

/**
 * Insert-or-update by id, owner = caller. Only the keys present in `w` are
 * written (a PATCH that carries just `bytes` never clobbers `call`).
 * `matched` is always rewritten by the caller's matchRecording() result.
 */
export async function upsertRecording(
  user: { userId: string; email: string },
  id: string,
  w: RecordingWrite,
  matched: RecorderMatch | null
): Promise<RecorderRecordingRow | null> {
  const json = (v: unknown) => (v === undefined || v === null ? null : sql.json(v as never));
  const rows = await sql<RecorderRecordingRow[]>`
    INSERT INTO ${sql(SCHEMA)}.recorder_recordings
      (id, device_id, user_id, email, status, started_at, ended_at, duration_s,
       bytes, segments, call, shares, matched, transcript_id, error)
    VALUES (
      ${id}::uuid,
      ${w.deviceId ?? null}::uuid,
      ${user.userId},
      ${user.email},
      ${w.status ?? 'recording'},
      ${w.startedAt ?? null}::timestamptz,
      ${w.endedAt ?? null}::timestamptz,
      ${w.durationS ?? null},
      ${w.bytes ?? null},
      ${json(w.segments)},
      ${json(w.call)},
      ${json(w.shares)},
      ${json(matched)},
      ${w.transcriptId ?? null},
      ${w.error ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      device_id     = COALESCE(EXCLUDED.device_id, recorder_recordings.device_id),
      email         = COALESCE(EXCLUDED.email, recorder_recordings.email),
      status        = ${w.status === undefined || w.status === null ? sql`recorder_recordings.status` : sql`EXCLUDED.status`},
      started_at    = COALESCE(EXCLUDED.started_at, recorder_recordings.started_at),
      ended_at      = COALESCE(EXCLUDED.ended_at, recorder_recordings.ended_at),
      duration_s    = COALESCE(EXCLUDED.duration_s, recorder_recordings.duration_s),
      bytes         = COALESCE(EXCLUDED.bytes, recorder_recordings.bytes),
      segments      = COALESCE(EXCLUDED.segments, recorder_recordings.segments),
      call          = COALESCE(EXCLUDED.call, recorder_recordings.call),
      shares        = COALESCE(EXCLUDED.shares, recorder_recordings.shares),
      matched       = COALESCE(EXCLUDED.matched, recorder_recordings.matched),
      transcript_id = COALESCE(EXCLUDED.transcript_id, recorder_recordings.transcript_id),
      error         = ${w.error === undefined ? sql`recorder_recordings.error` : sql`EXCLUDED.error`},
      updated_at    = now()
    WHERE recorder_recordings.user_id = ${user.userId}
    RETURNING *
  `;
  // No row = the id exists under ANOTHER user (the ON CONFLICT WHERE clause
  // suppressed the update). The route turns that into a 409.
  return rows[0] ?? null;
}

export async function listOwnRecordings(
  userId: string,
  limit = 100
): Promise<RecorderRecordingRow[]> {
  return sql<RecorderRecordingRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recorder_recordings
    WHERE user_id = ${userId} AND status <> 'deleted'
    ORDER BY COALESCE(started_at, created_at) DESC
    LIMIT ${limit}
  `;
}

/**
 * Recordings matched to ONE occurrence, any owner. NOT caller-scoped — the
 * route gates with callerInvolvedInOccurrence first and redacts non-owned
 * rows.
 */
export async function recordingsForOccurrence(
  meetingCode: string,
  instant: string | null,
  limit = 20
): Promise<RecorderRecordingRow[]> {
  return sql<RecorderRecordingRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recorder_recordings
    WHERE status <> 'deleted'
      AND matched->>'meeting_code' = ${meetingCode}
      AND (
        ${instant}::timestamptz IS NULL
        OR abs(extract(epoch FROM ((matched->>'occ_start')::timestamptz - ${instant}::timestamptz))) <= 120
      )
    ORDER BY COALESCE(started_at, created_at) DESC
    LIMIT ${limit}
  `;
}

export interface OccurrenceRecordingHit {
  k: string;
  id: string;
  user_id: string;
  email: string | null;
  status: string;
  started_at: string | null;
  duration_s: number | null;
  transcript_id: string | null;
  hostname: string | null;
  nudged_at: string | null;
}

/**
 * Batch form for the calendar listing: best recording per occurrence key.
 * `occs` are keys the caller is ALREADY cleared to see (the calendar layers
 * only ever serve occurrences the caller is involved in — their own cache
 * rows on norec, unimportedVisibleTo on unimported), so this adds no new
 * exposure; the route still redacts to existence + owner + status.
 *
 * Preference order per occurrence: the caller's own recording, then an
 * uploaded one, then the longest.
 */
export async function recordingsForOccurrences(
  caller: { userId: string },
  occs: Array<{ k: string; code: string; instant: string }>
): Promise<Map<string, OccurrenceRecordingHit>> {
  const batch = occs.filter((o) => o.code && o.instant);
  if (batch.length === 0) return new Map();
  const rows = await sql<OccurrenceRecordingHit[]>`
    SELECT DISTINCT ON (o.k)
           o.k,
           r.id, r.user_id, r.email, r.status, r.started_at, r.duration_s,
           r.transcript_id, d.hostname,
           n.sent_at AS nudged_at
    FROM jsonb_to_recordset(${sql.json(batch as unknown as never)})
         AS o(k text, code text, instant timestamptz)
    JOIN ${sql(SCHEMA)}.recorder_recordings r
      ON r.matched->>'meeting_code' = o.code
     AND r.status <> 'deleted'
     AND abs(extract(epoch FROM ((r.matched->>'occ_start')::timestamptz - o.instant))) <= 120
    LEFT JOIN ${sql(SCHEMA)}.recorder_devices d ON d.device_id = r.device_id
    LEFT JOIN ${sql(SCHEMA)}.recorder_nudges n
      ON n.recording_id = r.id AND n.requester_user_id = ${caller.userId}
    ORDER BY o.k,
             (r.user_id = ${caller.userId}) DESC,
             (r.status = 'uploaded') DESC,
             COALESCE(r.duration_s, 0) DESC,
             COALESCE(r.started_at, r.created_at) DESC
  `;
  return new Map(rows.map((r) => [r.k, r]));
}

/**
 * The upload finalize tail's hook: the transcript that came out of this
 * recording. Owner-scoped; best-effort (never fails an upload).
 */
export async function linkRecordingTranscript(
  userId: string,
  recordingId: string,
  transcriptId: string
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recorder_recordings
    SET transcript_id = ${transcriptId}, status = 'uploaded', error = NULL, updated_at = now()
    WHERE id = ${recordingId}::uuid AND user_id = ${userId}
    RETURNING id
  `;
  return rows.length > 0;
}

/** A kept-failure placeholder was promoted to its real AAI id on retry: move
 * every registry row that pointed at the old id. */
export async function relinkRecordingTranscript(oldTranscriptId: string, newTranscriptId: string): Promise<number> {
  if (oldTranscriptId === newTranscriptId) return 0;
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recorder_recordings
    SET transcript_id = ${newTranscriptId}, updated_at = now()
    WHERE transcript_id = ${oldTranscriptId}
    RETURNING id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Nudges ("Ask to upload")
// ---------------------------------------------------------------------------

export const NUDGE_WINDOW_H = 6;

/** Claims the 6 h slot for (recording, requester). false = already nudged;
 * `sentAt` then says when. */
export async function claimNudge(
  recordingId: string,
  requester: { userId: string; email: string }
): Promise<{ claimed: boolean; sentAt: string }> {
  const rows = await sql<Array<{ sent_at: string; claimed: boolean }>>`
    INSERT INTO ${sql(SCHEMA)}.recorder_nudges (recording_id, requester_user_id, requester_email)
    VALUES (${recordingId}::uuid, ${requester.userId}, ${requester.email})
    ON CONFLICT (recording_id, requester_user_id) DO UPDATE
      SET sent_at = now(), requester_email = EXCLUDED.requester_email
      WHERE recorder_nudges.sent_at < now() - ${NUDGE_WINDOW_H} * interval '1 hour'
    RETURNING sent_at, true AS claimed
  `;
  if (rows[0]) return { claimed: true, sentAt: rows[0].sent_at };
  const prev = await sql<Array<{ sent_at: string }>>`
    SELECT sent_at FROM ${sql(SCHEMA)}.recorder_nudges
    WHERE recording_id = ${recordingId}::uuid AND requester_user_id = ${requester.userId}
  `;
  return { claimed: false, sentAt: prev[0]?.sent_at ?? new Date().toISOString() };
}

/** Undo a claim when the DM could not be built/sent. */
export async function releaseNudge(recordingId: string, requesterUserId: string): Promise<void> {
  await sql`
    DELETE FROM ${sql(SCHEMA)}.recorder_nudges
    WHERE recording_id = ${recordingId}::uuid AND requester_user_id = ${requesterUserId}
  `;
}

/** When the requester last nudged each of these recordings (6 h window UI). */
export async function lastNudgeAt(
  recordingIds: string[],
  requesterUserId: string
): Promise<Map<string, string>> {
  if (recordingIds.length === 0) return new Map();
  const rows = await sql<Array<{ recording_id: string; sent_at: string }>>`
    SELECT recording_id::text, sent_at
    FROM ${sql(SCHEMA)}.recorder_nudges
    WHERE requester_user_id = ${requesterUserId}
      AND recording_id = ANY(${recordingIds}::uuid[])
  `;
  return new Map(rows.map((r) => [r.recording_id, r.sent_at]));
}
