import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import type { TranscriptShare } from '@/lib/format';

// CRUD for transcript_shares. Everything here assumes the caller has already
// verified that the acting user is allowed to perform the action — ownership
// checks happen in the resolveAccess helper / API routes, not here.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface TranscriptShareRow extends TranscriptShare {
  owner_user_id: string;
  shared_by_user_id: string;
  updated_at: string;
}

export async function listByTranscript(transcriptId: number): Promise<TranscriptShareRow[]> {
  return sql<TranscriptShareRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcript_shares
    WHERE transcript_id = ${transcriptId}
    ORDER BY shared_at ASC
  `;
}

/**
 * List transcript IDs that are shared with this email. Used by the listing
 * query to merge with the user's own rows.
 */
export async function listTranscriptIdsSharedWithEmail(email: string): Promise<number[]> {
  const rows = await sql<{ transcript_id: number }[]>`
    SELECT transcript_id
    FROM ${sql(SCHEMA)}.transcript_shares
    WHERE shared_with_email = ${normEmail(email)}
  `;
  return rows.map((r) => r.transcript_id);
}

/**
 * Does a given share exist? Returns the access level, or null. Used by
 * resolveAccess for the "am I a collaborator on this transcript?" lookup.
 */
export async function getAccessForEmail(
  transcriptId: number,
  email: string
): Promise<'edit' | 'read' | null> {
  const rows = await sql<{ access: 'edit' | 'read' }[]>`
    SELECT access
    FROM ${sql(SCHEMA)}.transcript_shares
    WHERE transcript_id = ${transcriptId}
      AND shared_with_email = ${normEmail(email)}
    LIMIT 1
  `;
  return rows[0]?.access ?? null;
}

export interface AddShareInput {
  transcriptId: number;
  ownerUserId: string;
  sharedByUserId: string;
  sharedWithEmail: string;
  sharedWithName: string | null;
  sharedWithPplId: number | null;
  access: 'edit' | 'read';
}

export async function addShare(input: AddShareInput): Promise<TranscriptShareRow> {
  const rows = await sql<TranscriptShareRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcript_shares (
      transcript_id, owner_user_id, shared_by_user_id,
      shared_with_email, shared_with_name, shared_with_ppl_id, access
    ) VALUES (
      ${input.transcriptId}, ${input.ownerUserId}, ${input.sharedByUserId},
      ${normEmail(input.sharedWithEmail)}, ${input.sharedWithName},
      ${input.sharedWithPplId}, ${input.access}
    )
    ON CONFLICT (transcript_id, shared_with_email) DO UPDATE
      SET access = EXCLUDED.access,
          shared_with_name = COALESCE(EXCLUDED.shared_with_name, ${sql(SCHEMA)}.transcript_shares.shared_with_name),
          shared_with_ppl_id = COALESCE(EXCLUDED.shared_with_ppl_id, ${sql(SCHEMA)}.transcript_shares.shared_with_ppl_id),
          shared_by_user_id = EXCLUDED.shared_by_user_id,
          updated_at = now()
    RETURNING *
  `;
  publishEvent({ kind: 'shares' });
  return rows[0]!;
}

export async function updateAccess(
  transcriptId: number,
  email: string,
  access: 'edit' | 'read'
): Promise<TranscriptShareRow | null> {
  const rows = await sql<TranscriptShareRow[]>`
    UPDATE ${sql(SCHEMA)}.transcript_shares
    SET access = ${access}, updated_at = now()
    WHERE transcript_id = ${transcriptId}
      AND shared_with_email = ${normEmail(email)}
    RETURNING *
  `;
  if (rows[0]) publishEvent({ kind: 'shares' });
  return rows[0] ?? null;
}

export async function removeShare(transcriptId: number, email: string): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    DELETE FROM ${sql(SCHEMA)}.transcript_shares
    WHERE transcript_id = ${transcriptId}
      AND shared_with_email = ${normEmail(email)}
    RETURNING id
  `;
  if (rows.length > 0) publishEvent({ kind: 'shares' });
  return rows.length > 0;
}
