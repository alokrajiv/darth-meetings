import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { jobIdSql } from '@/db-ops/aai-job-id';
import { transcriptionVersionTablesExist } from '@/db-ops/transcriptions';
import type { TranscriptResponse } from '@/lib/format';
import type { ClipTextPolicy } from '@/lib/recording-clips';
import type { TransactionSql } from 'postgres';
import type { DesiredClip, DesiredGraph, GraphMeetingRow } from '@/lib/recording-graph';

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
 * Callers: the resolver (`lib/server/recordings.ts`, behind MW_RECORDINGS) and
 * the dual-write sync (`lib/server/recording-sync.ts`, behind
 * MW_RECORDINGS_WRITE). With both flags unset nothing here runs.
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

/**
 * INTERNAL-ONLY — the recording's active transcription id, but only when the
 * row it names really exists.
 *
 * Phase 2's input to the dual-write: a meeting that has been re-transcribed
 * reads a version whose id was MINTED, not derived, so a re-derivation must be
 * told which one it is or it would point the recording back at the version the
 * user switched away from and overwrite that version's payload with the
 * current one (lib/recording-graph.ts `GraphTableFacts`). It lives here rather
 * than in db-ops/transcriptions.ts to keep the sync's imports acyclic.
 */
export async function activeTranscriptionIdOf(recordingId: string): Promise<string | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT t.id
    FROM ${sql(SCHEMA)}.recordings r
    JOIN ${sql(SCHEMA)}.recording_transcriptions t ON t.id = r.active_transcription_id
    WHERE r.id = ${recordingId}::uuid
  `;
  return rows[0]?.id ?? null;
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

/** INTERNAL-ONLY — one media row by its (deterministic) id. */
export async function getRecordingMediaRow(id: string): Promise<RecordingMediaRow | null> {
  const rows = await sql<RecordingMediaRow[]>`
    SELECT ${mediaCols} FROM ${sql(SCHEMA)}.recording_media WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
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
 *
 * DISTINCT on the media, not on the join: since Phase 3a a meeting can hold
 * SEVERAL clips of the SAME file (a source that was shrunk has a head clip
 * and a tail clip with a hole between them), and counting join rows made it
 * "Recording · 2 parts" on the listing — one file, one capture, one hole. It
 * also broke the equality the diff gate checks, because the jsonb expression
 * it is compared against still says 1 for such a row.
 */
