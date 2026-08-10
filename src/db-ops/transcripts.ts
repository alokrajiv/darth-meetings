import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import type {
  GmeetContext,
  StoredTranscript,
  TranscriptResponse,
  TranscriptListRow,
  TranscriptSegment,
} from '@/lib/format';

export type TranscriptRow = StoredTranscript;

/**
 * User-scoped CRUD for the transcripts table.
 *
 * Every function takes `userId` as its first argument and every WHERE
 * clause enforces `user_id = ${userId}`. Do NOT add a function here that
 * reads or writes transcripts without this constraint — that would break
 * per-user ACL.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface TranscriptInsert {
  assemblyaiId: string;
  originalFilename: string | null;
  status: string;
  languageCode?: string | null;
  title?: string | null;
  audioUrl?: string | null;
  driveFileId?: string | null;
  gmeetContext?: GmeetContext | null;
}

export interface TranscriptStatusUpdate {
  status?: string;
  completedAt?: Date | null;
  duration?: number | null;
  speakerCount?: number | null;
  languageCode?: string | null;
  audioUrl?: string | null;
}

export interface ImportedTranscriptInsert {
  assemblyaiId: string;
  originalFilename: string | null;
  status: string;
  duration: number | null;
  speakerCount: number | null;
  languageCode: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
  audioUrl: string | null;
  importedContent: TranscriptResponse;
  title?: string | null;
  driveFileId?: string | null;
  gmeetContext?: GmeetContext | null;
}

export async function listForUser(userId: string): Promise<TranscriptRow[]> {
  const rows = await sql<TranscriptRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  return rows;
}

/**
 * List every transcript visible to this user — ones they own plus ones
 * shared with their email. Each row carries a computed `access` field.
 *
 * Skinny column set: the full `imported_content` JSONB is NOT selected
 * because it can be tens of MB per row and the listing doesn't render it.
 * Fetch the full payload via /api/transcripts/:id/content on the detail
 * page instead.
 *
 * Owner identity (name/email) is not available here because we only have
 * the owner's SSO user_id, not their email.
 */
export async function listVisibleToUser(
  userId: string,
  email: string
): Promise<TranscriptListRow[]> {
  const normEmail = email.trim().toLowerCase();
  const rows = await sql<
    Array<TranscriptListRow & { __access: 'owner' | 'edit' | 'read' }>
  >`
    SELECT t.id, t.user_id, t.assemblyai_id, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.speaker_count,
           t.language_code, t.title, t.description, t.last_accessed,
           t.source, t.recorded_at, t.auto_notes_status,
           t.upload_bytes_received::float8 AS upload_bytes_received,
           t.upload_bytes_total::float8 AS upload_bytes_total,
           -- Which conferencing product the source meeting ran on (listing
           -- provider glyphs). 'teams' is stamped explicitly; anything with
           -- Meet identity (gmeet- id or a meeting code) is 'gmeet'.
           CASE
             WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
             WHEN t.assemblyai_id LIKE 'gmeet-%'
                  OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
           END AS provider,
           (t.gmeet_context->>'eventId') IS NOT NULL AS has_event,
           sm.series_id, se.title AS series_title,
           CASE
             WHEN t.user_id = ${userId} THEN 'owner'
             ELSE s.access
           END AS "__access"
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    LEFT JOIN ${sql(SCHEMA)}.series_members sm ON sm.transcript_id = t.id
    LEFT JOIN ${sql(SCHEMA)}.series se ON se.id = sm.series_id
    WHERE t.user_id = ${userId} OR s.id IS NOT NULL
    ORDER BY t.created_at DESC
  `;

  return rows.map((r) => {
    const { __access, ...rest } = r;
    return {
      ...rest,
      access: __access,
      owner_email: null,
      owner_name: null,
    };
  });
}

/**
 * Owner-agnostic lookup, for the Meet "join existing import" flow ONLY. The
 * caller has deliberately NOT been granted visibility yet — the join route
 * proves their access against Google (their own token) before anything from
 * this row reaches them.
 */
