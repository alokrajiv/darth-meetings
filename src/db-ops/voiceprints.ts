import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { personNameKey } from '@/lib/person-identity';
import {
  cleanDisplayName,
  preferDisplayName,
  sampleWeight,
  storedWeight,
  weightedMerge,
} from '@/lib/voiceprint-math';

/**
 * Voiceprints: one 192-dim ECAPA speaker embedding per known person.
 *
 * Deliberately NOT user-scoped — the whole point is recognising the same
 * colleague across every user's meetings, and this is a single-org internal
 * tool. Keyed by `name_key = personNameKey(name)` (lib/person-identity.ts:
 * case, dots/underscores/hyphens and invisible characters folded), so
 * "karnica.katiyar" and "Karnica Katiyar" enrol into ONE row.
 *
 * Transition (migration 050, 2026-09-24): rows enrolled before then carry the
 * old key (`lower(trim(name))`), so two rows can still share a
 * personNameKey until scripts/rebuild-voiceprints.ts --apply folds them. The
 * matcher tolerates that (the pair is `samePerson`, so the margin guard never
 * pits them against each other) and enrolment lands on the existing row.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface VoiceprintRow {
  id: number;
  name: string;
  name_key: string;
  embedding: number[];
  sample_count: number;
  /** Seconds of speech behind the stored mean (capped per sample); 0 = legacy row. */
  weight_secs: number;
  created_at: string;
  updated_at: string;
}

export const nameKey = personNameKey;

export async function listAll(): Promise<VoiceprintRow[]> {
  return sql<VoiceprintRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.voiceprints ORDER BY id
  `;
}

/**
 * Enroll one more sample for a person: a DURATION-weighted running mean of
 * the stored embedding, re-normalised to unit length so cosine similarity
 * stays a plain dot product. The stored mean weighs `weight_secs` (its
 * sample count on a legacy row), the new sample its `seconds` capped at
 * 180 s — a meeting where someone talked for minutes moves the print more
 * than one where they said "ok" twice, but no single monologue owns it.
 */
export async function enrollSample(name: string, embedding: number[], seconds: number): Promise<void> {
  const key = personNameKey(name);
  if (!key) return;
  const display = cleanDisplayName(name);
  const w = sampleWeight(seconds);

  // Exact key first; else a legacy row whose old key folds to the same one.
  const candidates = await sql<Array<Pick<VoiceprintRow, 'id' | 'name' | 'name_key'>>>`
    SELECT id, name, name_key FROM ${sql(SCHEMA)}.voiceprints ORDER BY id
  `;
  const target =
    candidates.find((r) => r.name_key === key) ??
    candidates.find((r) => personNameKey(r.name_key) === key);

  if (!target) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.voiceprints (name, name_key, embedding, sample_count, weight_secs)
      VALUES (${display}, ${key}, ${sql.json(embedding)}, 1, ${w})
      ON CONFLICT (name_key) DO NOTHING
    `;
    return;
  }

  await sql.begin(async (tx) => {
    const [row] = await tx<VoiceprintRow[]>`
      SELECT * FROM ${tx(SCHEMA)}.voiceprints WHERE id = ${target.id} FOR UPDATE
    `;
    if (!row) return;
    const W = storedWeight(row);
    const merged = weightedMerge(row.embedding, W, embedding, w);
    await tx`
      UPDATE ${tx(SCHEMA)}.voiceprints
      SET embedding = ${tx.json(merged)},
          sample_count = sample_count + 1,
          weight_secs = ${W + w},
          name = ${preferDisplayName(row.name, display)},
          updated_at = now()
      WHERE id = ${row.id}
    `;
  });
}
