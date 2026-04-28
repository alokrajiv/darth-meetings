import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { VocabPayload, CustomSpellingEntry } from '@/lib/format';

/**
 * Organization-wide vocabulary (single row, id=1). Anyone logged into the
 * app can edit it from the UI; every save also appends a snapshot to
 * `org_vocab_history` so the full edit history is queryable from the DB
 * (for restore/audit). The history table is append-only by design.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface OrgVocabRow {
  id: number;
  version: number;
  keyterms_prompt: unknown;
  custom_spelling: CustomSpellingEntry[];
  updated_at: string;
  updated_by: string | null;
}

export interface OrgVocabHistoryRow {
  id: number;
  version: number;
  keyterms_prompt: unknown;
  custom_spelling: CustomSpellingEntry[];
  edited_at: string;
  edited_by: string | null;
  note: string | null;
}

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

export async function getCurrent(): Promise<OrgVocabRow> {
  const rows = await sql<OrgVocabRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.org_vocab WHERE id = 1 LIMIT 1
  `;
  if (rows[0]) return rows[0];
  // Should never happen — migration seeds the row — but be safe.
  const seeded = await sql<OrgVocabRow[]>`
    INSERT INTO ${sql(SCHEMA)}.org_vocab (id, version) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET version = ${sql(SCHEMA)}.org_vocab.version
    RETURNING *
  `;
  return seeded[0]!;
}

/** Read-time helper: current org payload as a clean VocabPayload. */
export async function getCurrentPayload(): Promise<VocabPayload> {
  const row = await getCurrent();
  return {
    keyterms_prompt: normalizeKeyterms(row.keyterms_prompt),
    custom_spelling: (row.custom_spelling as CustomSpellingEntry[]) ?? [],
  };
}

/**
 * Save a new state to org_vocab AND append a snapshot to org_vocab_history.
 * Wrapped in a transaction so the live row and the history can never drift.
 */
export async function saveAndAppendHistory(
  editedBy: string,
  payload: VocabPayload,
  note?: string
): Promise<OrgVocabRow> {
  return await sql.begin(async (tx) => {
    const updated = await tx<OrgVocabRow[]>`
      UPDATE ${sql(SCHEMA)}.org_vocab
      SET version = version + 1,
          keyterms_prompt = ${sql.json(payload.keyterms_prompt as unknown as never)},
          custom_spelling = ${sql.json(payload.custom_spelling as unknown as never)},
          updated_at = now(),
          updated_by = ${editedBy}
      WHERE id = 1
      RETURNING *
    `;
    const row = updated[0]!;

    await tx`
      INSERT INTO ${sql(SCHEMA)}.org_vocab_history (
        version, keyterms_prompt, custom_spelling, edited_by, note
      ) VALUES (
        ${row.version},
        ${sql.json(payload.keyterms_prompt as unknown as never)},
        ${sql.json(payload.custom_spelling as unknown as never)},
        ${editedBy},
        ${note ?? null}
      )
    `;

    return row;
  });
}

export async function listHistory(limit = 50, offset = 0): Promise<OrgVocabHistoryRow[]> {
  const rows = await sql<OrgVocabHistoryRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.org_vocab_history
    ORDER BY version DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}