export async function getAnyByAssemblyaiId(
  assemblyaiId: string
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcripts
    WHERE assemblyai_id = ${assemblyaiId}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getForUser(
  userId: string,
  assemblyaiId: string
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createForUser(
  userId: string,
  data: TranscriptInsert
): Promise<TranscriptRow> {
  const rows = await sql<TranscriptRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcripts (
      user_id, assemblyai_id, original_filename, status, language_code, title, audio_url, source,
      drive_file_id, gmeet_context
    ) VALUES (
      ${userId}, ${data.assemblyaiId}, ${data.originalFilename ?? null},
      ${data.status}, ${data.languageCode ?? null}, ${data.title ?? null},
      ${data.audioUrl ?? null}, 'uploaded',
      ${data.driveFileId ?? null},
      ${data.gmeetContext ? sql.json(data.gmeetContext as unknown as never) : null}
    )
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET original_filename = EXCLUDED.original_filename,
          status = EXCLUDED.status,
          language_code = COALESCE(EXCLUDED.language_code, ${sql(SCHEMA)}.transcripts.language_code),
          title = COALESCE(EXCLUDED.title, ${sql(SCHEMA)}.transcripts.title),
          audio_url = COALESCE(EXCLUDED.audio_url, ${sql(SCHEMA)}.transcripts.audio_url),
          drive_file_id = COALESCE(EXCLUDED.drive_file_id, ${sql(SCHEMA)}.transcripts.drive_file_id),
          gmeet_context = COALESCE(EXCLUDED.gmeet_context, ${sql(SCHEMA)}.transcripts.gmeet_context)
    RETURNING *
  `;
  publishEvent({ kind: 'created', assemblyaiId: data.assemblyaiId });
  return rows[0]!;
}

export interface UploadingPlaceholderInsert {
  /** Synthetic `up-<uuid>` id — rewritten to the real AAI id on promote. */
  placeholderId: string;
  originalFilename: string | null;
  languageCode?: string | null;
  title?: string | null;
  gmeetContext?: GmeetContext | null;
  /** Content-Length of the incoming body; null when the client omitted it. */
  bytesTotal?: number | null;
}

/**
 * Create the row for an upload whose bytes are still arriving. Exists so the
 * upload is visible (to the owner AND anyone auto-shared) from the first
 * byte, not only once AAI accepts the job. `upload_progress_at` starts
 * ticking immediately so the stale-upload sweeper can reap orphans.
 */
export async function createUploadingPlaceholder(
  userId: string,
  data: UploadingPlaceholderInsert
): Promise<TranscriptRow> {
  const rows = await sql<TranscriptRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcripts (
      user_id, assemblyai_id, original_filename, status, language_code, title,
      source, gmeet_context, upload_bytes_received, upload_bytes_total,
      upload_progress_at
    ) VALUES (
      ${userId}, ${data.placeholderId}, ${data.originalFilename ?? null},
      'uploading', ${data.languageCode ?? null}, ${data.title ?? null},
      'uploaded',
      ${data.gmeetContext ? sql.json(data.gmeetContext as unknown as never) : null},
      0, ${data.bytesTotal ?? null}, now()
    )
    RETURNING *
  `;
  publishEvent({ kind: 'created', assemblyaiId: data.placeholderId });
  return rows[0]!;
}

/**
 * Debounced progress write during the byte stream. Called with `bytes` it
 * also notifies listing pages over SSE; called without (the heartbeat used
 * during the AAI re-upload leg, where byte count no longer moves) it only
 * bumps `upload_progress_at` so the sweeper knows the upload is alive.
 */
export async function updateUploadProgress(
  userId: string,
  placeholderId: string,
  bytesReceived?: number
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET upload_bytes_received = COALESCE(${bytesReceived ?? null}, upload_bytes_received),
        upload_progress_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${placeholderId} AND status = 'uploading'
  `;
  if (bytesReceived !== undefined) {
    publishEvent({ kind: 'status', assemblyaiId: placeholderId });
  }
}

/**
 * Swap the placeholder's synthetic id for the real AAI id once the
 * transcription is accepted. Shares survive (they key on the numeric row id).
 * Returns null when the row is gone — e.g. the sweeper reaped it as stale —
 * so the caller can fall back to a fresh insert.
 */
export async function promoteUploadingRow(
  userId: string,
  placeholderId: string,
  data: { assemblyaiId: string; status: string; audioUrl?: string | null }
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET assemblyai_id = ${data.assemblyaiId},
        status = ${data.status},
        audio_url = ${data.audioUrl ?? null}
    WHERE user_id = ${userId} AND assemblyai_id = ${placeholderId} AND status = 'uploading'
    RETURNING *
  `;
  if (rows[0]) publishEvent({ kind: 'status', assemblyaiId: data.assemblyaiId });
  return rows[0] ?? null;
}

/**
 * Uploads whose heartbeat went quiet — closed tab, network drop, or pm2
 * restart mid-stream. Nothing is recoverable (the byte stream is gone), so
 * the sweeper deletes row + temp file.
 */
export async function listStaleUploads(
  stallMinutes: number,
  limit: number
): Promise<Array<{ user_id: string; assemblyai_id: string }>> {
  return sql<Array<{ user_id: string; assemblyai_id: string }>>`
    SELECT user_id, assemblyai_id
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'uploading'
      AND COALESCE(upload_progress_at, created_at) < now() - make_interval(mins => ${stallMinutes})
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

/**
 * Insert an imported transcript with its frozen content. The user_id is the
 * importing user — they own the imported copy. Other users importing the same
 * AAI transcript get their own row (per-user ACL preserved).
 */
export async function createImportedForUser(
  userId: string,
  data: ImportedTranscriptInsert
): Promise<TranscriptRow> {
  const rows = await sql<TranscriptRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcripts (
      user_id, assemblyai_id, original_filename, status,
      created_at, completed_at, duration, speaker_count, language_code,
      audio_url, source, imported_content, title, drive_file_id, gmeet_context
    ) VALUES (
      ${userId}, ${data.assemblyaiId}, ${data.originalFilename ?? null}, ${data.status},
      ${data.createdAt ?? sql`now()`}, ${data.completedAt ?? null},
      ${data.duration ?? null}, ${data.speakerCount ?? null},
      ${data.languageCode ?? null}, ${data.audioUrl ?? null}, 'imported',
      ${sql.json(data.importedContent as unknown as never)},
      ${data.title ?? null},
      ${data.driveFileId ?? null},
      ${data.gmeetContext ? sql.json(data.gmeetContext as unknown as never) : null}
    )
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET status = EXCLUDED.status,
          created_at = COALESCE(EXCLUDED.created_at, ${sql(SCHEMA)}.transcripts.created_at),
          completed_at = COALESCE(EXCLUDED.completed_at, ${sql(SCHEMA)}.transcripts.completed_at),
          duration = COALESCE(EXCLUDED.duration, ${sql(SCHEMA)}.transcripts.duration),
          speaker_count = COALESCE(EXCLUDED.speaker_count, ${sql(SCHEMA)}.transcripts.speaker_count),
          language_code = COALESCE(EXCLUDED.language_code, ${sql(SCHEMA)}.transcripts.language_code),
          audio_url = COALESCE(EXCLUDED.audio_url, ${sql(SCHEMA)}.transcripts.audio_url),
          imported_content = EXCLUDED.imported_content,
          title = COALESCE(EXCLUDED.title, ${sql(SCHEMA)}.transcripts.title),
          drive_file_id = COALESCE(EXCLUDED.drive_file_id, ${sql(SCHEMA)}.transcripts.drive_file_id),
          gmeet_context = COALESCE(EXCLUDED.gmeet_context, ${sql(SCHEMA)}.transcripts.gmeet_context),
          source = 'imported'
    RETURNING *
  `;
  publishEvent({ kind: 'created', assemblyaiId: data.assemblyaiId });
  return rows[0]!;
}

export interface VisibleDupe {
  assemblyai_id: string;
  title: string | null;
  user_id: string;
  created_at: string;
}

/**
 * Dedupe lookup for the Google Meet import: find any transcript visible to
 * this user (owned or shared with their email) that was imported from the
 * same Drive recording. Returns a skinny descriptor for the conflict UI.
 */
export async function findVisibleByDriveFileId(
  userId: string,
  email: string,
  driveFileId: string
): Promise<VisibleDupe | null> {
  const normEmail = email.trim().toLowerCase();
  const rows = await sql<VisibleDupe[]>`
    SELECT t.assemblyai_id, t.title, t.user_id, t.created_at
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    WHERE t.drive_file_id = ${driveFileId}
      AND (t.user_id = ${userId} OR s.id IS NOT NULL)
    ORDER BY (t.user_id = ${userId}) DESC, t.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Same dedupe, keyed by assemblyai_id — used for Meet-transcript-only imports
 * whose synthetic id (`gmeet-<docId>`) is identical for every importer of the
 * same Doc.
 */
export async function findVisibleByAssemblyaiId(
  userId: string,
  email: string,
  assemblyaiId: string
): Promise<VisibleDupe | null> {
  const normEmail = email.trim().toLowerCase();
  const rows = await sql<VisibleDupe[]>`
    SELECT t.assemblyai_id, t.title, t.user_id, t.created_at
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    WHERE t.assemblyai_id = ${assemblyaiId}
      AND (t.user_id = ${userId} OR s.id IS NOT NULL)
    ORDER BY (t.user_id = ${userId}) DESC, t.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Set the local audio path after we've successfully downloaded the bytes
 * during an import. Stored as an absolute path on the server filesystem.
 */
export async function setLocalAudioPathForUser(
  userId: string,
  assemblyaiId: string,
  localAudioPath: string
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET local_audio_path = ${localAudioPath}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

/**
 * Cache the full AAI transcript payload on the row. The `imported_content`
 * column was originally added for the import flow (where the bytes are
 * frozen at import time), but it doubles as a content cache for uploaded
 * transcripts too — AAI content is immutable once `completed`, so once we
 * fetch it once we never need to hit AAI for that row again. This makes the
 * transcript detail page load almost entirely from Postgres.
 */
export async function setCachedContentForUser(
  userId: string,
  assemblyaiId: string,
  content: TranscriptResponse
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET imported_content = ${sql.json(content as unknown as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

/** @deprecated use setCachedContentForUser — kept for the import flow's clarity */
export const setImportedContentForUser = setCachedContentForUser;

/**
 * Sweep candidates for the auto-notes watchdog: completed transcripts whose
 * notes never ran (status NULL, older than the grace window) or whose run is
 * stuck in 'running' — a pm2 restart kills in-flight generations and nothing
 * else ever retries them.
 */
/**
 * Notes runs that died mid-flight (status stuck at 'running' — pm2 restarts
 * kill in-flight generations). Never-ran transcripts are deliberately NOT
 * picked up any more: notes generation is human-gated behind the speaker
 * review step, so only runs a human already triggered get recovered.
 */
export async function listNotesBacklog(
  stuckMinutes: number,
  limit: number
): Promise<Array<{ user_id: string; assemblyai_id: string; auto_notes_status: string | null }>> {
  return sql<Array<{ user_id: string; assemblyai_id: string; auto_notes_status: string | null }>>`
    SELECT user_id, assemblyai_id, auto_notes_status
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'completed'
      AND auto_notes_status = 'running'
      AND auto_notes_at < now() - make_interval(mins => ${stuckMinutes})
    ORDER BY COALESCE(completed_at, created_at) DESC
    LIMIT ${limit}
  `;
}

/**
 * Speaker-ID passes that never ran (upload paths that skip the
 * post-completion hook) or died mid-flight. Only transcripts still awaiting
 * notes are interesting — once notes exist the review moment has passed.
 */
export async function listSpeakerIdBacklog(
  graceMinutes: number,
  stuckMinutes: number,
  limit: number
): Promise<Array<{ user_id: string; assemblyai_id: string; speaker_id_status: string | null }>> {
  return sql<Array<{ user_id: string; assemblyai_id: string; speaker_id_status: string | null }>>`
    SELECT user_id, assemblyai_id, speaker_id_status
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'completed'
      AND auto_notes_status IS NULL
      AND (
        (speaker_id_status IS NULL
          AND COALESCE(completed_at, created_at) < now() - make_interval(mins => ${graceMinutes})
          AND COALESCE(completed_at, created_at) > now() - interval '7 days')
        OR
        (speaker_id_status = 'running'
          AND speaker_id_at < now() - make_interval(mins => ${stuckMinutes}))
      )
    ORDER BY COALESCE(completed_at, created_at) DESC
    LIMIT ${limit}
  `;
}

/**
 * Auto-notes state machine writes. `status` transitions:
 * null -> 'running' -> 'completed' | 'error'. Notes/error are set atomically
 * with the status so the UI never sees a half-written state.
 */
export async function setAutoNotesForUser(
  userId: string,
  assemblyaiId: string,
  update: { status: string; notes?: string | null; error?: string | null }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET auto_notes_status = ${update.status},
        auto_notes = ${update.notes !== undefined ? update.notes : sql`auto_notes`},
        auto_notes_error = ${update.error ?? null},
        auto_notes_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'notes', assemblyaiId });
}

/** Same status-machine contract as setAutoNotesForUser, for the detailed
 * report tier. Reuses the 'notes' live event so open pages refresh. */
export async function setAutoReportForUser(
  userId: string,
  assemblyaiId: string,
  update: { status: string; report?: string | null; error?: string | null }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET auto_report_status = ${update.status},
        auto_report = ${update.report !== undefined ? update.report : sql`auto_report`},
        auto_report_error = ${update.error ?? null},
        auto_report_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'notes', assemblyaiId });
}

/** Same status-machine contract, for the speaker-identification pass. */
export async function setSpeakerIdForUser(
  userId: string,
  assemblyaiId: string,
  update: { status: string; error?: string | null }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET speaker_id_status = ${update.status},
        speaker_id_error = ${update.error ?? null},
        speaker_id_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'notes', assemblyaiId });
}

export async function setAutoSegmentsForUser(
  userId: string,
  assemblyaiId: string,
  segments: TranscriptSegment[]
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET auto_segments = ${sql.json(segments as unknown as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

export async function updateStatusForUser(
  userId: string,
  assemblyaiId: string,
  update: TranscriptStatusUpdate
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET
      status = COALESCE(${update.status ?? null}, status),
      completed_at = COALESCE(${update.completedAt ?? null}, completed_at),
      duration = COALESCE(${update.duration ?? null}, duration),
      speaker_count = COALESCE(${update.speakerCount ?? null}, speaker_count),
      language_code = COALESCE(${update.languageCode ?? null}, language_code),
      audio_url = COALESCE(${update.audioUrl ?? null}, audio_url)
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING *
  `;
  if (rows[0]) publishEvent({ kind: 'status', assemblyaiId });
  return rows[0] ?? null;
}

export async function updateMetaForUser(
  userId: string,
  assemblyaiId: string,
  meta: { title?: string | null; description?: string | null }
): Promise<TranscriptRow | null> {
  const rows = await sql<TranscriptRow[]>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET
      title = COALESCE(${meta.title ?? null}, title),
      description = COALESCE(${meta.description ?? null}, description)
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING *
  `;
  if (rows[0]) publishEvent({ kind: 'meta', assemblyaiId });
  return rows[0] ?? null;
}

/** Set (or clear) when the meeting actually happened. */
export async function setRecordedAtForUser(
  userId: string,
  assemblyaiId: string,
  recordedAt: Date | null
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET recorded_at = ${recordedAt}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

/**
 * Merge calendar-event metadata into gmeet_context (retro-linking an
 * uploaded recording to its real invite). Existing keys not present in the
 * patch are preserved.
 */
export async function mergeGmeetContextForUser(
  userId: string,
  assemblyaiId: string,
  patch: Partial<GmeetContext>,
  opts?: {
    /** Skip the SSE fan-out — for bookkeeping writes (poller heartbeats)
     * that shouldn't make every open page re-fetch. */
    quiet?: boolean;
  }
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = COALESCE(gmeet_context, '{}'::jsonb) || ${sql.json(patch as unknown as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  if (!opts?.quiet) publishEvent({ kind: 'meta', assemblyaiId });
}

/**
 * Rows waiting on Google to finish generating a Meet recording file
 * (gmeet_context.recordingPending.status = 'waiting'). Sequential scan over
 * the jsonb is fine at this table's size; oldest first so long-waiting rows
 * aren't starved by fresh imports.
 */
export async function listRecordingPendingRows(limit: number): Promise<
  Array<{
    id: number;
    user_id: string;
    assemblyai_id: string;
    gmeet_context: GmeetContext;
  }>
> {
  return sql<
    Array<{ id: number; user_id: string; assemblyai_id: string; gmeet_context: GmeetContext }>
  >`
    SELECT id, user_id, assemblyai_id, gmeet_context
    FROM ${sql(SCHEMA)}.transcripts
    WHERE gmeet_context->'recordingPending'->>'status' = 'waiting'
      AND local_audio_path IS NULL
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

/**
 * Rows with a known recording (Meet Drive file or Teams recording id) but no
 * local audio yet — the video-fetch sweeper's work list. Excludes rows still
 * waiting on Google to GENERATE the file (recording-poller's job) and rows
 * the sweeper already gave up on; backoff between attempts is applied by the
 * sweeper in JS. Recent rows first — that's where people are looking.
 */
export async function listVideoFetchCandidates(limit: number): Promise<
  Array<{
    id: number;
    user_id: string;
    assemblyai_id: string;
    gmeet_context: GmeetContext;
  }>
> {
  return sql<
    Array<{ id: number; user_id: string; assemblyai_id: string; gmeet_context: GmeetContext }>
  >`
    SELECT id, user_id, assemblyai_id, gmeet_context
    FROM ${sql(SCHEMA)}.transcripts
    WHERE local_audio_path IS NULL
      AND status = 'completed'
      AND gmeet_context IS NOT NULL
      AND (gmeet_context->>'videoFileId' IS NOT NULL
           OR gmeet_context->'teams'->>'recordingId' IS NOT NULL)
      AND COALESCE(gmeet_context->'recordingPending'->>'status', '') <> 'waiting'
      AND COALESCE(gmeet_context->'videoAutoFetch'->>'status', 'pending') = 'pending'
      AND created_at > now() - interval '30 days'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export async function touchLastAccessedForUser(
  userId: string,
  assemblyaiId: string
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET last_accessed = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
}

export async function deleteForUser(
  userId: string,
  assemblyaiId: string
): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    DELETE FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING id
  `;
  if (rows.length > 0) publishEvent({ kind: 'deleted', assemblyaiId });
  return rows.length > 0;
}
