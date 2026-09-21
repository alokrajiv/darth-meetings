import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { TranscriptResponse } from '@/lib/format';
import type { ClipTextPolicy } from '@/lib/recording-clips';

/**
 * First-class recordings (migration 044) — recordings, their files, their
 * transcriptions, and the clips a meeting takes over them. See
 * docs/recordings-phase1-spec.md §1/§3.
 *
 * PRIVACY — read this before adding a function here.
 * A recording has no ACL of its own. It is reachable exactly two ways
 * (spec §1): through a MEETING the caller can access, or by its OWNER. So
 * every function below is one of:
 *
 *   CALLER-SCOPED  — takes the caller's user id and constrains on it. Safe to
 *                    call straight from a route. Marked on each function.
 *   INTERNAL-ONLY  — takes ids with no owner constraint. The CALLER MUST have
 *                    already passed `resolveAccess()` (or equivalent) on the
 *                    meeting those ids came from. Never hand one of these a
 *                    client-supplied id without that gate first
 *                    (feedback_privacy_caller_scoping_gate).
 *
 * Nothing calls this module yet: Phase 1a creates the tables and the ops,
 * Phase 1b wires the writers and readers up.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const RECORDING_SOURCE_KINDS = [
  'recorder',
  'upload',
  'meet',
  'teams',
  'text',
  'aai-import',
] as const;
export type RecordingSourceKind = (typeof RECORDING_SOURCE_KINDS)[number];

export const RECORDING_MEDIA_KINDS = ['canonical', 'part', 'audio_only', 'faststart'] as const;
export type RecordingMediaKind = (typeof RECORDING_MEDIA_KINDS)[number];

export const TRANSCRIPTION_PROVIDERS = ['assemblyai', 'meet-doc', 'teams-vtt', 'text'] as const;
export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];

export type TranscriptionStatus = 'processing' | 'completed' | 'error';

/** What a transcription job actually heard (`recording_transcriptions.covers`). */
export interface TranscriptionCovers {
  /** `recording_media.id`s whose audio is inside the job's input. */
  media: string[];
  /** 'wall' = payload ms are recording (wall) time; 'concat' = the parts were
   * joined with their gaps removed before the job ran. */
  timeline: 'wall' | 'concat';
}

export interface RecordingRow {
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
}

export interface RecordingMediaRow {
  id: string;
  recording_id: string;
  kind: string;
  ord: number;
  offset_ms: number | null;
  duration_ms: number | null;
  filename: string | null;
  blob_name: string | null;
  bytes: number | null;
  has_video: boolean | null;
  sha256: string | null;
  source_ref: Record<string, unknown> | null;
  of_media_id: string | null;
  created_at: string;
}

export interface RecordingTranscriptionRow {
  id: string;
  recording_id: string;
  provider: string;
  provider_job_id: string | null;
  provider_deleted_at: string | null;
  speech_model: string | null;
  language_code: string | null;
  status: string;
  payload: TranscriptResponse | null;
  covers: TranscriptionCovers | null;
  created_at: string;
  completed_at: string | null;
  superseded_by: string | null;
}

export interface MeetingClipRow {
  transcript_id: number;
  ord: number;
  recording_id: string;
  transcription_id: string | null;
  from_ms: number;
  to_ms: number | null;
  offset_ms: number;
  text_policy: string;
  created_by: string | null;
  created_at: string;
}

/** jsonb bind helper — postgres.js needs `sql.json` for an object literal. */
const json = (v: unknown) => (v === undefined || v === null ? null : sql.json(v as never));

