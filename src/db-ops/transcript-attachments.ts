import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { TranscriptAttachment } from '@/lib/format';

// CRUD for transcript_attachments ("attached context"). ACL is enforced by
// the API routes via resolveAccess — attachments hang off the transcript's
// integer id, and anyone with access to the transcript can read them.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface AttachmentInsert {
  transcriptId: number;
  addedByUserId: string;
  addedByEmail: string | null;
  kind: 'text' | 'file';
  title: string;
  textContent?: string | null;
  filename?: string | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  extractionStatus?: 'ok' | 'none' | 'failed' | null;
}

/** Internal row shape: client type + the storage filename (never sent raw). */
export interface AttachmentRow extends TranscriptAttachment {
  filename: string | null;
}

export async function listByTranscript(transcriptId: number): Promise<AttachmentRow[]> {
  return sql<AttachmentRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcript_attachments
    WHERE transcript_id = ${transcriptId}
    ORDER BY created_at ASC
  `;
}

export async function getById(
  transcriptId: number,
  attachmentId: number
): Promise<AttachmentRow | null> {
  const rows = await sql<AttachmentRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcript_attachments
    WHERE transcript_id = ${transcriptId} AND id = ${attachmentId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function insertAttachment(data: AttachmentInsert): Promise<AttachmentRow> {
  const rows = await sql<AttachmentRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcript_attachments (
      transcript_id, added_by_user_id, added_by_email, kind, title,
      text_content, filename, original_filename, mime_type, size_bytes,
      extraction_status
    ) VALUES (
      ${data.transcriptId}, ${data.addedByUserId}, ${data.addedByEmail},
      ${data.kind}, ${data.title},
      ${data.textContent ?? null}, ${data.filename ?? null},
      ${data.originalFilename ?? null}, ${data.mimeType ?? null},
      ${data.sizeBytes ?? null}, ${data.extractionStatus ?? null}
    )
    RETURNING *
  `;
  return rows[0]!;
}

export async function deleteAttachment(
  transcriptId: number,
  attachmentId: number
): Promise<AttachmentRow | null> {
  const rows = await sql<AttachmentRow[]>`
    DELETE FROM ${sql(SCHEMA)}.transcript_attachments
    WHERE transcript_id = ${transcriptId} AND id = ${attachmentId}
    RETURNING *
  `;
  return rows[0] ?? null;
}
