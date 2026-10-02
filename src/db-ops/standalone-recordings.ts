import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { aaiJobIdColumnExists } from '@/db-ops/aai-job-id';
import type { GmeetContext, TranscriptResponse } from '@/lib/format';
import type { RecorderCall } from '@/db-ops/recorder';
import type { RecorderMatch } from '@/lib/recorder';

/**
 * STANDALONE recordings — the ones an upload is born as when it names no
 * meeting (design P7, migration 049; docs/recordings-meetings-series-design.md
 * §1.2 and "As built — P7/P8").
 *
 * A standalone recording is NOT derived from a `transcripts` row (every
 * recording before P7 was — `lib/recording-graph.ts`). It is written here,
 * directly: the `recordings` row at upload open, its canonical
 * `recording_media` row and its `recording_transcriptions` row at the
 * AssemblyAI hand-off, the payload when the job completes. It becomes part of
 * a meeting only when its OWNER links it (`createMeetingFromRecording` below).
 *
 * PRIVACY — the same two arms as migration 044, and nothing else:
 *   (a) its OWNER (`recordings.owner_user_id`), for every function marked
 *       CALLER-SCOPED below — the owner predicate is in the SQL;
 *   (b) a caller who can open a MEETING holding a clip on it
 *       (`reachableThroughMeeting`) — the media route's second arm, and only
 *       that route's.
 * INTERNAL-ONLY functions take ids with no owner constraint; only the upload
 * pipeline, the pollers and the sweeper call them, with ids they minted or
 * read from these tables themselves — never an id from a request.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

// ---------------------------------------------------------------------------
// Column probe (migration 049)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __mwStandaloneColumns?: Promise<boolean> };

/**
 * `true` when migration 049 has been applied (and 045, whose `aai_job_id` a
 * meeting made from a recording records its job in). Probed once per
 * process; a FAILED probe is not cached. Same shape as db-ops/aai-job-id.ts.
 */