// bigint comes back from postgres.js as a STRING (it doesn't fit a JS number
// in the general case). Every bigint column here is a duration, an offset or
// a byte count — all comfortably inside Number.MAX_SAFE_INTEGER — so the
// column lists below cast them to float8 and the row types say `number`.
// Do NOT replace these with `SELECT *`.
const recordingCols = sql`
  id, owner_user_id, source_kind, started_at,
  duration_ms::float8 AS duration_ms,
  sha256, recorder_recording_id, active_transcription_id,
  created_at, updated_at, deleted_at
`;
const mediaCols = sql`
  id, recording_id, kind, ord,
  offset_ms::float8 AS offset_ms,
  duration_ms::float8 AS duration_ms,
  filename, blob_name,
  bytes::float8 AS bytes,
  has_video, sha256, source_ref, of_media_id, created_at
`;
const clipCols = sql`
  transcript_id, ord, recording_id, transcription_id,
  from_ms::float8 AS from_ms,
  to_ms::float8 AS to_ms,
  offset_ms::float8 AS offset_ms,
  text_policy, created_by, created_at
`;

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

export interface RecordingInsert {
  id: string;
  ownerUserId: string;
  sourceKind: RecordingSourceKind;
  startedAt?: Date | string | null;
  durationMs?: number | null;
  sha256?: string | null;
  recorderRecordingId?: string | null;
}

/**
 * INTERNAL-ONLY (the caller decides the owner — never take it from a client).
 * Idempotent on `id`: the backfill mints deterministic uuidv5 ids and must
 * converge when it is re-run, and a shared AssemblyAI job (two owners, one
 * recording — landmine #14) reaches this twice by design. Re-inserting only
 * fills gaps; it never downgrades a known value to NULL.
 */
export async function createRecording(input: RecordingInsert): Promise<RecordingRow> {
  const rows = await sql<RecordingRow[]>`
    INSERT INTO ${sql(SCHEMA)}.recordings
      (id, owner_user_id, source_kind, started_at, duration_ms, sha256, recorder_recording_id)
    VALUES (${input.id}::uuid, ${input.ownerUserId}, ${input.sourceKind},
            ${input.startedAt ?? null}, ${input.durationMs ?? null},
            ${input.sha256 ?? null},
            ${input.recorderRecordingId ?? null}::uuid)
    ON CONFLICT (id) DO UPDATE SET
      source_kind           = EXCLUDED.source_kind,
      started_at            = COALESCE(EXCLUDED.started_at, recordings.started_at),
      duration_ms           = COALESCE(EXCLUDED.duration_ms, recordings.duration_ms),
      sha256                = COALESCE(EXCLUDED.sha256, recordings.sha256),
      recorder_recording_id = COALESCE(EXCLUDED.recorder_recording_id,
                                       recordings.recorder_recording_id),
      updated_at            = now()
    RETURNING ${recordingCols}
  `;
  return rows[0]!;
}

/**
 * INTERNAL-ONLY — no owner constraint. Use `getRecordingForOwner` from a
 * route, or gate on the meeting first.
 */
