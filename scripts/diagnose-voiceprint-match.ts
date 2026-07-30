/**
 * Diagnostic: for one transcript, embed every diarized speaker and print the
 * top-5 voiceprint matches with raw cosine scores — shows why a suggestion
 * did or didn't fire. Run on the VM:
 *   bun run scripts/diagnose-voiceprint-match.ts <assemblyai_id>
 */
import postgres from 'postgres';
import path from 'node:path';

const SCHEMA = `meeting_whisperer_${process.env.SCHEMA_PREFIX || 'prod'}`;
const SIDECAR_URL = process.env.MW_VOICEPRINT_URL || 'http://127.0.0.1:3004';
const AUDIO_DIR = path.join(
  path.isAbsolute(process.env.MW_STORAGE_DIR || './storage')
    ? (process.env.MW_STORAGE_DIR as string)
    : path.resolve(process.cwd(), process.env.MW_STORAGE_DIR || './storage'),
  'audio'
);

const tid = process.argv[2];
if (!tid) {
  console.error('usage: bun run scripts/diagnose-voiceprint-match.ts <assemblyai_id>');
  process.exit(1);
}

const sql = postgres({ onnotice: () => {} });

interface Utterance { start: number; end: number; speaker: string }

const rows = await sql<
  Array<{ local_audio_path: string; utterances: Utterance[] }>
>`
  SELECT local_audio_path, imported_content->'utterances' AS utterances
  FROM ${sql(SCHEMA)}.transcripts
  WHERE assemblyai_id = ${tid} AND local_audio_path IS NOT NULL
  LIMIT 1
`;
if (!rows.length) { console.error('transcript not found'); process.exit(1); }

const { local_audio_path, utterances } = rows[0]!;
const audioPath = path.join(AUDIO_DIR, local_audio_path);
const voiceprints = await sql<Array<{ name: string; embedding: number[]; sample_count: number }>>`
  SELECT name, embedding, sample_count FROM ${sql(SCHEMA)}.voiceprints
`;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0); na += a[i]! * a[i]!; nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const speakers = [...new Set(utterances.map((u) => u.speaker))].sort();
for (const sp of speakers) {
  const segments = utterances
    .filter((u) => u.speaker === sp && u.end - u.start >= 1500)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, 6)
    .map((u) => ({ start_ms: u.start, end_ms: u.end }));
  const res = await fetch(`${SIDECAR_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_path: audioPath, segments }),
  });
  if (!res.ok) { console.log(`${sp}: embed failed ${res.status}`); continue; }
  const { embedding } = (await res.json()) as { embedding: number[] };
  const top = voiceprints
    .map((vp) => ({ name: vp.name, n: vp.sample_count, score: cosine(embedding, vp.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  console.log(`Speaker ${sp}: ${top.map((t) => `${t.name}[${t.n}]=${t.score.toFixed(3)}`).join('  ')}`);
}
await sql.end();
