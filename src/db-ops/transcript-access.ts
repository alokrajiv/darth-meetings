import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { StoredTranscript, TranscriptAccess } from '@/lib/format';

// Canonical access resolver. Every API route that deals with a single
// transcript (detail, edits, speakers, content, audio, shares) should call
// `resolveAccess` instead of running its own ownership check. That way the
// sharing rules live in exactly one place.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface ResolvedAccess {
  row: StoredTranscript;
  access: TranscriptAccess;
  /** Always the *owner's* user_id, used when writing to edits/speakers so
   *  collaborators mutate the owner's row (last-write-wins collab). */
  ownerUserId: string;
}

/**
 * Look up a transcript by its AssemblyAI id and figure out what access the
 * given user has to it. Returns `null` if the transcript doesn't exist or if
 * the caller is neither the owner nor a shared collaborator.
 */
export async function resolveAccess(
  userId: string,
  email: string,
  assemblyaiId: string
): Promise<ResolvedAccess | null> {
  const normEmail = email.trim().toLowerCase();

  // Single query: find the transcript by assemblyai_id and, if the caller is
  // the owner OR has a share, return the row + their access level. We look
  // up by assemblyai_id globally (not scoped to user_id) because collaborators
  // don't own the row — the UNIQUE(user_id, assemblyai_id) constraint means
  // there could be multiple owner rows for the same AAI id across users, but
  // a caller can only have access to one of them (their own, or the one they
  // were shared on).
  const rows = await sql<
    Array<StoredTranscript & { __access: TranscriptAccess }>
  >`
    SELECT t.*,
           CASE
             WHEN t.user_id = ${userId} THEN 'owner'
             ELSE s.access
           END AS "__access"
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id
      AND s.shared_with_email = ${normEmail}
    WHERE t.assemblyai_id = ${assemblyaiId}
      AND (t.user_id = ${userId} OR s.id IS NOT NULL)
    ORDER BY (t.user_id = ${userId}) DESC
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  const { __access, ...stored } = row;
  return {
    row: stored as StoredTranscript,
    access: __access,
    ownerUserId: row.user_id,
  };
}