export function recordingCountExpr() {
  return sql`
    GREATEST((
      SELECT count(DISTINCT m.id)
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
    SELECT c.transcript_id, GREATEST(count(DISTINCT m.id), 1)::int AS n
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

/**
 * INTERNAL-ONLY — the same graph for MANY meetings in four round trips
 * total, not four per meeting. The offline plan asks for up to 200 ids at
 * once; a per-meeting loop there would be the N+1 spec §3 rules out. Ids
 * with no clips are simply absent from the map (the caller falls back to the
 * row's own columns). The caller has already gated on those meetings.
 *
 * Payloads come along for the ride, so this is for callers that need the
 * MEDIA of many meetings — never for a listing that only needs a count
 * (`recordingCountExpr`).
 */
export async function loadMeetingRecordingGraphs(
  transcriptIds: number[]
): Promise<Map<number, MeetingRecordingGraph>> {
  const out = new Map<number, MeetingRecordingGraph>();
  const clips = await listClipsForMeetings(transcriptIds);
  if (clips.length === 0) return out;

  const recordingIds = [...new Set(clips.map((c) => c.recording_id))];
  const [recordings, transcriptions, media] = await Promise.all([
    sql<RecordingRow[]>`
      SELECT ${recordingCols} FROM ${sql(SCHEMA)}.recordings
      WHERE id = ANY(${recordingIds}::uuid[])
    `,
    listRecordingTranscriptions(recordingIds),
    listRecordingMedia(recordingIds),
  ]);

  for (const clip of clips) {
    let graph = out.get(clip.transcript_id);
    if (!graph) {
      graph = { clips: [], recordings: [], transcriptions: [], media: [] };
      out.set(clip.transcript_id, graph);
    }
    graph.clips.push(clip);
  }
  // Each meeting sees only the recordings its own clips point at — the
  // arrays are small (one recording per meeting today) and the resolver
  // filters by recording_id anyway.
  for (const graph of out.values()) {
    const mine = new Set(graph.clips.map((c) => c.recording_id));
    graph.recordings = recordings.filter((r) => mine.has(r.id));
    graph.transcriptions = transcriptions.filter((t) => mine.has(t.recording_id));
    graph.media = media.filter((m) => mine.has(m.recording_id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dual-write (Phase 1 writers) — see lib/server/recording-sync.ts
// ---------------------------------------------------------------------------

/**
 * Every meeting that holds a given `assemblyai_id`, oldest first, with the
 * columns `deriveRecordingGraph` reads and the tray link it needs.
 *
 * Usually one row. Two rows means two people imported the same Meet call
 * (landmine #14) and the earlier one OWNS the recording — which is why this
 * is not scoped to a user: the sync derives the recording from the owner's
 * row whoever triggered it. It is INTERNAL-ONLY and never serves a response;
 * the caller reached it by writing to one of these meetings.
 *
 * The recorder join prefers the reverse link (`transcript_id`) and falls back
 * to the `gmeet_context.recorder` marker, guarded by a uuid-shaped test so a
 * junk marker can never make the cast throw.
 */
export async function loadGraphMeetingRows(assemblyaiId: string): Promise<GraphMeetingRow[]> {
  // The job id comes through `jobIdSql` so this keeps working on a
  // schema where migration 045 has not been applied (it selects a NULL, and
  // `aaiJobIdOf` falls back to a UUID-shaped meeting id, as for any pre-1b row).
  const job = await jobIdSql('t');
  return sql<GraphMeetingRow[]>`
    SELECT t.id, t.user_id, t.assemblyai_id, ${job.column}, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.language_code,
           t.speech_model, t.local_audio_path, t.deleted_at, t.gmeet_context,
           (t.imported_content IS NOT NULL) AS has_content,
           rr.id         AS recorder_recording_id,
           rr.started_at AS recorder_started_at
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN LATERAL (
      SELECT r.id, r.started_at
      FROM ${sql(SCHEMA)}.recorder_recordings r
      WHERE r.transcript_id = t.assemblyai_id
         OR (t.gmeet_context->'recorder'->>'recordingId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             AND r.id::text = t.gmeet_context->'recorder'->>'recordingId')
      ORDER BY (r.transcript_id = t.assemblyai_id) DESC, r.created_at
      LIMIT 1
    ) rr ON true
    WHERE t.assemblyai_id = ${assemblyaiId}
    ORDER BY t.created_at, t.id
  `;
}

export interface ApplyRecordingGraphInput {
  graph: DesiredGraph;
  /** One per meeting that reads this recording — normally just the meeting
   * that was written; two when a shared AssemblyAI job's owner has not been
   * synced yet and the second importer is the one writing. */
  clips: DesiredClip[];
  /** Stamped on a clip this call creates; existing clips keep their author. */
  createdBy?: string | null;
}

export interface ApplyRecordingGraphResult {
  recordingId: string;
  /** Recordings a clip moved OFF and that nothing points at any more — a
   * placeholder promotion (`up-…` → the AssemblyAI id) is the only way to
   * get one. Their rows were deleted, so nothing is orphaned or duplicated. */
  migratedFrom: string[];
  mediaWritten: number;
  staleMediaRemoved: number;
  /** Clip rows dropped because the row no longer declares that `ord` — how an
   * un-split closes the hole it left (Phase 3a). */
  staleClipsRemoved: number;
}

/**
 * INTERNAL-ONLY — write one meeting's desired graph. The caller has already
 * decided the meeting is theirs to write (it just changed the row).
 *
 * ONE transaction, idempotent on the deterministic ids, so running it twice
 * changes nothing and two meetings sharing an AssemblyAI job converge on the
 * same recording. The payload is copied INSIDE Postgres
 * (`INSERT … SELECT imported_content`): ~0.5 GB of jsonb must never
 * round-trip through JS (spec §2.3).
 */
export async function applyRecordingGraph(
  input: ApplyRecordingGraphInput
): Promise<ApplyRecordingGraphResult> {
  const { graph, clips } = input;
  const rec = graph.recording;
  const keepMediaIds = graph.media.map((m) => m.id);
  const migratedFrom: string[] = [];
  let staleMediaRemoved = 0;
  let staleClipsRemoved = 0;
  // Asked before the transaction opens — see the note at its only use below.
  const has046 = await transcriptionVersionTablesExist().catch(() => false);
  // Same reason (a missing table aborts the transaction): the stale-media
  // DELETE below queues the blobs it orphans, and only when 047 is there.
  const has047 = await mediaArchiveTablesExist().catch(() => false);

  await sql.begin(async (tx) => {
    // What these meetings pointed at BEFORE — a promotion changes the answer.
    const priorIds = new Set<string>();
    for (const clip of clips) {
      const prior = await tx<Array<{ recording_id: string }>>`
        SELECT recording_id FROM ${tx(SCHEMA)}.meeting_clips
        WHERE transcript_id = ${clip.transcriptId} AND ord = ${clip.ord}
      `;
      const priorId = prior[0]?.recording_id;
      if (priorId && priorId !== rec.id) priorIds.add(priorId);
    }

    await tx`
      INSERT INTO ${tx(SCHEMA)}.recordings
        (id, owner_user_id, source_kind, started_at, duration_ms, recorder_recording_id)
      VALUES (${rec.id}::uuid, ${rec.ownerUserId}, ${rec.sourceKind},
              ${rec.startedAt}, ${rec.durationMs}, ${rec.recorderRecordingId}::uuid)
      ON CONFLICT (id) DO UPDATE SET
        source_kind           = EXCLUDED.source_kind,
        started_at            = COALESCE(EXCLUDED.started_at, recordings.started_at),
        duration_ms           = COALESCE(EXCLUDED.duration_ms, recordings.duration_ms),
        recorder_recording_id = COALESCE(EXCLUDED.recorder_recording_id,
                                         recordings.recorder_recording_id),
        updated_at            = now()
    `;

    // NOTE (DEC-3 Stage A.5): `blob_name` and `sha256` are deliberately absent
    // from both the column list and the DO UPDATE below, and `recordings`'
    // upsert above omits `sha256` for the same reason. Those three are NOT
    // derived from the `transcripts` row — only `media-archive.ts` writes
    // them, and only after Azure has confirmed the bytes. A sync must never
    // null or overwrite an archive stamp, and `recordings-verify` never judges
    // them as drift.
    for (const m of graph.media) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.recording_media
          (id, recording_id, kind, ord, offset_ms, duration_ms, filename, bytes,
           has_video, source_ref, of_media_id)
        VALUES (${m.id}::uuid, ${rec.id}::uuid, ${m.kind}, ${m.ord},
                ${m.offsetMs}, ${m.durationMs}, ${m.filename}, ${m.bytes},
                ${m.hasVideo}, ${m.sourceRef ? tx.json(m.sourceRef as never) : null},
                ${m.ofMediaId}::uuid)
        ON CONFLICT (id) DO UPDATE SET
          kind        = EXCLUDED.kind,
          ord         = EXCLUDED.ord,
          offset_ms   = COALESCE(EXCLUDED.offset_ms, recording_media.offset_ms),
          duration_ms = COALESCE(EXCLUDED.duration_ms, recording_media.duration_ms),
          filename    = COALESCE(EXCLUDED.filename, recording_media.filename),
          bytes       = COALESCE(EXCLUDED.bytes, recording_media.bytes),
          has_video   = COALESCE(EXCLUDED.has_video, recording_media.has_video),
          source_ref  = COALESCE(EXCLUDED.source_ref, recording_media.source_ref),
          of_media_id = COALESCE(EXCLUDED.of_media_id, recording_media.of_media_id)
      `;
    }

    // Files the row no longer describes. Derivatives are only judged when
    // the caller actually looked at the disk — an unprobed sync must not
    // delete an `audio_only` row it simply did not ask about.
    //
    // DEC-3 Stage A.7: a row that carried a `blob_name` is the ONLY record of
    // that blob's name. Deleting it without saying so stranded the bytes in
    // the container for ever (the Stage A report flagged this path). The name
    // goes into `media_blob_deletes` in the SAME transaction, so either both
    // happen or neither; the sweeper's drain does the actual delete and
    // retries until Azure agrees.
    const stale = await tx<Array<{ id: string; blob_name: string | null }>>`
      DELETE FROM ${tx(SCHEMA)}.recording_media
      WHERE recording_id = ${rec.id}::uuid
        AND NOT (id = ANY(${keepMediaIds}::uuid[]))
        AND (${graph.filesProbed} OR kind IN ('canonical', 'part'))
      RETURNING id, blob_name
    `;
    staleMediaRemoved = stale.length;
    const strandedBlobs = stale.filter((s) => s.blob_name !== null);
    if (has047 && strandedBlobs.length > 0) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.media_blob_deletes
        ${tx(
          strandedBlobs.map((s) => ({
            blob_name: s.blob_name!,
            recording_id: rec.id,
            media_id: s.id,
          })) as unknown as readonly Record<string, unknown>[],
          'blob_name',
          'recording_id',
          'media_id'
        )}
        ON CONFLICT (blob_name) DO NOTHING
      `;
    }

    const t = graph.transcription;
    // `wholeRecording` false = this meeting is CLIPPED and its
    // `imported_content` is the materialised window. Sending NULL makes the
    // `COALESCE(EXCLUDED.payload, …)` below a no-op, so the recording's real
    // transcription survives a re-derivation of a split meeting's graph
    // (docs/recordings-phase3-clips-spec.md "Model").
    await tx`
      INSERT INTO ${tx(SCHEMA)}.recording_transcriptions
        (id, recording_id, provider, provider_job_id, speech_model, language_code,
         status, payload, covers, created_at, completed_at)
      SELECT ${t.id}::uuid, ${rec.id}::uuid, ${t.provider}, ${t.providerJobId},
             ${t.speechModel}, ${t.languageCode}, ${t.status},
             ${graph.wholeRecording ? tx`src.imported_content` : tx`NULL::jsonb`},
             ${tx.json(t.covers as never)},
             src.created_at, src.completed_at
      FROM ${tx(SCHEMA)}.transcripts src
      WHERE src.id = ${graph.payloadFromTranscriptId}
      ON CONFLICT (id) DO UPDATE SET
        status          = EXCLUDED.status,
        provider_job_id = COALESCE(EXCLUDED.provider_job_id,
                                   recording_transcriptions.provider_job_id),
        speech_model    = COALESCE(EXCLUDED.speech_model,
                                   recording_transcriptions.speech_model),
        language_code   = COALESCE(EXCLUDED.language_code,
                                   recording_transcriptions.language_code),
        payload         = COALESCE(EXCLUDED.payload, recording_transcriptions.payload),
        covers          = EXCLUDED.covers,
        completed_at    = COALESCE(EXCLUDED.completed_at,
                                   recording_transcriptions.completed_at)
    `;

    await tx`
      UPDATE ${tx(SCHEMA)}.recordings
      SET active_transcription_id = ${t.id}::uuid, updated_at = now()
      WHERE id = ${rec.id}::uuid
    `;

    for (const clip of clips) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.meeting_clips
          (transcript_id, ord, recording_id, transcription_id, from_ms, to_ms,
           offset_ms, text_policy, created_by)
        VALUES (${clip.transcriptId}, ${clip.ord}, ${clip.recordingId ?? rec.id}::uuid,
                ${clip.transcriptionId}::uuid, ${clip.fromMs}, ${clip.toMs},
                ${clip.offsetMs}, ${clip.textPolicy}, ${input.createdBy ?? null})
        ON CONFLICT (transcript_id, ord) DO UPDATE SET
          recording_id = EXCLUDED.recording_id,
          from_ms      = EXCLUDED.from_ms,
          to_ms        = EXCLUDED.to_ms,
          offset_ms    = EXCLUDED.offset_ms,
          text_policy  = EXCLUDED.text_policy
      `;
    }

    // Clips the row no longer declares. An un-split is the case that needs
    // this: the source goes back from two clips to one, and without the
    // delete the second window would live on and the hole with it. The
    // meeting's own ords are the only ones touched.
    for (const transcriptId of new Set(clips.map((c) => c.transcriptId))) {
      const keep = clips.filter((c) => c.transcriptId === transcriptId).map((c) => c.ord);
      const dropped = await tx<Array<{ ord: number }>>`
        DELETE FROM ${tx(SCHEMA)}.meeting_clips
        WHERE transcript_id = ${transcriptId} AND NOT (ord = ANY(${keep}))
        RETURNING ord
      `;
      staleClipsRemoved += dropped.length;
    }

    // Promotion: a clip has just moved off the placeholder's recording. If
    // nothing else points at it, it exists for no one — drop it whole rather
    // than leave a second recording of the same bytes behind.
    for (const priorId of priorIds) {
      const still = await tx<Array<{ transcript_id: number }>>`
        SELECT transcript_id FROM ${tx(SCHEMA)}.meeting_clips
        WHERE recording_id = ${priorId}::uuid LIMIT 1
      `;
      if (still.length > 0) continue;
      // …unless one of its transcriptions is a VERSION (Phase 2): superseded,
      // annotated, or deliberately requested (which covers a run still in
      // flight). Those are somebody's history and a re-derivation of a
      // meeting's graph must never be what destroys them. The recording stays
      // whole; `recordings-verify` reports it as an orphan rather than this
      // silently eating a version the user can still switch back to.
      //
      // The 046 half of the test is added only when 046 is there: a statement
      // naming a missing column ABORTS the transaction, so it cannot be
      // wrapped in a catch — the probe is asked first, out of band and cached.
      const versioned = has046;
      const protectedTxns = await tx<Array<{ id: string }>>`
        SELECT id FROM ${tx(SCHEMA)}.recording_transcriptions t
        WHERE t.recording_id = ${priorId}::uuid
          AND (t.superseded_by IS NOT NULL
               ${
                 versioned
                   ? tx`OR t.requested IS NOT NULL
                        OR EXISTS (SELECT 1 FROM ${tx(SCHEMA)}.transcription_annotations a
                                    WHERE a.transcription_id = t.id)`
                   : tx``
               })
        LIMIT 1
      `;
      if (protectedTxns.length > 0) {
        console.warn(
          `[recordings] kept recording ${priorId}: it holds a transcription version ` +
            '(superseded / annotated / requested) that a graph re-derivation must not delete'
        );
        continue;
      }
      await tx`DELETE FROM ${tx(SCHEMA)}.recording_transcriptions WHERE recording_id = ${priorId}::uuid`;
      // The promoted-away recording's blobs are orphaned by the same rule as
      // the stale media above: the new recording has a new id, so its blob
      // names are new too and nothing points at these any more.
      const priorMedia = await tx<Array<{ id: string; blob_name: string | null }>>`
        DELETE FROM ${tx(SCHEMA)}.recording_media WHERE recording_id = ${priorId}::uuid
        RETURNING id, blob_name
      `;
      const priorBlobs = priorMedia.filter((m) => m.blob_name !== null);
      if (has047 && priorBlobs.length > 0) {
        await tx`
          INSERT INTO ${tx(SCHEMA)}.media_blob_deletes
          ${tx(
            priorBlobs.map((m) => ({
              blob_name: m.blob_name!,
              recording_id: priorId,
              media_id: m.id,
            })) as unknown as readonly Record<string, unknown>[],
            'blob_name',
            'recording_id',
            'media_id'
          )}
          ON CONFLICT (blob_name) DO NOTHING
        `;
      }
      await tx`DELETE FROM ${tx(SCHEMA)}.recordings WHERE id = ${priorId}::uuid`;
      migratedFrom.push(priorId);
    }
  });

  return {
    recordingId: rec.id,
    migratedFrom,
    mediaWritten: graph.media.length,
    staleMediaRemoved,
    staleClipsRemoved,
  };
}