export function standaloneColumnsExist(): Promise<boolean> {
  return (g.__mwStandaloneColumns ??= (async () => {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM information_schema.columns
      WHERE table_schema = ${SCHEMA}
        AND ((table_name = 'recordings'
              AND column_name IN ('standalone', 'title', 'expires_at', 'upload_state', 'ready_notified_at'))
          OR (table_name = 'recorder_recordings' AND column_name = 'recording_id'))
    `;
    const present = (rows[0]?.n ?? 0) === 6 && (await aaiJobIdColumnExists());
    if (!present) {
      console.warn(
        '[standalone-recordings] columns missing — apply migrations/045 and 049; ' +
          'MW_RECORDINGS_BORN_BARE is forced off (uploads keep being born as meetings)'
      );
    }
    return present;
  })().catch((err) => {
    g.__mwStandaloneColumns = undefined;
    throw err;
  }));
}

/** Test hook: forget the cached probe. */
export function resetStandaloneColumnsProbe(): void {
  g.__mwStandaloneColumns = undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One part of a multi-file upload while the group assembles. */
export interface StandaloneGroupPart {
  index: number;
  tempFilename: string;
  originalFilename?: string;
  comment?: string;
  bytes?: number;
  sha256?: string;
}

/**
 * `recordings.upload_state` — the in-flight bookkeeping a meeting-born upload
 * keeps on its placeholder's `gmeet_context`. Owner-only.
 */
export interface StandaloneUploadState {
  originalFilename?: string | null;
  languageCode?: string | null;
  speechModel?: string | null;
  bytesTotal?: number | null;
  bytesReceived?: number | null;
  /** The uploader's email at upload time — where the one "transcribed" DM goes
   * (there is no users table; this is the owner's own address, never served
   * to anyone else). */
  ownerEmail?: string | null;
  /** Last sign of life of the byte delivery — the stale-upload reaper keys on it. */
  heartbeatAt?: string | null;
  /** Multi-file upload in progress (parts land one by one). Null once stitched. */
  group?: {
    id: string;
    total: number;
    bytesTotal?: number;
    partSha256?: string[];
    parts: StandaloneGroupPart[];
  } | null;
  /** The stitch map, once the group became one file (offsets on the concat). */
  uploadedParts?: Array<{
    index: number;
    originalFilename?: string;
    comment?: string;
    durationSec?: number;
    offsetSec: number;
    sha256?: string;
    /** The stitch could not read this part and left it out (see format.ts). */
    skipped?: string;
  }> | null;
  /** The upload's identity for the same-file check (a file's or a group's hash). */
  sha256?: string | null;
  /** A kept hand-off failure (AssemblyAI upload/submit) and its retry schedule. */
  ingestFailure?: {
    stage: 'aai-upload' | 'aai-submit';
    message: string;
    firstAt: string;
    at: string;
    attempts: number;
    nextAt: string | null;
    retryable: boolean;
  } | null;
  /** Speaker count of the completed transcription (listing without the payload). */
  speakerCount?: number | null;
  /** The owner said "Not this" to the calendar suggestion. */
  suggestionDismissedAt?: string | null;
  /** Transcription gave up (AssemblyAI lost the job / never finished). */
  failedReason?: string | null;
}

export interface StandaloneRecordingRow {
  id: string;
  owner_user_id: string;
  source_kind: string;
  started_at: string | null;
  duration_ms: number | null;
  sha256: string | null;
  recorder_recording_id: string | null;
  active_transcription_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  standalone: boolean;
  title: string | null;
  expires_at: string | null;
  upload_state: StandaloneUploadState | null;
  ready_notified_at: string | null;
}

const standaloneCols = sql`
  r.id, r.owner_user_id, r.source_kind, r.started_at,
  r.duration_ms::float8 AS duration_ms,
  r.sha256, r.recorder_recording_id, r.active_transcription_id,
  r.created_at, r.updated_at, r.deleted_at,
  r.standalone, r.title, r.expires_at, r.upload_state, r.ready_notified_at
`;

const json = (v: unknown) => (v === undefined || v === null ? null : sql.json(v as never));

// ---------------------------------------------------------------------------
// Create / read / state
// ---------------------------------------------------------------------------

export interface StandaloneInsert {
  id: string;
  ownerUserId: string;
  sourceKind: 'recorder' | 'upload';
  title?: string | null;
  startedAt?: string | null;
  recorderRecordingId?: string | null;
  expiresAt?: Date | null;
  uploadState: StandaloneUploadState;
}

/** INTERNAL-ONLY — the upload pipeline, with the caller's own user id as owner. */
export async function createStandaloneRecording(input: StandaloneInsert): Promise<StandaloneRecordingRow> {
  const rows = await sql<StandaloneRecordingRow[]>`
    INSERT INTO ${sql(SCHEMA)}.recordings AS r
      (id, owner_user_id, source_kind, started_at, recorder_recording_id,
       standalone, title, expires_at, upload_state)
    VALUES (${input.id}::uuid, ${input.ownerUserId}, ${input.sourceKind},
            ${input.startedAt ?? null}::timestamptz, ${input.recorderRecordingId ?? null}::uuid,
            true, ${input.title ?? null}, ${input.expiresAt ?? null},
            ${json({ ...input.uploadState, heartbeatAt: new Date().toISOString() })})
    RETURNING ${standaloneCols}
  `;
  return rows[0]!;
}

/** CALLER-SCOPED (arm a) — the owner's own live standalone recording. */
export async function getStandaloneForOwner(
  ownerUserId: string,
  id: string
): Promise<StandaloneRecordingRow | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await sql<StandaloneRecordingRow[]>`
    SELECT ${standaloneCols} FROM ${sql(SCHEMA)}.recordings r
    WHERE r.id = ${id}::uuid AND r.owner_user_id = ${ownerUserId}
      AND r.standalone AND r.deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

/** INTERNAL-ONLY — by id, any owner (pollers / sweeper). */
export async function getStandalone(id: string): Promise<StandaloneRecordingRow | null> {
  const rows = await sql<StandaloneRecordingRow[]>`
    SELECT ${standaloneCols} FROM ${sql(SCHEMA)}.recordings r
    WHERE r.id = ${id}::uuid AND r.standalone
  `;
  return rows[0] ?? null;
}

/** CALLER-SCOPED — parts 2..N of a group find their recording by group id. */
export async function findStandaloneGroup(
  ownerUserId: string,
  groupId: string
): Promise<StandaloneRecordingRow | null> {
  const rows = await sql<StandaloneRecordingRow[]>`
    SELECT ${standaloneCols} FROM ${sql(SCHEMA)}.recordings r
    WHERE r.owner_user_id = ${ownerUserId} AND r.standalone AND r.deleted_at IS NULL
      AND r.upload_state ? 'group'
      AND r.upload_state->'group'->>'id' = ${groupId}
    ORDER BY r.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * CALLER-SCOPED — shallow-merge keys into `upload_state` (a key set to null
 * is removed), and optionally stamp the heartbeat. Returns the new state.
 */
export async function mergeStandaloneState(
  ownerUserId: string,
  id: string,
  patch: Partial<StandaloneUploadState>,
  opts: { heartbeat?: boolean } = {}
): Promise<StandaloneUploadState | null> {
  const set: Record<string, unknown> = {};
  const drop: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) drop.push(k);
    else if (v !== undefined) set[k] = v;
  }
  if (opts.heartbeat) set.heartbeatAt = new Date().toISOString();
  const rows = await sql<Array<{ upload_state: StandaloneUploadState | null }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET upload_state = (COALESCE(upload_state, '{}'::jsonb) - ${drop}::text[]) || ${sql.json(set as never)},
        updated_at = now()
    WHERE id = ${id}::uuid AND owner_user_id = ${ownerUserId} AND standalone
    RETURNING upload_state
  `;
  return rows[0]?.upload_state ?? null;
}

/**
 * CALLER-SCOPED — stamp one landed part of a multi-file upload atomically
 * (siblings finalize concurrently; a JS read-modify-write would drop one —
 * the same reason as `setUploadPartBytesForUser`). Returns the new state.
 */
export async function setStandaloneGroupPart(
  ownerUserId: string,
  id: string,
  part: StandaloneGroupPart
): Promise<StandaloneUploadState | null> {
  const rows = await sql<Array<{ upload_state: StandaloneUploadState | null }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET upload_state = jsonb_set(
          upload_state || jsonb_build_object('heartbeatAt', to_jsonb(now()::text)),
          '{group,parts}',
          COALESCE((
            SELECT jsonb_agg(p ORDER BY (p->>'index')::int)
            FROM jsonb_array_elements(upload_state->'group'->'parts') AS t(p)
            WHERE (p->>'index')::int <> ${part.index}
          ), '[]'::jsonb) || jsonb_build_array(${sql.json(part as never)}::jsonb)
        ),
        updated_at = now()
    WHERE id = ${id}::uuid AND owner_user_id = ${ownerUserId} AND standalone
      AND jsonb_typeof(upload_state->'group'->'parts') = 'array'
    RETURNING upload_state
  `;
  return rows[0]?.upload_state ?? null;
}

// ---------------------------------------------------------------------------
// Media + transcription at the hand-off, and completion
// ---------------------------------------------------------------------------

export interface StandaloneHandOff {
  recordingId: string;
  canonical: {
    id: string;
    filename: string;
    bytes: number | null;
    hasVideo: boolean;
    sourceRef: Record<string, unknown>;
  };
  parts: Array<{
    id: string;
    ord: number;
    offsetMs: number | null;
    durationMs: number | null;
    sourceRef: Record<string, unknown>;
  }>;
  transcription: {
    id: string;
    providerJobId: string | null;
    speechModel: string | null;
    languageCode: string | null;
    /** null = the hand-off failed and was kept for a retry. */
    status: 'processing' | 'error' | null;
  };
  sha256?: string | null;
}

/**
 * INTERNAL-ONLY — the bytes are on disk under their permanent name and (when
 * `transcription.status` is set) AssemblyAI has the job. One transaction:
 * media rows, the transcription, the active pointer, the upload state
 * cleared of its in-flight keys.
 */
export async function recordStandaloneHandOff(input: StandaloneHandOff): Promise<void> {
  await sql.begin(async (tx) => {
    const c = input.canonical;
    await tx`
      INSERT INTO ${tx(SCHEMA)}.recording_media
        (id, recording_id, kind, ord, offset_ms, filename, bytes, has_video, source_ref)
      VALUES (${c.id}::uuid, ${input.recordingId}::uuid, 'canonical', 0, 0, ${c.filename},
              ${c.bytes}, ${c.hasVideo}, ${tx.json(c.sourceRef as never)})
      ON CONFLICT (id) DO UPDATE SET
        filename = EXCLUDED.filename,
        bytes = COALESCE(EXCLUDED.bytes, recording_media.bytes),
        has_video = EXCLUDED.has_video,
        source_ref = EXCLUDED.source_ref
    `;
    for (const p of input.parts) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.recording_media
          (id, recording_id, kind, ord, offset_ms, duration_ms, source_ref)
        VALUES (${p.id}::uuid, ${input.recordingId}::uuid, 'part', ${p.ord}, ${p.offsetMs},
                ${p.durationMs}, ${tx.json(p.sourceRef as never)})
        ON CONFLICT (id) DO NOTHING
      `;
    }
    const t = input.transcription;
    if (t.status) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.recording_transcriptions
          (id, recording_id, provider, provider_job_id, speech_model, language_code, status, covers)
        VALUES (${t.id}::uuid, ${input.recordingId}::uuid, 'assemblyai', ${t.providerJobId},
                ${t.speechModel}, ${t.languageCode}, ${t.status},
                ${tx.json({
                  media: [c.id, ...input.parts.map((p) => p.id)],
                  timeline: input.parts.length > 0 ? 'concat' : 'wall',
                } as never)})
        ON CONFLICT (id) DO UPDATE SET
          provider_job_id = EXCLUDED.provider_job_id,
          speech_model = EXCLUDED.speech_model,
          language_code = EXCLUDED.language_code,
          status = EXCLUDED.status
      `;
      await tx`
        UPDATE ${tx(SCHEMA)}.recordings
        SET active_transcription_id = ${t.id}::uuid,
            sha256 = COALESCE(${input.sha256 ?? null}, sha256),
            upload_state = COALESCE(upload_state, '{}'::jsonb)
                           - 'ingestFailure' - 'group' - 'bytesReceived',
            updated_at = now()
        WHERE id = ${input.recordingId}::uuid
      `;
    } else {
      await tx`
        UPDATE ${tx(SCHEMA)}.recordings
        SET sha256 = COALESCE(${input.sha256 ?? null}, sha256),
            upload_state = COALESCE(upload_state, '{}'::jsonb) - 'group' - 'bytesReceived',
            updated_at = now()
        WHERE id = ${input.recordingId}::uuid
      `;
    }
  });
}

/**
 * INTERNAL-ONLY — the poll saw the job finish. The payload is stored in the
 * SAME statement that flips the status (DEC-4: after completion AssemblyAI is
 * never asked again), and the recording's duration comes from it. Returns
 * false when the transcription was already terminal (another poller won).
 */
export async function completeStandaloneTranscription(
  transcriptionId: string,
  outcome:
    | { status: 'completed'; payload: TranscriptResponse; completedAt: string | null; speakerCount: number | null }
    | { status: 'error'; reason: string }
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const done = await tx<Array<{ recording_id: string }>>`
      UPDATE ${tx(SCHEMA)}.recording_transcriptions
      SET status = ${outcome.status},
          payload = ${outcome.status === 'completed' ? tx.json(outcome.payload as never) : null},
          language_code = COALESCE(${outcome.status === 'completed' ? (outcome.payload.language_code ?? null) : null}, language_code),
          completed_at = ${outcome.status === 'completed' ? (outcome.completedAt ?? new Date().toISOString()) : null}
      WHERE id = ${transcriptionId}::uuid AND status = 'processing'
      RETURNING recording_id
    `;
    const recordingId = done[0]?.recording_id;
    if (!recordingId) return false;
    if (outcome.status === 'completed') {
      const secs = outcome.payload.audio_duration;
      await tx`
        UPDATE ${tx(SCHEMA)}.recordings
        SET duration_ms = COALESCE(${typeof secs === 'number' ? Math.round(secs * 1000) : null}, duration_ms),
            upload_state = COALESCE(upload_state, '{}'::jsonb)
                           || jsonb_build_object('speakerCount', ${outcome.speakerCount}::int),
            updated_at = now()
        WHERE id = ${recordingId}::uuid
      `;
      await tx`
        UPDATE ${tx(SCHEMA)}.recording_media
        SET duration_ms = COALESCE(duration_ms, ${typeof secs === 'number' ? Math.round(secs * 1000) : null})
        WHERE recording_id = ${recordingId}::uuid AND kind = 'canonical'
      `;
    } else {
      await tx`
        UPDATE ${tx(SCHEMA)}.recordings
        SET upload_state = COALESCE(upload_state, '{}'::jsonb)
                           || jsonb_build_object('failedReason', ${outcome.reason}::text),
            updated_at = now()
        WHERE id = ${recordingId}::uuid
      `;
    }
    return true;
  });
}

/**
 * INTERNAL-ONLY — claim the one "your recording is transcribed" DM. True
 * exactly once per recording, whoever observes the completion first (the
 * request that polled, the in-process watcher, the sweeper).
 */
export async function claimReadyNotification(recordingId: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET ready_notified_at = now()
    WHERE id = ${recordingId}::uuid AND standalone AND ready_notified_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** INTERNAL-ONLY — hand the claim back when the DM could not be sent. */
export async function releaseReadyNotification(recordingId: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.recordings SET ready_notified_at = NULL
    WHERE id = ${recordingId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// The owner's view
// ---------------------------------------------------------------------------

export interface StandaloneListRow extends StandaloneRecordingRow {
  txn_status: string | null;
  txn_language_code: string | null;
  txn_speech_model: string | null;
  txn_completed_at: string | null;
  provider_deleted_at: string | null;
  canonical_filename: string | null;
  canonical_bytes: number | null;
  canonical_has_video: boolean | null;
  part_count: number;
  /** Clips on it held by a meeting that is not in the trash. */
  live_clips: number;
  /** Clips on it held by any meeting (trashed ones keep the bytes alive). */
  all_clips: number;
  recorder_matched: RecorderMatch | null;
  recorder_call: RecorderCall | null;
}

function listSelect() {
  return sql`
    SELECT ${standaloneCols},
           t.status AS txn_status,
           t.language_code AS txn_language_code,
           t.speech_model AS txn_speech_model,
           t.completed_at AS txn_completed_at,
           t.provider_deleted_at,
           m.filename AS canonical_filename,
           m.bytes AS canonical_bytes,
           m.has_video AS canonical_has_video,
           (SELECT count(*)::int FROM ${sql(SCHEMA)}.recording_media p
             WHERE p.recording_id = r.id AND p.kind = 'part') AS part_count,
           (SELECT count(*)::int
              FROM ${sql(SCHEMA)}.meeting_clips c
              JOIN ${sql(SCHEMA)}.transcripts tr ON tr.id = c.transcript_id
             WHERE c.recording_id = r.id AND tr.deleted_at IS NULL) AS live_clips,
           (SELECT count(*)::int FROM ${sql(SCHEMA)}.meeting_clips c
             WHERE c.recording_id = r.id) AS all_clips,
           rr.matched AS recorder_matched,
           rr.call AS recorder_call
    FROM ${sql(SCHEMA)}.recordings r
    LEFT JOIN ${sql(SCHEMA)}.recording_transcriptions t ON t.id = r.active_transcription_id
    LEFT JOIN LATERAL (
      SELECT filename, bytes::float8 AS bytes, has_video
      FROM ${sql(SCHEMA)}.recording_media
      WHERE recording_id = r.id AND kind = 'canonical'
      ORDER BY ord LIMIT 1
    ) m ON true
    LEFT JOIN ${sql(SCHEMA)}.recorder_recordings rr
      ON rr.id = r.recorder_recording_id AND rr.user_id = r.owner_user_id
  `;
}

/** CALLER-SCOPED — several of the owner's recordings by id (a page's keys). */
export async function getStandaloneViewsForOwner(
  ownerUserId: string,
  ids: string[]
): Promise<StandaloneListRow[]> {
  const uuids = ids.filter((id) => UUID_RE.test(id));
  if (uuids.length === 0) return [];
  return sql<StandaloneListRow[]>`
    ${listSelect()}
    WHERE r.id = ANY(${uuids}::uuid[]) AND r.owner_user_id = ${ownerUserId}
      AND r.standalone AND r.deleted_at IS NULL
  `;
}

/** CALLER-SCOPED — one of the owner's recordings, with the list columns. */
export async function getStandaloneViewForOwner(
  ownerUserId: string,
  id: string
): Promise<StandaloneListRow | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await sql<StandaloneListRow[]>`
    ${listSelect()}
    WHERE r.id = ${id}::uuid AND r.owner_user_id = ${ownerUserId}
      AND r.standalone AND r.deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

/**
 * CALLER-SCOPED — the payload of the owner's recording's active
 * transcription (the recording page's text). null while transcribing.
 */
export async function getStandalonePayloadForOwner(
  ownerUserId: string,
  id: string
): Promise<TranscriptResponse | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await sql<Array<{ payload: TranscriptResponse | null }>>`
    SELECT t.payload
    FROM ${sql(SCHEMA)}.recordings r
    JOIN ${sql(SCHEMA)}.recording_transcriptions t ON t.id = r.active_transcription_id
    WHERE r.id = ${id}::uuid AND r.owner_user_id = ${ownerUserId}
      AND r.standalone AND r.deleted_at IS NULL
  `;
  return rows[0]?.payload ?? null;
}

export interface RecordingMeetingRef {
  assemblyai_id: string;
  title: string | null;
  trashed: boolean;
}

/**
 * CALLER-SCOPED — the meetings holding a clip on this recording that the
 * CALLER can open (owner, or a share on their email). A meeting whose
 * ownership moved to someone who did not share it back is not named.
 */
export async function meetingsHoldingRecording(
  recordingId: string,
  caller: { userId: string; email: string }
): Promise<RecordingMeetingRef[]> {
  const email = caller.email.trim().toLowerCase();
  return sql<RecordingMeetingRef[]>`
    SELECT DISTINCT t.assemblyai_id, t.title, (t.deleted_at IS NOT NULL) AS trashed
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id AND s.shared_with_email = ${email}
    WHERE c.recording_id = ${recordingId}::uuid
      AND (t.user_id = ${caller.userId} OR (s.id IS NOT NULL AND t.deleted_at IS NULL))
  `;
}

/**
 * Reachability arm (b), for the media route ONLY: can the caller open a
 * meeting (owned, or shared to their email, not in the trash unless owned)
 * that holds a clip on this recording? Nothing about the recording is
 * returned — just the answer.
 *
 * `wholeRecording: true` (the bytes route, 2026-10-02) counts only a clip
 * that IS the whole recording (`from_ms = 0 AND to_ms IS NULL`). A reader of
 * a meeting that holds a WINDOW — a split-off meeting, a combined clip — gets
 * that window from the meeting's own media route, cut server-side
 * (lib/server/clip-cut.ts), and never the recording through this one: "it is
 * not the recording being shared, it's the meeting API that reveals it".
 */
export async function reachableThroughMeeting(
  recordingId: string,
  caller: { userId: string; email: string },
  opts: { wholeRecording?: boolean } = {}
): Promise<boolean> {
  if (!UUID_RE.test(recordingId)) return false;
  const email = caller.email.trim().toLowerCase();
  const rows = await sql<Array<{ ok: number }>>`
    SELECT 1 AS ok
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
    WHERE c.recording_id = ${recordingId}::uuid
      ${opts.wholeRecording ? sql`AND c.from_ms = 0 AND c.to_ms IS NULL` : sql``}
      AND (
        t.user_id = ${caller.userId}
        OR (t.deleted_at IS NULL AND EXISTS (
              SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares s
              WHERE s.transcript_id = t.id AND s.shared_with_email = ${email}))
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

/** INTERNAL-ONLY — the playable files of a recording, canonical first. */
export async function standaloneMedia(recordingId: string): Promise<
  Array<{ id: string; kind: string; ord: number; filename: string | null; blob_name: string | null; has_video: boolean | null }>
> {
  return sql`
    SELECT id, kind, ord, filename, blob_name, has_video
    FROM ${sql(SCHEMA)}.recording_media
    WHERE recording_id = ${recordingId}::uuid
    ORDER BY CASE kind WHEN 'canonical' THEN 0 WHEN 'part' THEN 1 ELSE 2 END, ord
  `;
}

// ---------------------------------------------------------------------------
// Owner actions
// ---------------------------------------------------------------------------

/**
 * CALLER-SCOPED — Keep (P8 / Q6): the expiry goes, it stays a recording.
 * Optionally renames it. Returns false when it is not the caller's.
 */
export async function keepStandalone(
  ownerUserId: string,
  id: string,
  patch: { keep?: boolean; title?: string | null; dismissSuggestion?: boolean }
): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET expires_at = ${patch.keep ? null : sql`expires_at`},
        title = ${patch.title === undefined ? sql`title` : patch.title},
        upload_state = ${
          patch.dismissSuggestion
            ? sql`COALESCE(upload_state, '{}'::jsonb) || jsonb_build_object('suggestionDismissedAt', to_jsonb(now()::text))`
            : sql`upload_state`
        },
        updated_at = now()
    WHERE id = ${id}::uuid AND owner_user_id = ${ownerUserId}
      AND standalone AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

export interface StandaloneFiles {
  filenames: string[];
  providerJobIds: string[];
}

/**
 * INTERNAL-ONLY (the caller has checked ownership, or is the sweeper) —
 * delete a standalone recording's rows for good, IF no meeting (live or
 * trashed) holds a clip on it. Returns the files to unlink and the jobs to
 * delete at AssemblyAI, or null when a clip exists (nothing was touched).
 * The row lock makes a concurrent Link wait and then find it gone.
 */
export async function deleteStandaloneRows(recordingId: string): Promise<StandaloneFiles | null> {
  return sql.begin(async (tx) => {
    const locked = await tx<Array<{ id: string }>>`
      SELECT id FROM ${tx(SCHEMA)}.recordings
      WHERE id = ${recordingId}::uuid AND standalone
      FOR UPDATE
    `;
    if (locked.length === 0) return { filenames: [], providerJobIds: [] };
    const clipped = await tx<Array<{ n: number }>>`
      SELECT 1 AS n FROM ${tx(SCHEMA)}.meeting_clips WHERE recording_id = ${recordingId}::uuid LIMIT 1
    `;
    if (clipped.length > 0) return null;
    const media = await tx<Array<{ filename: string | null }>>`
      DELETE FROM ${tx(SCHEMA)}.recording_media WHERE recording_id = ${recordingId}::uuid
      RETURNING filename
    `;
    const txns = await tx<Array<{ provider_job_id: string | null; provider_deleted_at: string | null }>>`
      DELETE FROM ${tx(SCHEMA)}.recording_transcriptions WHERE recording_id = ${recordingId}::uuid
      RETURNING provider_job_id, provider_deleted_at
    `;
    await tx`
      UPDATE ${tx(SCHEMA)}.recorder_recordings SET recording_id = NULL
      WHERE recording_id = ${recordingId}::uuid
    `;
    await tx`DELETE FROM ${tx(SCHEMA)}.recordings WHERE id = ${recordingId}::uuid`;
    return {
      filenames: media.map((m) => m.filename).filter((f): f is string => !!f),
      providerJobIds: txns
        .filter((t) => t.provider_job_id && !t.provider_deleted_at)
        .map((t) => t.provider_job_id!),
    };
  });
}

// ---------------------------------------------------------------------------
// Sweeper / poller work lists (INTERNAL-ONLY)
// ---------------------------------------------------------------------------

/** P8: standalone recordings past their expiry that no meeting clips (I6). */
export async function listExpiredStandalone(limit: number): Promise<
  Array<{ id: string; owner_user_id: string; title: string | null; expires_at: string }>
> {
  return sql`
    SELECT r.id, r.owner_user_id, r.title, r.expires_at::text AS expires_at
    FROM ${sql(SCHEMA)}.recordings r
    WHERE r.standalone AND r.deleted_at IS NULL
      AND r.expires_at IS NOT NULL AND r.expires_at < now()
      AND NOT EXISTS (SELECT 1 FROM ${sql(SCHEMA)}.meeting_clips c WHERE c.recording_id = r.id)
    ORDER BY r.expires_at
    LIMIT ${limit}
  `;
}

/** Uploads that stopped arriving: no transcription, no kept failure, no heartbeat for N minutes. */
export async function listStaleStandaloneUploads(minutes: number, limit: number): Promise<
  Array<{ id: string; owner_user_id: string; upload_state: StandaloneUploadState | null }>
> {
  return sql`
    SELECT r.id, r.owner_user_id, r.upload_state
    FROM ${sql(SCHEMA)}.recordings r
    WHERE r.standalone AND r.deleted_at IS NULL
      AND r.active_transcription_id IS NULL
      AND NOT (COALESCE(r.upload_state, '{}'::jsonb) ? 'ingestFailure')
      AND NOT EXISTS (SELECT 1 FROM ${sql(SCHEMA)}.recording_media m WHERE m.recording_id = r.id)
      AND COALESCE((r.upload_state->>'heartbeatAt')::timestamptz, r.updated_at)
          < now() - make_interval(mins => ${minutes})
      -- A session still open (a blob-transit upload has no heartbeat of ours
      -- until complete) keeps it alive; the session sweeper expires those.
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.upload_sessions s
        WHERE s.placeholder_id = 'rec-' || r.id::text AND s.status IN ('open', 'completing')
      )
    ORDER BY r.updated_at
    LIMIT ${limit}
  `;
}

/** Transcriptions still at AssemblyAI (the poll backstop). */
export async function listProcessingStandalone(limit: number): Promise<
  Array<{ recording_id: string; owner_user_id: string; transcription_id: string; provider_job_id: string; created_at: string }>
> {
  return sql`
    SELECT r.id AS recording_id, r.owner_user_id, t.id AS transcription_id,
           t.provider_job_id, t.created_at::text AS created_at
    FROM ${sql(SCHEMA)}.recordings r
    JOIN ${sql(SCHEMA)}.recording_transcriptions t ON t.id = r.active_transcription_id
    WHERE r.standalone AND r.deleted_at IS NULL
      AND t.status = 'processing' AND t.provider_job_id IS NOT NULL
    ORDER BY t.created_at
    LIMIT ${limit}
  `;
}

/** Completed recordings whose ready DM was never claimed (a crash between the two). */
export async function listUnnotifiedStandalone(limit: number): Promise<Array<{ id: string; owner_user_id: string }>> {
  return sql`
    SELECT r.id, r.owner_user_id
    FROM ${sql(SCHEMA)}.recordings r
    JOIN ${sql(SCHEMA)}.recording_transcriptions t ON t.id = r.active_transcription_id
    WHERE r.standalone AND r.deleted_at IS NULL AND r.ready_notified_at IS NULL
      AND t.status = 'completed' AND t.completed_at > now() - interval '2 days'
    LIMIT ${limit}
  `;
}

/** Kept hand-off failures due for another try. */
export async function listStandaloneIngestRetries(limit: number): Promise<
  Array<{ id: string; owner_user_id: string }>
> {
  return sql`
    SELECT r.id, r.owner_user_id
    FROM ${sql(SCHEMA)}.recordings r
    WHERE r.standalone AND r.deleted_at IS NULL
      AND r.active_transcription_id IS NULL
      AND (r.upload_state->'ingestFailure'->>'retryable')::boolean
      AND (r.upload_state->'ingestFailure'->>'nextAt')::timestamptz <= now()
    ORDER BY (r.upload_state->'ingestFailure'->>'nextAt')::timestamptz
    LIMIT ${limit}
  `;
}

/** DEC-4: completed jobs still held at AssemblyAI. */
export async function listStandaloneAaiDeletePending(limit: number): Promise<
  Array<{ transcription_id: string; provider_job_id: string; utterances: number; canonical_filename: string | null }>
> {
  return sql`
    SELECT t.id AS transcription_id, t.provider_job_id,
           COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.payload->'utterances') = 'array'
                                            THEN t.payload->'utterances' END), 0) AS utterances,
           m.filename AS canonical_filename
    FROM ${sql(SCHEMA)}.recordings r
    JOIN ${sql(SCHEMA)}.recording_transcriptions t ON t.recording_id = r.id
    LEFT JOIN ${sql(SCHEMA)}.recording_media m ON m.recording_id = r.id AND m.kind = 'canonical'
    WHERE r.standalone AND t.status = 'completed'
      AND t.provider_job_id IS NOT NULL AND t.provider_deleted_at IS NULL
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// The registry link (Q9)
// ---------------------------------------------------------------------------