export async function getRecording(id: string): Promise<RecordingRow | null> {
  const rows = await sql<RecordingRow[]>`
    SELECT ${recordingCols} FROM ${sql(SCHEMA)}.recordings WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
}

/** CALLER-SCOPED — reachability route (b): the caller owns the recording. */
export async function getRecordingForOwner(
  ownerUserId: string,
  id: string
): Promise<RecordingRow | null> {
  const rows = await sql<RecordingRow[]>`
    SELECT ${recordingCols} FROM ${sql(SCHEMA)}.recordings
    WHERE id = ${id}::uuid AND owner_user_id = ${ownerUserId} AND deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

/** CALLER-SCOPED — the owner's recordings, newest capture first. */
export async function listRecordingsForOwner(
  ownerUserId: string,
  opts?: { limit?: number }
): Promise<RecordingRow[]> {
  return sql<RecordingRow[]>`
    SELECT ${recordingCols} FROM ${sql(SCHEMA)}.recordings
    WHERE owner_user_id = ${ownerUserId} AND deleted_at IS NULL
    ORDER BY started_at DESC NULLS LAST, created_at DESC
    LIMIT ${opts?.limit ?? 200}
  `;
}

/** INTERNAL-ONLY — called right after a transcription completes. */
export async function setActiveTranscription(
  recordingId: string,
  transcriptionId: string | null
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.recordings
    SET active_transcription_id = ${transcriptionId}::uuid, updated_at = now()
    WHERE id = ${recordingId}::uuid
  `;
}

/**
 * CALLER-SCOPED — the owner trashes their own recording. Bytes are NOT
 * removed here: that happens only when no live meeting still has a clip on
 * it (`liveMeetingsForRecording`), per design §5 D-F.
 */
export async function softDeleteRecording(ownerUserId: string, id: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET deleted_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND owner_user_id = ${ownerUserId} AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * INTERNAL-ONLY — ownership transfer of a meeting moves its recordings too
 * (landmine #1: `transferOwnership` already moves both id families).
 * Only recordings whose every live meeting belongs to the new owner should
 * be passed in; the caller makes that judgement.
 */
export async function transferRecordingOwnership(
  recordingIds: string[],
  fromUserId: string,
  toUserId: string
): Promise<number> {
  if (recordingIds.length === 0) return 0;
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET owner_user_id = ${toUserId}, updated_at = now()
    WHERE id = ANY(${recordingIds}::uuid[]) AND owner_user_id = ${fromUserId}
    RETURNING id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface RecordingMediaInsert {
  id: string;
  recordingId: string;
  kind: RecordingMediaKind;
  ord?: number;
  offsetMs?: number | null;
  durationMs?: number | null;
  /** Basename only — `resolveAudioPath` refuses anything with a slash. */
  filename?: string | null;
  blobName?: string | null;
  bytes?: number | null;
  hasVideo?: boolean | null;
  sha256?: string | null;
  sourceRef?: Record<string, unknown> | null;
  ofMediaId?: string | null;
}

/** INTERNAL-ONLY — idempotent on `id`, same reason as `createRecording`. */
export async function addRecordingMedia(input: RecordingMediaInsert): Promise<RecordingMediaRow> {
  const rows = await sql<RecordingMediaRow[]>`
    INSERT INTO ${sql(SCHEMA)}.recording_media
      (id, recording_id, kind, ord, offset_ms, duration_ms, filename, blob_name,
       bytes, has_video, sha256, source_ref, of_media_id)
    VALUES (${input.id}::uuid, ${input.recordingId}::uuid, ${input.kind}, ${input.ord ?? 0},
            ${input.offsetMs ?? null}, ${input.durationMs ?? null},
            ${input.filename ?? null}, ${input.blobName ?? null},
            ${input.bytes ?? null}, ${input.hasVideo ?? null}, ${input.sha256 ?? null},
            ${json(input.sourceRef)}, ${input.ofMediaId ?? null}::uuid)
    ON CONFLICT (id) DO UPDATE SET
      kind        = EXCLUDED.kind,
      ord         = EXCLUDED.ord,
      offset_ms   = COALESCE(EXCLUDED.offset_ms, recording_media.offset_ms),
      duration_ms = COALESCE(EXCLUDED.duration_ms, recording_media.duration_ms),
      filename    = COALESCE(EXCLUDED.filename, recording_media.filename),
      blob_name   = COALESCE(EXCLUDED.blob_name, recording_media.blob_name),
      bytes       = COALESCE(EXCLUDED.bytes, recording_media.bytes),
      has_video   = COALESCE(EXCLUDED.has_video, recording_media.has_video),
      sha256      = COALESCE(EXCLUDED.sha256, recording_media.sha256),
      source_ref  = COALESCE(EXCLUDED.source_ref, recording_media.source_ref)
    RETURNING ${mediaCols}
  `;
  return rows[0]!;
}

/** INTERNAL-ONLY — every file of the given recordings, in player order. */
export async function listRecordingMedia(recordingIds: string[]): Promise<RecordingMediaRow[]> {
  if (recordingIds.length === 0) return [];
  return sql<RecordingMediaRow[]>`
    SELECT ${mediaCols} FROM ${sql(SCHEMA)}.recording_media
    WHERE recording_id = ANY(${recordingIds}::uuid[])
    ORDER BY recording_id,
             CASE kind WHEN 'canonical' THEN 0 WHEN 'part' THEN 1 ELSE 2 END,
             ord, created_at
  `;
}

// ---------------------------------------------------------------------------
// Transcriptions
// ---------------------------------------------------------------------------

export interface RecordingTranscriptionInsert {
  id: string;
  recordingId: string;
  provider: TranscriptionProvider;
  providerJobId?: string | null;
  speechModel?: string | null;
  languageCode?: string | null;
  status: TranscriptionStatus;
  payload?: TranscriptResponse | null;
  covers?: TranscriptionCovers | null;
  completedAt?: Date | string | null;
}

/**
 * INTERNAL-ONLY — idempotent on `id`. Note the backfill does NOT go through
 * this function for `payload`: it copies `imported_content` inside SQL so
 * ~0.5 GB of jsonb never round-trips through JS (spec §2.3).
 */
export async function createRecordingTranscription(
  input: RecordingTranscriptionInsert
): Promise<RecordingTranscriptionRow> {
  const rows = await sql<RecordingTranscriptionRow[]>`
    INSERT INTO ${sql(SCHEMA)}.recording_transcriptions
      (id, recording_id, provider, provider_job_id, speech_model, language_code,
       status, payload, covers, completed_at)
    VALUES (${input.id}::uuid, ${input.recordingId}::uuid, ${input.provider},
            ${input.providerJobId ?? null}, ${input.speechModel ?? null},
            ${input.languageCode ?? null}, ${input.status},
            ${json(input.payload)}, ${json(input.covers)},
            ${input.completedAt ?? null})
    ON CONFLICT (id) DO UPDATE SET
      status        = EXCLUDED.status,
      speech_model  = COALESCE(EXCLUDED.speech_model, recording_transcriptions.speech_model),
      language_code = COALESCE(EXCLUDED.language_code, recording_transcriptions.language_code),
      payload       = COALESCE(EXCLUDED.payload, recording_transcriptions.payload),
      covers        = COALESCE(EXCLUDED.covers, recording_transcriptions.covers),
      completed_at  = COALESCE(EXCLUDED.completed_at, recording_transcriptions.completed_at)
    RETURNING *
  `;
  return rows[0]!;
}

/** INTERNAL-ONLY — the poller's status/payload write. */
export async function updateRecordingTranscription(
  id: string,
  patch: {
    status?: TranscriptionStatus;
    payload?: TranscriptResponse | null;
    languageCode?: string | null;
    speechModel?: string | null;
    completedAt?: Date | string | null;
    providerDeletedAt?: Date | string | null;
    supersededBy?: string | null;
  }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.recording_transcriptions SET
      status              = COALESCE(${patch.status ?? null}, status),
      payload             = COALESCE(${json(patch.payload)}, payload),
      language_code       = COALESCE(${patch.languageCode ?? null}, language_code),
      speech_model        = COALESCE(${patch.speechModel ?? null}, speech_model),
      completed_at        = COALESCE(${patch.completedAt ?? null}, completed_at),
      provider_deleted_at = COALESCE(${patch.providerDeletedAt ?? null}, provider_deleted_at),
      superseded_by       = COALESCE(${patch.supersededBy ?? null}::uuid, superseded_by)
    WHERE id = ${id}::uuid
  `;
}

/** INTERNAL-ONLY — the transcriptions of the given recordings, newest first. */
export async function listRecordingTranscriptions(
  recordingIds: string[]
): Promise<RecordingTranscriptionRow[]> {
  if (recordingIds.length === 0) return [];
  return sql<RecordingTranscriptionRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recording_transcriptions
    WHERE recording_id = ANY(${recordingIds}::uuid[])
    ORDER BY recording_id, created_at DESC
  `;
}

/**
 * INTERNAL-ONLY — "have we already stored this AssemblyAI job?". The unique
 * partial index behind it is the double-send guard (design §0: the same
 * podcast billed twice).
 */
export async function getTranscriptionByJobId(
  providerJobId: string
): Promise<RecordingTranscriptionRow | null> {
  const rows = await sql<RecordingTranscriptionRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.recording_transcriptions
    WHERE provider_job_id = ${providerJobId}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export interface MeetingClipInsert {
  transcriptId: number;
  ord?: number;
  recordingId: string;
  transcriptionId?: string | null;
  fromMs?: number;
  toMs?: number | null;
  offsetMs?: number;
  textPolicy?: ClipTextPolicy;
  createdBy?: string | null;
}

/**
 * INTERNAL-ONLY — the caller must already hold edit access to the meeting.
 * Idempotent on `(transcript_id, ord)` so the backfill converges.
 */
export async function addMeetingClip(input: MeetingClipInsert): Promise<MeetingClipRow> {
  const rows = await sql<MeetingClipRow[]>`
    INSERT INTO ${sql(SCHEMA)}.meeting_clips
      (transcript_id, ord, recording_id, transcription_id, from_ms, to_ms,
       offset_ms, text_policy, created_by)
    VALUES (${input.transcriptId}, ${input.ord ?? 0}, ${input.recordingId}::uuid,
            ${input.transcriptionId ?? null}::uuid, ${input.fromMs ?? 0},
            ${input.toMs ?? null}, ${input.offsetMs ?? 0},
            ${input.textPolicy ?? 'include'}, ${input.createdBy ?? null})
    ON CONFLICT (transcript_id, ord) DO UPDATE SET
      recording_id     = EXCLUDED.recording_id,
      transcription_id = EXCLUDED.transcription_id,
      from_ms          = EXCLUDED.from_ms,
      to_ms            = EXCLUDED.to_ms,
      offset_ms        = EXCLUDED.offset_ms,
      text_policy      = EXCLUDED.text_policy
    RETURNING ${clipCols}
  `;
  return rows[0]!;
}

/**
 * INTERNAL-ONLY — gate on the MEETING first (`resolveAccess`), then read its
 * clips. This is reachability route (a).
 */
export async function listClipsForMeeting(transcriptId: number): Promise<MeetingClipRow[]> {
  return sql<MeetingClipRow[]>`
    SELECT ${clipCols} FROM ${sql(SCHEMA)}.meeting_clips
    WHERE transcript_id = ${transcriptId}
    ORDER BY ord
  `;
}

/** INTERNAL-ONLY — same gate, several meetings at once (no N+1 on a listing). */
export async function listClipsForMeetings(transcriptIds: number[]): Promise<MeetingClipRow[]> {
  if (transcriptIds.length === 0) return [];
  return sql<MeetingClipRow[]>`
    SELECT ${clipCols} FROM ${sql(SCHEMA)}.meeting_clips
    WHERE transcript_id = ANY(${transcriptIds})
    ORDER BY transcript_id, ord
  `;
}

/** INTERNAL-ONLY — used by a re-clip; the caller holds edit access. */
export async function deleteMeetingClips(transcriptId: number): Promise<number> {
  const rows = await sql<Array<{ ord: number }>>`
    DELETE FROM ${sql(SCHEMA)}.meeting_clips
    WHERE transcript_id = ${transcriptId}
    RETURNING ord
  `;
  return rows.length;
}

/**
 * INTERNAL-ONLY — "which LIVE meetings still reference this recording?".
 *
 * Permanent delete asks this before removing any bytes: a recording shared by
 * two owners (one AssemblyAI job imported by two people — landmine #14) must
 * survive one of them deleting their meeting. Trashed meetings
 * (`deleted_at`) do not count as live, which matches trash semantics
 * everywhere else: restoring one re-reads the bytes, so the caller should
 * only delete files once the meeting itself is permanently gone.
 */
export async function liveMeetingsForRecording(
  recordingId: string
): Promise<Array<{ transcript_id: number; assemblyai_id: string; user_id: string }>> {
  return sql<Array<{ transcript_id: number; assemblyai_id: string; user_id: string }>>`
    SELECT c.transcript_id, t.assemblyai_id, t.user_id
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
    WHERE c.recording_id = ${recordingId}::uuid
      AND t.deleted_at IS NULL
    ORDER BY c.transcript_id
  `;
}

/**
 * The listing's `recording_count`, as ONE correlated aggregate to drop into
 * the v2 CTE next to the existing jsonb GREATEST — `t` must be the
 * transcripts alias in scope. Caller-scoping is the CTE's own (this only
 * counts rows belonging to a meeting the CTE already decided is visible),
 * and it sits inside the MATERIALIZED fence so it runs once per visible row.
 *
 * It counts CAPTURES, matching today's
 * `GREATEST(1 + #videoParts, #uploadedParts, #combinedParts)`:
 *  - a plain meeting → its canonical file → 1
 *  - Meet stop/restart → canonical + N part rows → 1 + N
 *  - a stitched/combined upload → the canonical IS the concat, a derivative
 *    of the parts, so it is stamped `source_ref.derived` at write time and
 *    excluded → N
 */
export function recordingCountExpr() {
  return sql`
    GREATEST((
      SELECT count(*)
      FROM ${sql(SCHEMA)}.meeting_clips c
      JOIN ${sql(SCHEMA)}.recording_media m ON m.recording_id = c.recording_id
      WHERE c.transcript_id = t.id
        AND (m.kind = 'part'
             OR (m.kind = 'canonical' AND m.source_ref->>'derived' IS NULL))
    ), 1)::int
  `;
}

/**
 * INTERNAL-ONLY — the same count for an explicit set of meetings (darth-cli,
 * the backfill's verification pass). The caller must already have decided
 * those meetings are visible.
 */
export async function recordingCountsForMeetings(
  transcriptIds: number[]
): Promise<Map<number, number>> {
  if (transcriptIds.length === 0) return new Map();
  const rows = await sql<Array<{ transcript_id: number; n: number }>>`
    SELECT c.transcript_id, GREATEST(count(*), 1)::int AS n
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.recording_media m ON m.recording_id = c.recording_id
    WHERE c.transcript_id = ANY(${transcriptIds})
      AND (m.kind = 'part'
           OR (m.kind = 'canonical' AND m.source_ref->>'derived' IS NULL))
    GROUP BY c.transcript_id
  `;
  return new Map(rows.map((r) => [r.transcript_id, r.n]));
}

// ---------------------------------------------------------------------------
// The one loader
// ---------------------------------------------------------------------------

export interface MeetingRecordingGraph {
  clips: MeetingClipRow[];
  recordings: RecordingRow[];
  transcriptions: RecordingTranscriptionRow[];
  media: RecordingMediaRow[];
}

/**
 * INTERNAL-ONLY — everything `resolveMeetingContent` needs for one meeting,
 * in at most four round trips (and zero when the meeting has no clips yet).
 * The caller has already gated on the meeting.
 */
export async function loadMeetingRecordingGraph(
  transcriptId: number
): Promise<MeetingRecordingGraph> {
  const clips = await listClipsForMeeting(transcriptId);
  if (clips.length === 0) {
    return { clips, recordings: [], transcriptions: [], media: [] };
  }
  const recordingIds = [...new Set(clips.map((c) => c.recording_id))];
  const [recordings, transcriptions, media] = await Promise.all([
    sql<RecordingRow[]>`
      SELECT ${recordingCols} FROM ${sql(SCHEMA)}.recordings
      WHERE id = ANY(${recordingIds}::uuid[])
    `,
    listRecordingTranscriptions(recordingIds),
    listRecordingMedia(recordingIds),
  ]);
  return { clips, recordings, transcriptions, media };
}