export interface SiblingMeetingRow {
  transcript_id: number;
  assemblyai_id: string;
  title: string | null;
  from_ms: number;
  to_ms: number | null;
  duration: number | null;
  trashed: boolean;
  split_from: string | null;
}

/**
 * CALLER-SCOPED — the other meetings on these recordings that THIS caller can
 * open ("also from this recording: …").
 *
 * The scoping is the whole point and the reason this is not a plain join on
 * `meeting_clips`: a recording has no ACL, so the only thing that may decide
 * whether a sibling is mentioned is whether the caller could open it as a
 * MEETING (owner, or a share on their lower-cased email — the same predicate
 * `resolveAccess` and the listing use). A sibling's id, its title, its window
 * and even the fact that a count is non-zero are all leaks: a person shared
 * only the split-off half must not be able to tell that the longer meeting it
 * came from exists (spec §API, feedback_privacy_caller_scoping_gate).
 *
 * Trashed meetings ARE returned, flagged: they still hold their clip, they
 * still keep the bytes alive, and the caller may want to restore one.
 */
export async function listSiblingMeetingsForRecordings(
  recordingIds: string[],
  excludeTranscriptId: number,
  caller: { userId: string; email: string }
): Promise<SiblingMeetingRow[]> {
  if (recordingIds.length === 0) return [];
  const normEmail = caller.email.trim().toLowerCase();
  return sql<SiblingMeetingRow[]>`
    SELECT DISTINCT ON (t.id)
           t.id   AS transcript_id,
           t.assemblyai_id,
           t.title,
           c.from_ms::float8 AS from_ms,
           c.to_ms::float8   AS to_ms,
           t.duration,
           (t.deleted_at IS NOT NULL) AS trashed,
           t.gmeet_context->'splitFrom'->>'meetingId' AS split_from
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id AND s.shared_with_email = ${normEmail}
    WHERE c.recording_id = ANY(${recordingIds}::uuid[])
      AND c.transcript_id <> ${excludeTranscriptId}
      AND (t.user_id = ${caller.userId} OR s.id IS NOT NULL)
    ORDER BY t.id, c.ord
  `;
}

