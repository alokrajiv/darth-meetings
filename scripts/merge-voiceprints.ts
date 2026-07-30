/**
 * Merge duplicate voiceprint identities: source rows fold into the target —
 * embeddings combine as a sample_count-weighted average (re-normalized),
 * counts sum, source rows are deleted. Pairs are hardcoded per cleanup run;
 * verify with find-voiceprint-dupes.ts first (voice cosine, not just names).
 *
 * Run on the VM: bun run scripts/merge-voiceprints.ts
 */
import postgres from 'postgres';

const SCHEMA = `meeting_whisperer_${process.env.SCHEMA_PREFIX || 'prod'}`;
const sql = postgres({ onnotice: () => {} });

// [source name_key, target name_key, target display name]
const MERGES: Array<[string, string, string]> = [
  ['preet', 'preet singh', 'Preet Singh'],
  ['chee huei', 'chee huei choong', 'Chee Huei Choong'],
  ['lili', 'li li', 'Li Li'],
  ['ivan', 'ivan seow', 'Ivan Seow'],
  ['ka wen', 'kawen koh', 'Kawen Koh'],
  ['kawen', 'kawen koh', 'Kawen Koh'],
  ['al', 'alok rajiv', 'Alok Rajiv'],
  ['aniq', 'aniq danial', 'Aniq Danial'],
  ['jac', 'jacqueline', 'Jacqueline'],
  ['ameya', 'ameya kulkarni', 'Ameya Kulkarni'],
  ['lixuan', 'li xuan', 'Li Xuan'],
];

for (const [srcKey, tgtKey, tgtName] of MERGES) {
  const rows = await sql<
    Array<{ name_key: string; embedding: number[]; sample_count: number }>
  >`
    SELECT name_key, embedding, sample_count FROM ${sql(SCHEMA)}.voiceprints
    WHERE name_key IN (${srcKey}, ${tgtKey})
  `;
  const src = rows.find((r) => r.name_key === srcKey);
  const tgt = rows.find((r) => r.name_key === tgtKey);
  if (!src) { console.log(`skip: source "${srcKey}" not found`); continue; }
  if (!tgt) { console.log(`skip: target "${tgtKey}" not found`); continue; }

  const total = src.sample_count + tgt.sample_count;
  const merged = tgt.embedding.map(
    (v, i) => (v * tgt.sample_count + (src.embedding[i] ?? 0) * src.sample_count) / total
  );
  const norm = Math.sqrt(merged.reduce((s, v) => s + v * v, 0)) || 1;

  await sql.begin(async (tx) => {
    await tx`
      UPDATE ${tx(SCHEMA)}.voiceprints
      SET embedding = ${tx.json(merged.map((v) => v / norm))},
          sample_count = ${total}, name = ${tgtName}, updated_at = now()
      WHERE name_key = ${tgtKey}
    `;
    await tx`DELETE FROM ${tx(SCHEMA)}.voiceprints WHERE name_key = ${srcKey}`;
  });
  console.log(`merged "${srcKey}"[${src.sample_count}] -> "${tgtName}"[${total}]`);
}

const remaining = await sql`SELECT count(*) AS n FROM ${sql(SCHEMA)}.voiceprints`;
console.log(`\n${remaining[0]!.n} voiceprints remain`);
await sql.end();
