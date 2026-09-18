import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { UploadSpec } from '@/lib/server/upload-pipeline';

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export type UploadSessionStatus = 'open' | 'completing' | 'done' | 'failed';
/** How the bytes reach the VM: chunk PUTs through nginx, or the Azure Blob
 * transit (darth uploads, migration 043 — see src/lib/darth-uploads-shared.ts). */
export type UploadSessionVia = 'chunks' | 'blob';

export interface UploadSessionRow {
  id: string;
  user_id: string;
  fingerprint: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  temp_filename: string;
  placeholder_id: string;
  spec: UploadSpec;
  status: UploadSessionStatus;
  error: string | null;
  /** assemblyai_id of the finished transcript once status is 'done'. */
  result_id: string | null;
  via: UploadSessionVia;
  /** Blob sessions only (migration 043). */
  blob_name: string | null;
  sha256: string | null;
  sas_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function coerce(row: UploadSessionRow): UploadSessionRow {
  // postgres.js returns bigint columns as strings.
  return { ...row, size: Number(row.size) };
}

/** The caller's OPEN session for this file, if one exists (resume). */
export async function findOpenUploadSession(
  userId: string,
  fingerprint: string
): Promise<UploadSessionRow | null> {
  const rows = await sql<UploadSessionRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.upload_sessions
    WHERE user_id = ${userId} AND fingerprint = ${fingerprint} AND status = 'open'
    LIMIT 1
  `;
  return rows[0] ? coerce(rows[0]) : null;
}

export async function getUploadSessionForUser(
  userId: string,
  id: string
): Promise<UploadSessionRow | null> {
  const rows = await sql<UploadSessionRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.upload_sessions
    WHERE user_id = ${userId} AND id = ${id}
    LIMIT 1
  `;
  return rows[0] ? coerce(rows[0]) : null;
}

export async function createUploadSession(data: {
  id: string;
  userId: string;
  fingerprint: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  tempFilename: string;
  placeholderId: string;
  spec: UploadSpec;
  /** Blob transit session (migration 043): the blob name, the client's
   * whole-file sha256 and the minted SAS expiry. Absent = chunk session. */
  blob?: { blobName: string; sha256: string; sasExpiresAt: Date } | null;
}): Promise<UploadSessionRow> {
  const rows = await sql<UploadSessionRow[]>`
    INSERT INTO ${sql(SCHEMA)}.upload_sessions (
      id, user_id, fingerprint, size, chunk_size, chunk_count,
      temp_filename, placeholder_id, spec, via, blob_name, sha256, sas_expires_at
    ) VALUES (
      ${data.id}, ${data.userId}, ${data.fingerprint}, ${data.size},
      ${data.chunkSize}, ${data.chunkCount}, ${data.tempFilename},
      ${data.placeholderId}, ${sql.json(data.spec as unknown as never)},
      ${data.blob ? 'blob' : 'chunks'}, ${data.blob?.blobName ?? null},
      ${data.blob?.sha256 ?? null}, ${data.blob?.sasExpiresAt ?? null}
    )
    RETURNING *
  `;
  return coerce(rows[0]!);
}

/** A blob session's SAS was re-minted (resume after expiry): record the new expiry. */
export async function touchUploadSessionSas(id: string, sasExpiresAt: Date): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.upload_sessions
    SET sas_expires_at = ${sasExpiresAt}, updated_at = now()
    WHERE id = ${id}
  `;
}

/** Indices of the chunks the server has fully received and acknowledged. */
export async function listReceivedChunks(sessionId: string): Promise<number[]> {
  const rows = await sql<Array<{ idx: number }>>`
    SELECT idx FROM ${sql(SCHEMA)}.upload_chunks
    WHERE session_id = ${sessionId}
    ORDER BY idx ASC
  `;
  return rows.map((r) => r.idx);
}

/**
 * Acknowledge one chunk (idempotent — a retry racing its own slow original
 * just rewrites the same bytes at the same offset). Returns the session's
 * received-chunk count and byte total after the ack.
 */
export async function ackUploadChunk(
  sessionId: string,
  idx: number,
  bytes: number
): Promise<{ receivedCount: number; receivedBytes: number }> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.upload_chunks (session_id, idx, bytes)
    VALUES (${sessionId}, ${idx}, ${bytes})
    ON CONFLICT (session_id, idx) DO UPDATE SET bytes = EXCLUDED.bytes, received_at = now()
  `;
  const rows = await sql<Array<{ received_count: number; received_bytes: string }>>`
    UPDATE ${sql(SCHEMA)}.upload_sessions s
    SET updated_at = now()
    FROM (
      SELECT count(*)::int AS received_count, COALESCE(sum(bytes), 0)::bigint AS received_bytes
      FROM ${sql(SCHEMA)}.upload_chunks
      WHERE session_id = ${sessionId}
    ) agg
    WHERE s.id = ${sessionId}
    RETURNING agg.received_count, agg.received_bytes
  `;
  const r = rows[0];
  return {
    receivedCount: r?.received_count ?? 0,
    receivedBytes: Number(r?.received_bytes ?? 0),
  };
}

/**
 * Flip open → completing atomically. Returns false when the session is not
 * open (already completing/done/failed), so a duplicate complete request
 * can't run the ingest twice.
 */
export async function claimUploadSessionForComplete(
  userId: string,
  id: string
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE ${sql(SCHEMA)}.upload_sessions
    SET status = 'completing', updated_at = now()
    WHERE user_id = ${userId} AND id = ${id} AND status = 'open'
    RETURNING id
  `;
  return rows.length > 0;
}

export async function setUploadSessionStatus(
  id: string,
  status: UploadSessionStatus,
  error?: string | null,
  resultId?: string | null
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.upload_sessions
    SET status = ${status},
        error = ${error ?? null},
        result_id = COALESCE(${resultId ?? null}, result_id),
        updated_at = now(),
        completed_at = CASE WHEN ${status} IN ('done', 'failed') THEN now() ELSE completed_at END
    WHERE id = ${id}
  `;
}

export async function deleteUploadSession(id: string): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.upload_sessions WHERE id = ${id}`;
}

/** True when an OPEN session points at this placeholder row — the stale
 * sweeper leaves such rows alone for the resume window. */
export async function hasOpenUploadSessionForPlaceholder(
  placeholderId: string
): Promise<boolean> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.upload_sessions
    WHERE placeholder_id = ${placeholderId} AND status = 'open'
  `;
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Sessions to reap: open ones idle past the resume window, completing ones
 * whose handler died (pm2 restart mid-ingest), and old done/failed audit
 * rows. Idle = no chunk acked / no status change for `idleHours`.
 */
export async function listExpiredUploadSessions(
  idleHours: number,
  limit: number
): Promise<UploadSessionRow[]> {
  const rows = await sql<UploadSessionRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.upload_sessions
    WHERE (status IN ('open', 'completing') AND updated_at < now() - make_interval(hours => ${idleHours}))
       OR (status IN ('done', 'failed') AND updated_at < now() - interval '7 days')
    ORDER BY updated_at ASC
    LIMIT ${limit}
  `;
  return rows.map(coerce);
}