/**
 * INTERNAL-ONLY — write ONLY a meeting's clips, over a recording it does not
 * own (Phase 3a: the meeting that was split off another one).
 *
 * A borrower has its own row, its own `local_audio_path` (the source's
 * canonical filename, so it plays) and its own materialised text — but no
 * recording, no media and no transcription of its own. Running the full
 * `applyRecordingGraph` for it would mint a SECOND recording over the same
 * bytes; running nothing at all would let a healed sync point it back at the
 * whole file. So: exactly the clips, plus the same stale-ord delete.
 *
 * The caller has already decided the meeting is theirs to write (it just
 * changed the row) and has checked that the recording exists.
 */
export async function applyMeetingClips(
  transcriptId: number,
  clips: DesiredClip[],
  createdBy?: string | null
): Promise<{ written: number; staleClipsRemoved: number }> {
  let staleClipsRemoved = 0;
  await sql.begin(async (tx) => {
    for (const clip of clips) {
      if (!clip.recordingId) throw new Error('applyMeetingClips needs an explicit recordingId');
      await tx`
        INSERT INTO ${tx(SCHEMA)}.meeting_clips
          (transcript_id, ord, recording_id, transcription_id, from_ms, to_ms,
           offset_ms, text_policy, created_by)
        VALUES (${transcriptId}, ${clip.ord}, ${clip.recordingId}::uuid,
                ${clip.transcriptionId}::uuid, ${clip.fromMs}, ${clip.toMs},
                ${clip.offsetMs}, ${clip.textPolicy}, ${createdBy ?? null})
        ON CONFLICT (transcript_id, ord) DO UPDATE SET
          recording_id = EXCLUDED.recording_id,
          from_ms      = EXCLUDED.from_ms,
          to_ms        = EXCLUDED.to_ms,
          offset_ms    = EXCLUDED.offset_ms,
          text_policy  = EXCLUDED.text_policy
      `;
    }
    const keep = clips.map((c) => c.ord);
    const dropped = await tx<Array<{ ord: number }>>`
      DELETE FROM ${tx(SCHEMA)}.meeting_clips
      WHERE transcript_id = ${transcriptId} AND NOT (ord = ANY(${keep}))
      RETURNING ord
    `;
    staleClipsRemoved = dropped.length;
  });
  return { written: clips.length, staleClipsRemoved };
}

