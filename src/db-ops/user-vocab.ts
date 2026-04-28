import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { VocabPayload, CustomSpellingEntry } from '@/lib/format';

/**
 * User-scoped vocabulary (keyterms_prompt + custom_spelling) — one row per
 * user. Used by the transcribe flow to bias AAI recognition toward
 * user-specific terms (names, jargon) and to post-process spellings.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface UserVocabRow {
  user_id: string;
  keyterms_prompt: unknown; // JSONB — may be legacy {word, weight}[] or plain string[]
  custom_spelling: CustomSpellingEntry[];
  updated_at: string;
}

const EMPTY_VOCAB: VocabPayload = { keyterms_prompt: [], custom_spelling: [] };

/**
 * Defensive reader: if a legacy `{word, weight}[]` row ever shows up (e.g.
 * imported from another instance pre-migration), flatten it to a string[].
 * New writes always store a clean string[].
 */
function normalizeKeyterms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'word' in entry && typeof (entry as { word: unknown }).word === 'string') {
        return (entry as { word: string }).word;
      }
      return null;
    })
    .filter((v): v is string => !!v && v.trim().length > 0);
}

export async function getForUser(userId: string): Promise<VocabPayload> {
  const rows = await sql<UserVocabRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.user_vocab WHERE user_id = ${userId} LIMIT 1
  `;
  if (!rows[0]) return { ...EMPTY_VOCAB };
  return {
    keyterms_prompt: normalizeKeyterms(rows[0].keyterms_prompt),
    custom_spelling: (rows[0].custom_spelling as CustomSpellingEntry[]) ?? [],
  };
}

export async function upsertForUser(
  userId: string,
  payload: VocabPayload
): Promise<VocabPayload> {
  const rows = await sql<UserVocabRow[]>`
    INSERT INTO ${sql(SCHEMA)}.user_vocab (user_id, keyterms_prompt, custom_spelling)
    VALUES (
      ${userId},
      ${sql.json(payload.keyterms_prompt as unknown as never)},
      ${sql.json(payload.custom_spelling as unknown as never)}
    )
    ON CONFLICT (user_id) DO UPDATE
      SET keyterms_prompt = EXCLUDED.keyterms_prompt,
          custom_spelling = EXCLUDED.custom_spelling,
          updated_at = now()
    RETURNING *
  `;
  return {
    keyterms_prompt: normalizeKeyterms(rows[0]!.keyterms_prompt),
    custom_spelling: (rows[0]!.custom_spelling as CustomSpellingEntry[]) ?? [],
  };
}
