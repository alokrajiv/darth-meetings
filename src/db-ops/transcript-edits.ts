import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { TranscriptEditMap } from '@/lib/format';

/**
 * User-scoped CRUD for the per-utterance edit overrides table.
 *
 * Edits are stored as a JSONB map: { "<utteranceIndex>": { text?, speaker? } }.
 * The raw transcript content is NEVER mutated. The "edited" view shown to the
 * user is composed at render time as: raw + speaker_mappings + transcript_edits.
 *
 * Same ACL rule as everywhere else in this codebase: every function takes
 * `userId` as the first arg and every WHERE clause includes `user_id = $1`.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface TranscriptEditsRow {
  id: number;
  user_id: string;
  assemblyai_id: string;
  edits: TranscriptEditMap;
  created_at: string;
  updated_at: string;
}

export async function getForUser(
  userId: string,
  assemblyaiId: string
): Promise<TranscriptEditsRow | null> {
  const rows = await sql<TranscriptEditsRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.transcript_edits
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Replace the entire edit map. Used by the find-and-replace flow which
 * recomputes everything client-side and PUTs the new map in one go.
 */
export async function upsertForUser(
  userId: string,
  assemblyaiId: string,
  edits: TranscriptEditMap
): Promise<TranscriptEditsRow> {
  const rows = await sql<TranscriptEditsRow[]>`
    INSERT INTO ${sql(SCHEMA)}.transcript_edits (
      user_id, assemblyai_id, edits
    ) VALUES (
      ${userId}, ${assemblyaiId}, ${sql.json(edits as unknown as never)}
    )
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET edits = EXCLUDED.edits,
          updated_at = now()
    RETURNING *
  `;
  return rows[0]!;
}

/**
 * Patch a single utterance's override. Reads the current map, merges in the
 * new entry, writes back. Used by inline edit (one utterance at a time).
 */
export async function patchUtteranceForUser(
  userId: string,
  assemblyaiId: string,
  utteranceIndex: number,
  patch: { text?: string; speaker?: string }
): Promise<TranscriptEditsRow> {
  const existing = await getForUser(userId, assemblyaiId);
  const currentEdits = existing?.edits ?? {};
  const key = String(utteranceIndex);
  const currentEntry = currentEdits[key] ?? {};
  const mergedEntry = { ...currentEntry, ...patch };

  // If the patch leaves the entry empty (both undefined), drop the key entirely.
  const next: TranscriptEditMap = { ...currentEdits };
  if (mergedEntry.text === undefined && mergedEntry.speaker === undefined) {
    delete next[key];
  } else {
    next[key] = mergedEntry;
  }

  return upsertForUser(userId, assemblyaiId, next);
}

export async function deleteForUser(
  userId: string,
  assemblyaiId: string
): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    DELETE FROM ${sql(SCHEMA)}.transcript_edits
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING id
  `;
  return rows.length > 0;
}