/** INTERNAL-ONLY — does this recording row exist (and is it live)? */
export async function recordingExists(recordingId: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM ${sql(SCHEMA)}.recordings WHERE id = ${recordingId}::uuid
  `;
  return rows.length > 0;
}

export interface RemoveMeetingGraphResult {
  clipsRemoved: number;
  /** Recordings that lost their last clip and were deleted with their rows. */
  recordingsRemoved: string[];
  /** Recordings kept because another meeting still clips them — the shared
   * AssemblyAI job (landmine #14). Their bytes must survive too. */
  recordingsKept: string[];
}

/**
 * INTERNAL-ONLY — the meeting is being permanently deleted; take its clips
 * with it. A recording's own rows go only when NO clip of any meeting is
 * left on it (a trashed meeting still counts: restoring it must find its
 * recording). Files are NOT touched here — Phase 1 leaves the existing
 * delete-by-filename walk in `[id]/route.ts` exactly as it is.
 */
export async function removeMeetingFromRecordingGraph(
  transcriptId: number
): Promise<RemoveMeetingGraphResult> {
  const removed: string[] = [];
  const kept: string[] = [];
  let clipsRemoved = 0;

  await sql.begin(async (tx) => {
    const gone = await tx<Array<{ recording_id: string }>>`
      DELETE FROM ${tx(SCHEMA)}.meeting_clips
      WHERE transcript_id = ${transcriptId}
      RETURNING recording_id
    `;
    clipsRemoved = gone.length;
    for (const recordingId of new Set(gone.map((g) => g.recording_id))) {
      const still = await tx<Array<{ transcript_id: number }>>`
        SELECT transcript_id FROM ${tx(SCHEMA)}.meeting_clips
        WHERE recording_id = ${recordingId}::uuid LIMIT 1
      `;
      if (still.length > 0) {
        kept.push(recordingId);
        continue;
      }
      await tx`DELETE FROM ${tx(SCHEMA)}.recording_transcriptions WHERE recording_id = ${recordingId}::uuid`;
      await tx`DELETE FROM ${tx(SCHEMA)}.recording_media WHERE recording_id = ${recordingId}::uuid`;
      await tx`DELETE FROM ${tx(SCHEMA)}.recordings WHERE id = ${recordingId}::uuid`;
      removed.push(recordingId);
    }
  });

  return { clipsRemoved, recordingsRemoved: removed, recordingsKept: kept };
}

/**
 * INTERNAL-ONLY — the A5 derivative sweep removed these files from disk, so
 * their rows go too. Only rebuildable kinds are ever matched: a canonical or
 * a part is the recording itself and never disappears behind our back.
 *
 * DEC-3 Stage A.7: an archived derivative's `blob_name` dies with its row, so
 * the name is queued for deletion first (the Stage A report flagged this path
 * as one that could strand a blob). One transaction: the row and the queue
 * entry are written together, and the sweeper's drain does the delete.
 */
export async function dropDerivativeMediaByFilename(filenames: string[]): Promise<number> {
  if (filenames.length === 0) return 0;
  const has047 = await mediaArchiveTablesExist().catch(() => false);
  let removed = 0;
  await sql.begin(async (tx) => {
    const rows = await tx<Array<{ id: string; recording_id: string; blob_name: string | null }>>`
      DELETE FROM ${tx(SCHEMA)}.recording_media
      WHERE kind IN ('audio_only', 'faststart')
        AND filename = ANY(${filenames})
      RETURNING id, recording_id, blob_name
    `;
    removed = rows.length;
    const stranded = rows.filter((r) => r.blob_name !== null);
    if (has047 && stranded.length > 0) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.media_blob_deletes
        ${tx(
          stranded.map((r) => ({
            blob_name: r.blob_name!,
            recording_id: r.recording_id,
            media_id: r.id,
          })) as unknown as readonly Record<string, unknown>[],
          'blob_name',
          'recording_id',
          'media_id'
        )}
        ON CONFLICT (blob_name) DO NOTHING
      `;
    }
  });
  return removed;
}

