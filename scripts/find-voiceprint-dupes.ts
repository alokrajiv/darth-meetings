/**
 * Find likely duplicate identities in the voiceprints table.
 *
 * Two independent signals:
 *   - name similarity (variant spellings: prefix, first token, spacing, case)
 *   - voice similarity (cosine between the stored rolling-average embeddings)
 *
 * Prints every pair that is name-similar OR voice-similar (>= 0.5), with both
 * scores, so a human (or a follow-up merge script) can decide.
 *
 * Run on the VM: bun run scripts/find-voiceprint-dupes.ts
 */
import postgres from 'postgres';

const SCHEMA = `meeting_whisperer_${process.env.SCHEMA_PREFIX || 'prod'}`;
const sql = postgres({ onnotice: () => {} });

interface VP { id: number; name: string; embedding: number[]; sample_count: number }

const vps = await sql<VP[]>`
  SELECT id, name, embedding, sample_count FROM ${sql(SCHEMA)}.voiceprints ORDER BY name
`;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0); na += a[i]! * a[i]!; nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function nameSimilar(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na.replace(/[\s.]+/g, '') === nb.replace(/[\s.]+/g, '')) return true;
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  return na.split(/\s+/)[0] === nb.split(/\s+/)[0];
}

const out: Array<{ a: VP; b: VP; nameSim: boolean; voice: number }> = [];
for (let i = 0; i < vps.length; i++) {
  for (let j = i + 1; j < vps.length; j++) {
    const a = vps[i]!, b = vps[j]!;
    const nameSim = nameSimilar(a.name, b.name);
    const voice = cosine(a.embedding, b.embedding);
    if (nameSim || voice >= 0.5) out.push({ a, b, nameSim, voice });
  }
}

out.sort((x, y) => y.voice - x.voice);
for (const p of out) {
  console.log(
    `${p.voice.toFixed(3)}  name=${p.nameSim ? 'Y' : 'n'}  ` +
    `"${p.a.name}"[${p.a.sample_count}] <> "${p.b.name}"[${p.b.sample_count}]`
  );
}
console.log(`\n${out.length} candidate pair(s) across ${vps.length} voiceprints`);
await sql.end();
