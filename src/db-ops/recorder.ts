import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { OCCURRENCE_WINDOW_S } from '@/lib/meeting-evidence';
import { IMPORTED_OCCURRENCE_START } from '@/db-ops/imported-occurrences';
import type { RecorderMatch } from '@/lib/recorder';
import type { SuggestedEvent } from '@/lib/format';

/**
 * Darth Recorder registry (migration 041) — devices, telemetry events and
 * recordings. See docs/recorder-beta-plan.md (Stream S1).
 *
 * PRIVACY (docs/recordings-meetings-series-design.md §1, rules 1 and 3):
 * every row is owned by one darth user and is NEVER shared. Writes are
 * owner-only by construction (`user_id = caller` in the WHERE clause, never
 * a client-sent owner). A recording is reachable by exactly two arms:
 *
 *   (a) the caller OWNS it, or
 *   (b) it is LINKED to a meeting the caller can already open (owner or
 *       `transcript_shares`) and that meeting is this occurrence.
 *
 * A machine match (`matched`) is not an arm. Until 2026-09-22 the calendar
 * folds below joined recordings of ANY owner onto the caller's occurrences
 * on the strength of `matched` alone (F1) — that is what put a private Slack
 * huddle on eight invitees' rows twice in one afternoon. Involvement in an
 * occurrence is a gate on the OCCURRENCE, not on the recording; the only
 * gate on a recording is a meeting (feedback_privacy_caller_scoping_gate).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

type Fragment = ReturnType<typeof sql>;

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

/** The owner's row, or null. There is no cross-user form of this: a
 * recording is reachable by its owner, or through a meeting. */
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
 * "This recording IS that occurrence" — the SQL twin of
 * `recorderMatchIsConfident` (lib/recorder.ts), for the calendar folds
 * below. Since 2026-09-22 17:00 SGT `matchRecording` stamps `confident` on
 * the stored match; a row matched before that is judged on the numbers it
 * has, with time overlap alone never enough (the 15:56 incident) — and a
 * product mismatch never (the 17:03 one: a Slack DM call folded onto a
 * Teams invite at score 0.3 read as "my Slack call was uploaded against
 * the wrong meeting"). A weak match stays on the row for the record; the
 * calendar simply does not show it.
 */
function matchedConfidentSql(alias: string) {
  const m = sql.unsafe(`${alias}.matched`);
  return sql`(
    ${m} IS NOT NULL AND (
      CASE WHEN ${m} ? 'confident' THEN (${m}->>'confident')::boolean
           ELSE COALESCE((${m}->>'score')::numeric, 0) >= 0.6
            AND COALESCE((${m}->>'overlap')::numeric, 0) >= 0.5
            AND NOT COALESCE((${m}->>'provider_mismatch')::boolean, false)
            AND COALESCE((${m}->>'title_score')::numeric, 0) > 0
      END
    )
  )`;
}

/** Who is asking. Both arms of the reachability rule need the email: a
 * share is keyed on it, not on the user id. */
export interface RecorderCaller {
  userId: string;
  email: string;
}

/**
 * Arm (b) as a LATERAL: the meeting this recording is LINKED to, when the
 * caller can open it AND that meeting is this occurrence. Yields the
 * meeting's public id or no row.
 *
 * `recorder_recordings.transcript_id` holds `transcripts.assemblyai_id`.
 * "Is this occurrence" is asked of the MEETING's own calendar keys — the
 * link a human made — never of the recorder's `matched`, which is a guess.
 * Visibility is the meetings predicate every other layer uses: owner, or a
 * `transcript_shares` row on the caller's lower-cased email.
 */
function linkedMeetingLateral(
  caller: RecorderCaller,
  recAlias: string,
  codeExpr: Fragment,
  instantExpr: Fragment
): Fragment {
  const transcriptId = sql.unsafe(`${recAlias}.transcript_id`);
  return sql`
    SELECT t.assemblyai_id
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE ${transcriptId} IS NOT NULL
      AND t.assemblyai_id = ${transcriptId}
      AND t.deleted_at IS NULL
      AND (
        t.user_id = ${caller.userId}
        OR EXISTS (
          SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares s
          WHERE s.transcript_id = t.id
            AND LOWER(s.shared_with_email) = ${caller.email.toLowerCase()}
        )
      )
      AND t.gmeet_context->>'meetingCode' = ${codeExpr}
      AND (
        ${instantExpr} IS NULL
        OR abs(extract(epoch FROM (
             ${IMPORTED_OCCURRENCE_START}::timestamptz - ${instantExpr}
           ))) <= ${OCCURRENCE_WINDOW_S}
      )
    LIMIT 1
  `;
}

/**
 * Arm (a)'s payload: the caller's OWN recording, resolved to the meeting its
 * upload produced and to the live suggestion sitting on that meeting.
 *
 * The owner may always reach their own recording — rule 1's other half — so
 * `assemblyai_id` is served here whether or not the recording is linked to
 * this occurrence; the fold's OTHER lateral is the one that decides what a
 * non-owner may see. Without this the owner's own calendar row was a dead
 * end after P1: "uploaded to your Recordings", and no way in.
 *
 * `suggested_event` is the meeting's own `gmeet_context.suggestedEvent` —
 * the canonical object the Link and "Not this" paths already act on
 * (`POST :id/link-event`, `PATCH :id {dismissSuggestedEvent}`), so the
 * calendar row can mount the SAME SuggestedEventStrip the transcript page
 * and the listing use. It is served only while it is live (not dismissed,
 * the meeting not already linked) and only when it names THIS occurrence.
 * It needs no confidence test of its own twice over: `suggestedEventFromMatch`
 * writes one only for a confident match, and the fold's driving join already
 * requires `matchedConfidentSql` — the SQL twin of the one definition.
 */
function ownMeetingLateral(
  caller: RecorderCaller,
  recAlias: string,
  codeExpr: Fragment
): Fragment {
  const userId = sql.unsafe(`${recAlias}.user_id`);
  const transcriptId = sql.unsafe(`${recAlias}.transcript_id`);
  const sug = sql.unsafe(`t.gmeet_context->'suggestedEvent'`);
  return sql`
    SELECT t.assemblyai_id,
           CASE
             WHEN jsonb_typeof(${sug}) = 'object'
              AND (${sug}->>'dismissedAt') IS NULL
              AND (t.gmeet_context->>'eventId') IS NULL
              AND (${sug}->>'meetingCode') = ${codeExpr}
             THEN ${sug}
           END AS suggested_event
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE ${userId} = ${caller.userId}
      AND ${transcriptId} IS NOT NULL
      AND t.assemblyai_id = ${transcriptId}
      AND t.user_id = ${caller.userId}
      AND t.deleted_at IS NULL
    LIMIT 1
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
  /** Arm (b)'s answer: the meeting this recording is linked to AND that the
   * caller can open. The only meeting id a NON-OWNER may ever be handed. */
  linked_transcript_id: string | null;
  /** Arm (a)'s: the meeting the caller's OWN upload produced, linked here or
   * not. Null for everybody else's recordings. */
  own_transcript_id: string | null;
  /** The live suggestion on that own meeting, when it names this occurrence
   * — what the Link / "Not this" buttons act on. Null for everybody else. */
  suggested_event: SuggestedEvent | null;
  hostname: string | null;
}

/**
 * Batch form for the calendar listing: best recording per occurrence key,
 * under the SAME two arms.
 *
 * Until 2026-09-22 this joined recordings of ANY owner onto the caller's
 * occurrences on `matched` alone and the route handed back the owner's
 * email, the state, the duration and the meeting id of a recording the
 * caller had no right to know existed (F1). The occurrence keys being ones
 * the caller is cleared to SEE was never an argument about the RECORDING:
 * the only gate on a recording is a meeting.
 *
 * Note on the driving join: candidates are still narrowed by the stored
 * match, so arm (b) is evaluated over confidently-matched rows only. That
 * costs nothing in practice — the calendar layers anti-join every occurrence
 * ANYONE has imported (db-ops/imported-occurrences importedOccurrenceAntiJoin),
 * so an occurrence whose linked meeting the caller can open is not served by
 * these layers at all; arm (b) is the belt on the braces.
 *
 * Preference order per occurrence: the caller's own recording, then an
 * uploaded one, then the longest.
 */
export async function recordingsForOccurrences(
  caller: RecorderCaller,
  occs: Array<{ k: string; code: string; instant: string }>
): Promise<Map<string, OccurrenceRecordingHit>> {
  const batch = occs.filter((o) => o.code && o.instant);
  if (batch.length === 0) return new Map();
  const rows = await sql<OccurrenceRecordingHit[]>`
    SELECT DISTINCT ON (o.k)
           o.k,
           r.id, r.user_id, r.email, r.status, r.started_at, r.duration_s,
           linked.assemblyai_id AS linked_transcript_id,
           own.assemblyai_id AS own_transcript_id,
           own.suggested_event,
           d.hostname
    FROM jsonb_to_recordset(${sql.json(batch as unknown as never)})
         AS o(k text, code text, instant timestamptz)
    JOIN ${sql(SCHEMA)}.recorder_recordings r
      ON r.matched->>'meeting_code' = o.code
     AND r.status <> 'deleted'
     AND ${matchedConfidentSql('r')}
     AND abs(extract(epoch FROM ((r.matched->>'occ_start')::timestamptz - o.instant))) <= 120
    LEFT JOIN ${sql(SCHEMA)}.recorder_devices d ON d.device_id = r.device_id
    LEFT JOIN LATERAL (
      ${linkedMeetingLateral(caller, 'r', sql`o.code`, sql`o.instant`)}
    ) linked ON true
    LEFT JOIN LATERAL (
      ${ownMeetingLateral(caller, 'r', sql`o.code`)}
    ) own ON true
    WHERE r.user_id = ${caller.userId} OR linked.assemblyai_id IS NOT NULL
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