/**
 * INTERNAL-ONLY — DEC-4: we deleted the job at AssemblyAI. The stamp mirrors
 * `gmeet_context.aai` and is keyed on the job id, so the one transcription
 * behind however many meetings held that id is stamped once.
 */
export async function stampTranscriptionProviderDeleted(
  providerJobId: string,
  deletedAt: Date | string
): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recording_transcriptions
    SET provider_deleted_at = COALESCE(provider_deleted_at, ${deletedAt})
    WHERE provider_job_id = ${providerJobId}
    RETURNING id
  `;
  return rows.length;
}

export interface RecordingOwnershipMove {
  moved: string[];
  /** Left with the old owner because another LIVE meeting also clips them. */
  shared: string[];
}

/**
 * INTERNAL-ONLY — ownership of a meeting moved (landmine #1). Its recordings
 * follow, but only the ones no other live meeting holds a clip on: a shared
 * recording (one AssemblyAI job, two importers) belongs to whoever imported
 * it first and a transfer of one of the two meetings must not take it away
 * from the other.
 *
 * Takes the caller's transaction so the move commits with the rest of the
 * transfer — a half-transferred meeting is exactly what that transaction
 * exists to prevent.
 */
export async function moveRecordingOwnershipForMeeting(
  tx: TransactionSql,
  transcriptId: number,
  fromUserId: string,
  toUserId: string
): Promise<RecordingOwnershipMove> {
  const mine = await tx<Array<{ recording_id: string; shared: boolean }>>`
    SELECT c.recording_id,
           EXISTS (
             SELECT 1
             FROM ${tx(SCHEMA)}.meeting_clips c2
             JOIN ${tx(SCHEMA)}.transcripts t2 ON t2.id = c2.transcript_id
             WHERE c2.recording_id = c.recording_id
               AND c2.transcript_id <> ${transcriptId}
               AND t2.deleted_at IS NULL
           ) AS shared
    FROM ${tx(SCHEMA)}.meeting_clips c
    WHERE c.transcript_id = ${transcriptId}
    GROUP BY c.recording_id
  `;
  const movable = mine.filter((r) => !r.shared).map((r) => r.recording_id);
  const shared = mine.filter((r) => r.shared).map((r) => r.recording_id);
  if (movable.length === 0) return { moved: [], shared };
  const moved = await tx<Array<{ id: string }>>`
    UPDATE ${tx(SCHEMA)}.recordings
    SET owner_user_id = ${toUserId}, updated_at = now()
    WHERE id = ANY(${movable}::uuid[]) AND owner_user_id = ${fromUserId}
    RETURNING id
  `;
  return { moved: moved.map((r) => r.id), shared };
}

// ---------------------------------------------------------------------------
// The media archive (Stage A) — docs/recordings-blob-spec.md
//
// APPEND-ONLY section. `blob_name` / `sha256` / `bytes` on `recording_media`
// are NOT derived from the `transcripts` row: only the archive writes them,
// only after it has re-read the blob and agreed with it, and no sync ever
// clears them (`applyRecordingGraph` does not name those columns — see the
// comment on its media upsert). Migration 047 adds the two bookkeeping
// tables used below.
// ---------------------------------------------------------------------------

// Migration 047's tables, probed once per process. `applyRecordingGraph` and
// `dropDerivativeMediaByFilename` name `media_blob_deletes` on a path that must
// keep working on a server deployed AHEAD of the migration — and a statement
// naming a missing table ABORTS the whole transaction, so it cannot be wrapped
// in a catch. A FAILED probe is not cached (a DB hiccup must not disable the
// queue for the life of the process).
const gRecordings = globalThis as unknown as { __mwMediaArchiveTables?: Promise<boolean> };

export function mediaArchiveTablesExist(): Promise<boolean> {
  return (gRecordings.__mwMediaArchiveTables ??= (async () => {
    const rows = await sql<Array<{ tables: number }>>`
      SELECT count(*)::int AS tables FROM information_schema.tables
      WHERE table_schema = ${SCHEMA}
        AND table_name IN ('media_blob_deletes', 'media_archive_canaries')
    `;
    const present = (rows[0]?.tables ?? 0) === 2;
    if (!present) {
      console.warn(
        '[recordings] migrations/047 not applied — a deleted media row cannot queue its blob ' +
          'for deletion (docs/recordings-blob-spec.md Stage A.7)'
      );
    }
    return present;
  })().catch((err) => {
    gRecordings.__mwMediaArchiveTables = undefined;
    throw err;
  }));
}

/** Tests / the integration check: forget the cached 047 probe. */
export function resetMediaArchiveTablesProbe(): void {
  gRecordings.__mwMediaArchiveTables = undefined;
}

/**
 * INTERNAL-ONLY — the backfill queue: files we hold locally that have no blob
 * yet, oldest capture first. A soft-deleted recording is skipped: its bytes
 * are on their way out, and the pacing budget belongs to live media.
 */
export async function listMediaToArchive(limit: number): Promise<RecordingMediaRow[]> {
  return sql<RecordingMediaRow[]>`
    SELECT ${mediaCols} FROM ${sql(SCHEMA)}.recording_media m
    WHERE m.filename IS NOT NULL
      AND m.blob_name IS NULL
      AND EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.recordings r
        WHERE r.id = m.recording_id AND r.deleted_at IS NULL
      )
    ORDER BY m.created_at, m.id
    LIMIT ${limit}
  `;
}

/**
 * INTERNAL-ONLY — the archive's ONE write, made only after the blob has been
 * re-read and matched on size + stored hash (spec Stage A.1: verify, then
 * stamp). `blob_name` is set unconditionally because a re-archive to the same
 * deterministic name is the same bytes; `bytes` and `sha256` come from the
 * verified upload. Returns false when the row vanished meanwhile.
 */
export async function stampMediaArchived(
  id: string,
  p: { blobName: string; sha256: string; bytes: number }
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recording_media
    SET blob_name = ${p.blobName}, sha256 = ${p.sha256}, bytes = ${p.bytes}
    WHERE id = ${id}::uuid
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * INTERNAL-ONLY — forget that a media row is archived, so the next
 * `archiveMedia` copies the file again (DEC-3 Stage C).
 *
 * ONE caller: the Stage C local-copy job, when the faststart remux has
 * rewritten the file in place and the bytes on disk are therefore no longer
 * the bytes in the blob. The blob is replaced under the SAME deterministic
 * name, so nothing is orphaned — which is also why this refuses unless the row
 * still carries the name the archive would choose (`expectBlobName`): a row
 * whose blob lives somewhere else would leak that blob.
 */
export async function clearMediaArchiveStamp(
  id: string,
  expectBlobName: string
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recording_media
    SET blob_name = NULL, sha256 = NULL
    WHERE id = ${id}::uuid AND blob_name = ${expectBlobName}
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * INTERNAL-ONLY — spec Stage A.6, RECONCILED with the same-file check
 * (docs/recordings-same-file-spec.md): the archive may only FILL `sha256`,
 * never change it.
 *
 * The two writers disagree by nature. The upload pipeline stamps the hash of
 * the bytes the USER handed us — the thing the duplicate check has to match,
 * because it is the only hash the user's own file can reproduce. The archive
 * hashes the file as it is ON DISK at archive time, which for a video is the
 * FASTSTART-REMUXED copy (`prepareMediaForPlayback` rewrites the file in
 * place), and for a stitched group is an ffmpeg concat of the parts. Letting
 * the archive overwrite would therefore silently break de-duplication for
 * every video the moment it was archived.
 *
 * So: the per-file, Azure-verified hash lives on `recording_media.sha256`
 * (`stampMediaArchived`), and this only fills the gap for recordings that
 * never declared an upload hash — backfilled rows, Meet/Teams imports. The
 * authoritative write is `setRecordingUploadSha256`.
 */
export async function setRecordingSha256(recordingId: string, sha256: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET sha256 = ${sha256}, updated_at = now()
    WHERE id = ${recordingId}::uuid AND sha256 IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * INTERNAL-ONLY — the upload pipeline's stamp: the identity of the bytes the
 * user uploaded (the file's own sha256, or a group's combined hash). This one
 * DOES overwrite, because it is the authority — see `setRecordingSha256`
 * above for why the archive's value must not win.
 */
export async function setRecordingUploadSha256(
  recordingId: string,
  sha256: string
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recordings
    SET sha256 = ${sha256}, updated_at = now()
    WHERE id = ${recordingId}::uuid AND sha256 IS DISTINCT FROM ${sha256}
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * INTERNAL-ONLY — a PART's own sha256, as the client declared it and the
 * upload verified it. Only `kind = 'part'` rows: a canonical's hash belongs to
 * the archive (it is a claim about bytes Azure holds), a part row of a
 * stitched group has no file left at all, so this is the only record of what
 * went into the group's combined hash.
 */
export async function setPartMediaSha256(mediaId: string, sha256: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.recording_media
    SET sha256 = ${sha256}
    WHERE id = ${mediaId}::uuid AND kind = 'part' AND sha256 IS DISTINCT FROM ${sha256}
    RETURNING id
  `;
  return rows.length > 0;
}

