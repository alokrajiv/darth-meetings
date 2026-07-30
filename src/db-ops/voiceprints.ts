import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Voiceprints: one 192-dim ECAPA speaker embedding per known person.
 *
 * Deliberately NOT user-scoped — the whole point is recognising the same
 * colleague across every user's meetings, and this is a single-org internal
 * tool. Keyed by normalized display name (`name_key = lower(trim(name))`)
 * to match the free-text customName convention in speaker_mappings.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface VoiceprintRow {
  id: number;
  name: string;
  name_key: string;
  embedding: number[];
  sample_count: number;
  created_at: string;
  updated_at: string;
}

export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

export async function listAll(): Promise<VoiceprintRow[]> {
  return sql<VoiceprintRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.voiceprints
  `;
}

/**
 * Enroll one more sample for a person: incremental rolling average of the
 * stored embedding, re-normalized to unit length so cosine similarity stays
 * a plain dot product. Weighting by sample_count means one noisy meeting
 * can't drag an established voiceprint far.
 */
export async function enrollSample(name: string, embedding: number[]): Promise<void> {
  const key = nameKey(name);
  if (!key) return;

  const existing = await sql<VoiceprintRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.voiceprints WHERE name_key = ${key} LIMIT 1
  `;

  if (existing.length === 0) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.voiceprints (name, name_key, embedding, sample_count)
      VALUES (${name.trim()}, ${key}, ${sql.json(embedding)}, 1)
      ON CONFLICT (name_key) DO NOTHING
    `;
    return;
  }

  const row = existing[0]!;
  const n = row.sample_count;
  const merged = row.embedding.map((v, i) => (v * n + (embedding[i] ?? 0)) / (n + 1));
  const norm = Math.sqrt(merged.reduce((s, v) => s + v * v, 0)) || 1;
  const normalized = merged.map((v) => v / norm);

  await sql`
    UPDATE ${sql(SCHEMA)}.voiceprints
    SET embedding = ${sql.json(normalized)},
        sample_count = sample_count + 1,
        name = ${name.trim()},
        updated_at = now()
    WHERE name_key = ${key}
  `;
}