/**
 * CALLER-SCOPED — the tray's registry row gets the recording its bytes became
 * (`recording_id`, the new column) and flips to `uploaded`. `transcript_id`
 * is left to what the tray writes itself (the pseudo id it was answered —
 * the tray reads that column for its "uploaded" state and nothing on the
 * server joins it to a meeting for a standalone recording).
 */
export async function linkRegistryToRecording(
  ownerUserId: string,
  recorderRecordingId: string,
  recordingId: string
): Promise<boolean> {
  if (!UUID_RE.test(recorderRecordingId)) return false;
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recorder_recordings
    SET recording_id = ${recordingId}::uuid, status = 'uploaded', error = NULL, updated_at = now()
    WHERE id = ${recorderRecordingId}::uuid AND user_id = ${ownerUserId}
    RETURNING id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Link / Make a meeting — ONE transaction
// ---------------------------------------------------------------------------

export interface MeetingFromRecordingInput {
  ownerUserId: string;
  recordingId: string;
  /** The new meeting's public id (a bare uuid — Phase 1b's minted shape). */
  meetingId: string;
  title: string | null;
  recordedAt: string | null;
  gmeetContext: GmeetContext;
}

export type MeetingFromRecordingResult =
  | {
      ok: true;
      transcriptId: number;
      assemblyaiId: string;
      /**
       * false = the recording was still uploading / at AssemblyAI, so the
       * meeting was born 'processing' with no text; `materialiseMeetingsMadeEarly`
       * fills it in when the transcription lands.
       */
      ready: boolean;
    }
  | { ok: false; code: 'not-found' | 'not-ready' | 'already-linked' };

/**
 * CALLER-SCOPED (the owner predicate is the row lock's WHERE) — the meeting
 * row, its one clip over the whole recording, and the expiry cleared, in ONE
 * transaction (design P7: "Link / Make a meeting create the transcripts row +
 * clip in one transaction").
 *
 * The meeting's `imported_content` is copied from the transcription INSIDE
 * Postgres (jsonb to jsonb, never through JS), so its `/content` is the
 * recording's payload verbatim — compat mode (docs/recordings-phase1-spec.md
 * §3).
 *
 * A recording that is NOT transcribed yet (still uploading, or still at
 * AssemblyAI) is linked all the same (Alok, 2026-09-30: "link and make
 * meeting must not be blocked by the upload or the transcription"): the
 * meeting row is born 'processing' with no payload and no job id — so the
 * meeting-side AAI poller leaves it alone — and the recording's own
 * completion fills it in (`materialiseMeetingsMadeEarly`). Only a
 * transcription that has FAILED refuses ('not-ready'): there is nothing to
 * hand the meeting until the recording is retried. Its `local_audio_path` is the recording's canonical file, exactly as a
 * split-off meeting borrows its source's (Phase 3a), and its
 * `gmeet_context.clips` mirror names the recording, so the dual-write treats
 * it as a BORROWER (`borrowsRecording`) and never derives a second recording
 * over the same bytes.
 *
 * NO SHARE is written here or anywhere on this path (design P4).
 */
export async function createMeetingFromRecording(
  input: MeetingFromRecordingInput
): Promise<MeetingFromRecordingResult> {
  return sql.begin(async (tx): Promise<MeetingFromRecordingResult> => {
    const rec = await tx<Array<{ id: string; active_transcription_id: string | null }>>`
      SELECT id, active_transcription_id FROM ${tx(SCHEMA)}.recordings
      WHERE id = ${input.recordingId}::uuid AND owner_user_id = ${input.ownerUserId}
        AND standalone AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (rec.length === 0) return { ok: false, code: 'not-found' };
    const live = await tx<Array<{ n: number }>>`
      SELECT 1 AS n FROM ${tx(SCHEMA)}.meeting_clips c
      JOIN ${tx(SCHEMA)}.transcripts t ON t.id = c.transcript_id
      WHERE c.recording_id = ${input.recordingId}::uuid AND t.deleted_at IS NULL
      LIMIT 1
    `;
    if (live.length > 0) return { ok: false, code: 'already-linked' };
    const txnId = rec[0]!.active_transcription_id;
    const txn = txnId
      ? await tx<
          Array<{ status: string; provider_job_id: string | null; provider_deleted_at: string | null; has_payload: boolean }>
        >`
          SELECT status, provider_job_id, provider_deleted_at::text AS provider_deleted_at,
                 (payload IS NOT NULL) AS has_payload
          FROM ${tx(SCHEMA)}.recording_transcriptions
          WHERE id = ${txnId}::uuid
        `
      : [];
    if (txn[0]?.status === 'error') return { ok: false, code: 'not-ready' };
    const ready = txn[0]?.status === 'completed' && txn[0].has_payload === true;

    const ctx: GmeetContext = {
      ...input.gmeetContext,
      clips: [{ ord: 0, recordingId: input.recordingId, fromMs: 0, toMs: null, offsetMs: 0 }],
      ...(ready && txn[0]!.provider_job_id && txn[0]!.provider_deleted_at
        ? { aai: { deletedAt: new Date(txn[0]!.provider_deleted_at).toISOString(), jobId: txn[0]!.provider_job_id } }
        : {}),
    };

    const inserted = await tx<Array<{ id: number; assemblyai_id: string }>>`
      INSERT INTO ${tx(SCHEMA)}.transcripts (
        user_id, assemblyai_id, aai_job_id, original_filename, status, created_at,
        completed_at, duration, speaker_count, language_code, title, source,
        speech_model, local_audio_path, gmeet_context, imported_content, recorded_at, scratch
      )
      SELECT ${input.ownerUserId}, ${input.meetingId},
             CASE WHEN ${ready} THEN t.provider_job_id END,
             r.upload_state->>'originalFilename',
             CASE WHEN ${ready} THEN 'completed' ELSE 'processing' END, now(),
             CASE WHEN ${ready} THEN t.completed_at END,
             CASE WHEN ${ready} THEN (t.payload->>'audio_duration')::float8 END,
             NULLIF((r.upload_state->>'speakerCount')::int, 0),
             COALESCE(t.language_code, t.payload->>'language_code'),
             ${input.title}, 'uploaded', t.speech_model,
             (SELECT m.filename FROM ${tx(SCHEMA)}.recording_media m
               WHERE m.recording_id = r.id AND m.kind = 'canonical' ORDER BY m.ord LIMIT 1),
             ${tx.json(ctx as never)},
             CASE WHEN ${ready} THEN t.payload END,
             COALESCE(${input.recordedAt}::timestamptz, r.started_at, r.created_at),
             false
      FROM ${tx(SCHEMA)}.recordings r
      LEFT JOIN ${tx(SCHEMA)}.recording_transcriptions t ON t.id = r.active_transcription_id
      WHERE r.id = ${input.recordingId}::uuid
      RETURNING id, assemblyai_id
    `;
    const row = inserted[0]!;
    await tx`
      INSERT INTO ${tx(SCHEMA)}.meeting_clips
        (transcript_id, ord, recording_id, transcription_id, from_ms, to_ms, offset_ms, text_policy, created_by)
      VALUES (${row.id}, 0, ${input.recordingId}::uuid, NULL, 0, NULL, 0, 'include', ${input.ownerUserId})
    `;
    await tx`
      UPDATE ${tx(SCHEMA)}.recordings
      SET expires_at = NULL, updated_at = now()
      WHERE id = ${input.recordingId}::uuid
    `;
    return { ok: true, transcriptId: row.id, assemblyaiId: row.assemblyai_id, ready };
  });
}

/** A meeting `createMeetingFromRecording` made before its recording was transcribed. */
export interface MeetingMadeEarly {
  user_id: string;
  assemblyai_id: string;
}

/**
 * Fill in every meeting that was made from a recording BEFORE its
 * transcription landed — the same columns `createMeetingFromRecording`
 * writes for a ready recording, copied inside Postgres now that the
 * payload exists. Idempotent: a meeting is matched only while it is still
 * 'processing' with no `imported_content`, so a second observer of the same
 * completion updates nothing. `recordingId` null = every such meeting (the
 * sweeper's backstop for a process that died between the two writes).
 *
 * Only meetings BORN from this recording qualify (`gmeet_context.fromRecording`)
 * — a meeting that merely holds a clip of it (Phase 3b combine) has its own
 * transcription and is re-materialised by `rematerialiseCombinedMeetings`.
 */
export async function materialiseMeetingsMadeEarly(recordingId: string | null): Promise<MeetingMadeEarly[]> {
  return sql<MeetingMadeEarly[]>`
    UPDATE ${sql(SCHEMA)}.transcripts t
    SET status = 'completed',
        completed_at = COALESCE(x.completed_at, now()),
        aai_job_id = x.provider_job_id,
        duration = (x.payload->>'audio_duration')::float8,
        speaker_count = NULLIF((r.upload_state->>'speakerCount')::int, 0),
        language_code = COALESCE(x.language_code, x.payload->>'language_code', t.language_code),
        speech_model = COALESCE(x.speech_model, t.speech_model),
        local_audio_path = COALESCE(t.local_audio_path,
          (SELECT m.filename FROM ${sql(SCHEMA)}.recording_media m
            WHERE m.recording_id = r.id AND m.kind = 'canonical' ORDER BY m.ord LIMIT 1)),
        imported_content = x.payload,
        gmeet_context = COALESCE(t.gmeet_context, '{}'::jsonb) ||
          CASE WHEN x.provider_job_id IS NOT NULL AND x.provider_deleted_at IS NOT NULL
               THEN jsonb_build_object('aai', jsonb_build_object('deletedAt', to_jsonb(x.provider_deleted_at), 'jobId', x.provider_job_id))
               ELSE '{}'::jsonb END
    FROM ${sql(SCHEMA)}.recordings r
    JOIN ${sql(SCHEMA)}.recording_transcriptions x ON x.id = r.active_transcription_id
    JOIN ${sql(SCHEMA)}.meeting_clips c ON c.recording_id = r.id
    WHERE c.transcript_id = t.id
      AND t.gmeet_context->'fromRecording'->>'recordingId' = r.id::text
      AND t.status = 'processing' AND t.imported_content IS NULL AND t.deleted_at IS NULL
      AND x.status = 'completed' AND x.payload IS NOT NULL
      AND (${recordingId}::uuid IS NULL OR r.id = ${recordingId}::uuid)
    RETURNING t.user_id, t.assemblyai_id
  `;
}

/**
 * The recording's transcription FAILED after a meeting was made from it:
 * the meeting flips to 'error' carrying the same `ingestFailure` marker a
 * lost AssemblyAI job leaves, so the listing and the detail page say why.
 * `retryable: false` — the human retries the RECORDING, which re-runs this.
 */
export async function failMeetingsMadeEarly(recordingId: string, reason: string): Promise<MeetingMadeEarly[]> {
  const now = new Date().toISOString();
  const failure = {
    stage: 'aai-job',
    message: reason,
    firstAt: now,
    at: now,
    attempts: 1,
    nextAt: null,
    retryable: false,
    opts: { originalFilename: null },
  };
  return sql<MeetingMadeEarly[]>`
    UPDATE ${sql(SCHEMA)}.transcripts t
    SET status = 'error',
        gmeet_context = COALESCE(t.gmeet_context, '{}'::jsonb) || ${sql.json({ ingestFailure: failure } as never)}
    FROM ${sql(SCHEMA)}.meeting_clips c
    WHERE c.transcript_id = t.id AND c.recording_id = ${recordingId}::uuid
      AND t.gmeet_context->'fromRecording'->>'recordingId' = ${recordingId}
      AND t.status = 'processing' AND t.imported_content IS NULL AND t.deleted_at IS NULL
    RETURNING t.user_id, t.assemblyai_id
  `;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