export interface ArchivedBlobRef {
  recording_id: string;
  media_id: string;
  blob_name: string;
}

/**
 * INTERNAL-ONLY — every archived blob of the given recordings. Read BEFORE
 * the rows are deleted (permanent delete): once they are gone nothing knows
 * the blob names any more.
 */
export async function listMediaBlobsForRecordings(
  recordingIds: string[]
): Promise<ArchivedBlobRef[]> {
  if (recordingIds.length === 0) return [];
  return sql<ArchivedBlobRef[]>`
    SELECT recording_id, id AS media_id, blob_name
    FROM ${sql(SCHEMA)}.recording_media
    WHERE recording_id = ANY(${recordingIds}::uuid[])
      AND blob_name IS NOT NULL
  `;
}

/**
 * INTERNAL-ONLY — queue blobs whose media row has just been destroyed. The
 * sweeper drains this; a delete that fails is retried rather than lost, which
 * is the whole reason the queue exists (migration 047).
 */
export async function queueBlobDeletes(refs: ArchivedBlobRef[]): Promise<number> {
  if (refs.length === 0) return 0;
  const rows = await sql<Array<{ blob_name: string }>>`
    INSERT INTO ${sql(SCHEMA)}.media_blob_deletes
      ${sql(refs as unknown as readonly Record<string, unknown>[], 'blob_name', 'recording_id', 'media_id')}
    ON CONFLICT (blob_name) DO NOTHING
    RETURNING blob_name
  `;
  return rows.length;
}

