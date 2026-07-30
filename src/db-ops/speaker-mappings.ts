import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';

export type { SpeakerLabel };

/**
 * User-scoped CRUD for speaker_mappings.
 *
 * Same ACL rule as `transcripts`: every function takes `userId` as the first
 * arg and every WHERE clause enforces `user_id = ${userId}`.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface SpeakerMappingRow {
  id: number;
  user_id: string;
  assemblyai_id: string;
  speaker_labels: SpeakerLabel[];
  suggestions: SpeakerSuggestionMap | null;
  created_at: string;
  updated_at: string;
}

export async function getForUser(
  userId: string,
  assemblyaiId: string
): Promise<SpeakerMappingRow | null> {
  const rows = await sql<SpeakerMappingRow[]>`
    SELECT *
    FROM ${sql(SCHEMA)}.speaker_mappings
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function upsertForUser(
  userId: string,
  assemblyaiId: string,
  speakerLabels: SpeakerLabel[]
): Promise<SpeakerMappingRow> {
  const rows = await sql<SpeakerMappingRow[]>`
    INSERT INTO ${sql(SCHEMA)}.speaker_mappings (
      user_id, assemblyai_id, speaker_labels
    ) VALUES (
      ${userId}, ${assemblyaiId}, ${sql.json(speakerLabels as unknown as never)}
    )
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET speaker_labels = EXCLUDED.speaker_labels,
          updated_at = now()
    RETURNING *
  `;
  return rows[0]!;
}

/**
 * Store voiceprint auto-detection results without touching speaker_labels.
 * Called by the post-completion hook, which runs as the owner.
 */
export async function setSuggestionsForUser(
  userId: string,
  assemblyaiId: string,
  suggestions: SpeakerSuggestionMap
): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.speaker_mappings (
      user_id, assemblyai_id, speaker_labels, suggestions
    ) VALUES (
      ${userId}, ${assemblyaiId}, '[]'::jsonb, ${sql.json(suggestions as unknown as never)}
    )
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET suggestions = EXCLUDED.suggestions,
          updated_at = now()
  `;
}

export async function deleteForUser(
  userId: string,
  assemblyaiId: string
): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    DELETE FROM ${sql(SCHEMA)}.speaker_mappings
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    RETURNING id
  `;
  return rows.length > 0;
}
