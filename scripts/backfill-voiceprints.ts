/**
 * One-shot backfill: build voiceprints from every transcript that already has
 * named speakers + a local audio file + cached content.
 *
 * Run on the VM (needs the audio files and the sidecar):
 *   cd ~/apps/meeting-whisperer && bun run scripts/backfill-voiceprints.ts
 *
 * Standalone on purpose — the app's server libs are `server-only` and can't
 * be imported from a plain bun script, so the small amount of embed/enroll
 * logic is duplicated here. Idempotent: re-running adds more samples to the
 * rolling averages, which is harmless.
 */
import postgres from 'postgres';
import path from 'node:path';
import { existsSync } from 'node:fs';

const SCHEMA = `meeting_whisperer_${process.env.SCHEMA_PREFIX || 'prod'}`;
const SIDECAR_URL = process.env.MW_VOICEPRINT_URL || 'http://127.0.0.1:3004';
const AUDIO_DIR = path.join(
  path.isAbsolute(process.env.MW_STORAGE_DIR || './storage')
    ? (process.env.MW_STORAGE_DIR as string)
    : path.resolve(process.cwd(), process.env.MW_STORAGE_DIR || './storage'),
  'audio'
);

const sql = postgres({ onnotice: () => {} });

interface Utterance { text: string; start: number; end: number; speaker: string }
interface Label { originalSpeaker: string; customName: string }

function pickSegments(utterances: Utterance[], speaker: string) {
  return utterances
    .filter((u) => u.speaker === speaker && u.end - u.start >= 1500)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, 6)
    .map((u) => ({ start_ms: u.start, end_ms: u.end }));
}

async function embed(audioPath: string, segments: { start_ms: number; end_ms: number }[]) {
  if (segments.length === 0) return null;
  const res = await fetch(`${SIDECAR_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_path: audioPath, segments }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`sidecar ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { embedding: number[] }).embedding;
}

async function enroll(name: string, embedding: number[]) {
  const key = name.trim().toLowerCase();
  const existing = await sql`
    SELECT embedding, sample_count FROM ${sql(SCHEMA)}.voiceprints WHERE name_key = ${key} LIMIT 1
  `;
  if (existing.length === 0) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.voiceprints (name, name_key, embedding, sample_count)
      VALUES (${name.trim()}, ${key}, ${sql.json(embedding)}, 1)
      ON CONFLICT (name_key) DO NOTHING
    `;
    return 'created';
  }
  const row = existing[0]! as { embedding: number[]; sample_count: number };
  const n = row.sample_count;
  const merged = row.embedding.map((v: number, i: number) => (v * n + (embedding[i] ?? 0)) / (n + 1));
  const norm = Math.sqrt(merged.reduce((s: number, v: number) => s + v * v, 0)) || 1;
  await sql`
    UPDATE ${sql(SCHEMA)}.voiceprints
    SET embedding = ${sql.json(merged.map((v: number) => v / norm))},
        sample_count = sample_count + 1, name = ${name.trim()}, updated_at = now()
    WHERE name_key = ${key}
  `;
  return 'updated';
}

const rows = await sql<
  Array<{
    assemblyai_id: string;
    local_audio_path: string | null;
    utterances: Utterance[] | null;
    speaker_labels: Label[];
  }>
>`
  SELECT t.assemblyai_id, t.local_audio_path,
         t.imported_content->'utterances' AS utterances,
         m.speaker_labels
  FROM ${sql(SCHEMA)}.transcripts t
  JOIN ${sql(SCHEMA)}.speaker_mappings m
    ON m.user_id = t.user_id AND m.assemblyai_id = t.assemblyai_id
  WHERE t.status = 'completed'
    AND t.local_audio_path IS NOT NULL
    AND jsonb_array_length(COALESCE(t.imported_content->'utterances', '[]'::jsonb)) > 0
    AND jsonb_array_length(m.speaker_labels) > 0
  ORDER BY t.created_at ASC
`;

console.log(`${rows.length} transcript(s) with named speakers + audio + content`);
let enrolled = 0;
let skipped = 0;

for (const row of rows) {
  const audioPath = path.join(AUDIO_DIR, row.local_audio_path!);
  if (!existsSync(audioPath)) {
    console.warn(`  ${row.assemblyai_id}: audio missing (${row.local_audio_path}), skipping`);
    skipped++;
    continue;
  }
  for (const label of row.speaker_labels) {
    const name = label.customName?.trim();
    if (!name) continue;
    try {
      const segments = pickSegments(row.utterances ?? [], label.originalSpeaker);
      const vec = await embed(audioPath, segments);
      if (!vec) {
        console.warn(`  ${row.assemblyai_id} ${label.originalSpeaker}→${name}: no usable segments`);
        continue;
      }
      const action = await enroll(name, vec);
      enrolled++;
      console.log(`  ${row.assemblyai_id} ${label.originalSpeaker}→${name}: ${action}`);
    } catch (err) {
      console.warn(`  ${row.assemblyai_id} ${label.originalSpeaker}→${name}: FAILED ${err}`);
    }
  }
}

const final = await sql`SELECT name, sample_count FROM ${sql(SCHEMA)}.voiceprints ORDER BY name`;
console.log(`\nDone: ${enrolled} samples enrolled, ${skipped} transcripts skipped.`);
console.log('Voiceprints:', final.map((r) => `${r.name}(${r.sample_count})`).join(', ') || 'none');
await sql.end();