export interface PendingBlobDeleteRow {
  blob_name: string;
  recording_id: string | null;
  media_id: string | null;
  queued_at: string;
  attempts: number;
  last_error: string | null;
}

/** INTERNAL-ONLY — the sweeper's drain list, oldest first, retries last. */
export async function listPendingBlobDeletes(limit: number): Promise<PendingBlobDeleteRow[]> {
  return sql<PendingBlobDeleteRow[]>`
    SELECT blob_name, recording_id, media_id, queued_at, attempts, last_error
    FROM ${sql(SCHEMA)}.media_blob_deletes
    WHERE last_attempt_at IS NULL OR last_attempt_at < now() - interval '15 minutes'
    ORDER BY attempts, queued_at
    LIMIT ${limit}
  `;
}

/** INTERNAL-ONLY — the blob is gone (or was never there); forget it. */
export async function clearPendingBlobDelete(blobName: string): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.media_blob_deletes WHERE blob_name = ${blobName}`;
}

/** INTERNAL-ONLY — the delete failed; leave it queued with the reason. */
export async function markPendingBlobDeleteFailed(blobName: string, error: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.media_blob_deletes
    SET attempts = attempts + 1, last_attempt_at = now(), last_error = ${error.slice(0, 300)}
    WHERE blob_name = ${blobName}
  `;
}

export interface MediaCanaryRow {
  name: string;
  written_at: string;
  last_ok_at: string | null;
  missing_at: string | null;
}

/** INTERNAL-ONLY — every canary, oldest first (spec Stage A.4). */
export async function listMediaCanaries(): Promise<MediaCanaryRow[]> {
  return sql<MediaCanaryRow[]>`
    SELECT name, written_at, last_ok_at, missing_at
    FROM ${sql(SCHEMA)}.media_archive_canaries
    ORDER BY written_at
  `;
}

/** INTERNAL-ONLY — record a canary we have just written to the container. */
export async function insertMediaCanary(name: string): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.media_archive_canaries (name, last_ok_at)
    VALUES (${name}, now())
    ON CONFLICT (name) DO NOTHING
  `;
}

/** INTERNAL-ONLY — the canary blob is still there. */
export async function markMediaCanarySeen(name: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.media_archive_canaries
    SET last_ok_at = now(), missing_at = NULL
    WHERE name = ${name}
  `;
}

/**
 * INTERNAL-ONLY — the canary blob has been eaten. While any row carries
 * `missing_at` the archive refuses to write anything (spec Stage A.4): a
 * lifecycle rule that deletes a blob we never touched would delete the
 * recordings too.
 */
export async function markMediaCanaryMissing(name: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.media_archive_canaries
    SET missing_at = COALESCE(missing_at, now())
    WHERE name = ${name}
  `;
}
