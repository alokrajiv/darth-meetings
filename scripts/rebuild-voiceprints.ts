/**
 * Rebuild the voiceprints table from every confirmed speaker label, with the
 * duration-budget picker and duration-weighted means (lib/voiceprint-math.ts,
 * 2026-09-24 "rescore the fingerprints on long rants").
 *
 * What it does:
 *  (a) --apply only: backs `voiceprints` up into voiceprints_backup_YYYYMMDD
 *      (SGT date; refuses if it exists unless --force-backup, which then uses
 *      a _HHMMSS-suffixed name — an earlier backup is never overwritten);
 *  (b) walks every speaker_mappings label with a non-empty, non-group
 *      customName on a completed, non-deleted meeting (the OWNER's mapping
 *      row — editors write to it too), resolving text + media through THE
 *      resolver and `mediaForSpeaker`, exactly as the app enrols;
 *  (c) embeds each label's speech via the sidecar (MW_VOICEPRINT_URL);
 *  (d) folds samples per personNameKey, weighted by seconds (≤180 s each);
 *  (e) --apply: TRUNCATE + INSERT in one transaction (nothing references
 *      voiceprints.id — checked against pg_constraint before writing);
 *  (f) prints a report.
 *
 * Embeddings are cached (JSONL, one line per embed) under MW_SCRATCH_DIR or
 * /tmp, keyed by transcript id + speaker + seconds, so a re-run after a crash
 * or a dry run followed by --apply does not re-embed.
 *
 * Run on the VM from the app dir (bun loads .env.local; the server libs need
 * the react-server condition to import):
 *   cd ~/apps/meeting-whisperer
 *   bun --conditions=react-server scripts/rebuild-voiceprints.ts --dry-run [--limit N] [--only "<name>"]
 *   bun --conditions=react-server scripts/rebuild-voiceprints.ts --apply
 *   bun --conditions=react-server scripts/rebuild-voiceprints.ts --selftest   # no DB, no sidecar
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { personNameKey } from '@/lib/person-identity';
import { isGroupLabel } from '@/lib/speaker-name-kind';
import {
  aggregateSamples,
  cleanDisplayName,
  normalize,
  type AggregatedIdentity,
  type VoiceSample,
} from '@/lib/voiceprint-math';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
function value(n: string): string | null {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

if (flag('--help') || flag('-h')) {
  console.log(
    'usage: bun --conditions=react-server scripts/rebuild-voiceprints.ts [--dry-run | --apply] [--force-backup] [--limit N] [--only "<name>"] [--selftest]'
  );
  process.exit(0);
}

const APPLY = flag('--apply');
const SELFTEST = flag('--selftest');
const FORCE_BACKUP = flag('--force-backup');
const LIMIT = value('--limit') === null ? null : Number(value('--limit'));
const ONLY = value('--only');
const ONLY_KEY = ONLY ? personNameKey(ONLY) : null;

if (LIMIT !== null && (!Number.isInteger(LIMIT) || LIMIT < 0)) {
  console.error('refused: --limit takes a non-negative integer');
  process.exit(2);
}
if (APPLY && flag('--dry-run')) {
  console.error('refused: --apply and --dry-run together');
  process.exit(2);
}
if (APPLY && (LIMIT !== null || ONLY)) {
  // TRUNCATE + INSERT of a partial walk would delete everyone else's print.
  console.error('refused: --apply replaces the whole table, so it cannot be combined with --limit/--only');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Report (pure — fed by the DB walk or by --selftest)
// ---------------------------------------------------------------------------

interface OldRow {
  name: string;
  name_key: string;
  sample_count: number;
  weight_secs?: number | null;
}

interface WalkStats {
  labels: number;
  embedded: number;
  cacheHits: number;
  skippedGroup: number;
  skippedNoContent: number;
  skippedNoMedia: number;
  skippedTranscriptOnly: number;
  skippedMissingFile: number;
  skippedNoSegment: number;
  skippedDuplicateAudio: number;
  failed: number;
}

function emptyStats(): WalkStats {
  return {
    labels: 0, embedded: 0, cacheHits: 0, skippedGroup: 0, skippedNoContent: 0, skippedNoMedia: 0, skippedTranscriptOnly: 0,
    skippedMissingFile: 0, skippedNoSegment: 0, skippedDuplicateAudio: 0, failed: 0,
  };
}

const WEAK_SECS = 20;

function buildReport(allBefore: OldRow[], after: AggregatedIdentity[], stats: WalkStats): string[] {
  const out: string[] = [];
  // --only compares against that person's rows alone; --limit's "dropped" is partial by nature.
  const before = ONLY_KEY
    ? allBefore.filter((r) => personNameKey(r.name_key || r.name) === ONLY_KEY)
    : allBefore;
  if (LIMIT !== null) out.push(`(--limit ${LIMIT}: a partial walk — "dropped" below is not meaningful)`);
  const oldByKey = new Map<string, OldRow[]>();
  for (const r of before) {
    const k = personNameKey(r.name_key || r.name);
    oldByKey.set(k, [...(oldByKey.get(k) ?? []), r]);
  }
  const newKeys = new Set(after.map((a) => a.key));

  out.push('== walk ==');
  out.push(
    `labels ${stats.labels} · embedded ${stats.embedded} (cache hits ${stats.cacheHits}) · ` +
      `skipped: group ${stats.skippedGroup}, no content ${stats.skippedNoContent}, no media ${stats.skippedNoMedia}, transcript-only import ${stats.skippedTranscriptOnly}, ` +
      `file missing ${stats.skippedMissingFile}, no ≥1.5s segment ${stats.skippedNoSegment}, ` +
      `duplicate audio ${stats.skippedDuplicateAudio}, embed failed ${stats.failed}`
  );

  out.push('', '== rows ==');
  out.push(`before ${before.length} → after ${after.length}`);

  const merged = after
    .map((a) => ({ a, olds: oldByKey.get(a.key) ?? [] }))
    .filter(({ a, olds }) => olds.length > 1 || (olds.length === 1 && olds[0]!.name !== a.name));
  out.push('', `== identities merged / renamed (${merged.length}) ==`);
  for (const { a, olds } of merged) {
    out.push(`  ${olds.map((o) => JSON.stringify(o.name)).join(', ')} → ${JSON.stringify(a.name)}`);
  }

  const fresh = after.filter((a) => !oldByKey.has(a.key));
  out.push('', `== new identities (${fresh.length}) ==`);
  for (const a of fresh) out.push(`  ${JSON.stringify(a.name)}`);

  const dropped = [...oldByKey.entries()].filter(([k]) => !newKeys.has(k));
  out.push('', `== dropped: no confirmed label with usable audio (${dropped.length}) ==`);
  for (const [, olds] of dropped) {
    out.push(`  ${olds.map((o) => `${JSON.stringify(o.name)}[${o.sample_count}]`).join(', ')}`);
  }

  out.push('', '== per identity (seconds of speech · samples · weight) ==');
  for (const a of [...after].sort((x, y) => y.seconds - x.seconds)) {
    const spellings = [...a.spellings.keys()].filter((s) => s !== a.name);
    out.push(
      `  ${a.name.padEnd(28)} ${a.seconds.toFixed(0).padStart(6)}s ${String(a.samples).padStart(4)} ` +
        `${a.weightSecs.toFixed(0).padStart(6)}` +
        (spellings.length ? `   (also: ${spellings.map((s) => JSON.stringify(s)).join(', ')})` : '')
    );
  }

  const weak = after.filter((a) => a.seconds < WEAK_SECS).sort((x, y) => x.seconds - y.seconds).slice(0, 20);
  out.push('', `== weakest identities (< ${WEAK_SECS}s of audio, top 20) ==`);
  for (const a of weak) out.push(`  ${a.name.padEnd(28)} ${a.seconds.toFixed(1)}s from ${a.samples} sample(s)`);
  return out;
}

// ---------------------------------------------------------------------------
// --selftest: synthetic data through aggregate + report, no DB, no sidecar
// ---------------------------------------------------------------------------

function unit(dim: number, hot: number): number[] {
  const v = new Array(dim).fill(0.01);
  v[hot] = 1;
  return normalize(v);
}

if (SELFTEST) {
  const labels: Array<{ name: string; seconds: number; hot: number }> = [
    { name: 'karnica.katiyar', seconds: 12, hot: 0 },
    { name: 'Karnica Katiyar', seconds: 95, hot: 0 },
    { name: 'shridhar.​tirthkar', seconds: 40, hot: 1 },
    { name: 'Shridhar Tirthkar', seconds: 400, hot: 1 },
    { name: 'pratiksha', seconds: 6, hot: 2 },
    { name: 'mixed', seconds: 30, hot: 3 },
  ];
  const stats = emptyStats();
  const samples: VoiceSample[] = [];
  for (const l of labels) {
    stats.labels++;
    if (isGroupLabel(l.name)) { stats.skippedGroup++; continue; }
    if (LIMIT !== null && samples.length >= LIMIT) break;
    if (ONLY_KEY && personNameKey(l.name) !== ONLY_KEY) continue;
    samples.push({ name: l.name, embedding: unit(8, l.hot), seconds: l.seconds });
    stats.embedded++;
  }
  const after = aggregateSamples(samples);
  const before: OldRow[] = [
    { name: 'karnica.katiyar', name_key: 'karnica.katiyar', sample_count: 5 },
    { name: 'Karnica Katiyar', name_key: 'karnica katiyar', sample_count: 2 },
    { name: 'shridhar.​tirthkar', name_key: 'shridhar.​tirthkar', sample_count: 1 },
    { name: 'Old Leaver', name_key: 'old leaver', sample_count: 3 },
  ];
  console.log(buildReport(before, after, stats).join('\n'));
  if (LIMIT === null && !ONLY_KEY) {
    const names = after.map((a) => a.name);
    const ok =
      names.join('|') === 'Karnica Katiyar|pratiksha|Shridhar Tirthkar' &&
      after.find((a) => a.key === 'shridhar tirthkar')!.weightSecs === 40 + 180;
    console.log(ok ? '\nselftest OK' : `\nselftest FAILED: ${names.join('|')}`);
    process.exit(ok ? 0 : 1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The real walk
// ---------------------------------------------------------------------------

const { sql } = await import('@/lib/db');
const { SCHEMAS } = await import('@/lib/constants/database');
const { resolveMeetingContent, recordingsEnabled } = await import('@/lib/server/recordings');
const { mediaForSpeaker, pickSegments, embedViaSidecar, audioPathFor } = await import('@/lib/server/voiceprint');

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const CACHE_DIR = process.env.MW_SCRATCH_DIR || '/tmp';
const CACHE_FILE = path.join(CACHE_DIR, `voiceprint-rebuild-cache.${SCHEMA}.jsonl`);

console.log(
  `[rebuild] schema ${SCHEMA} · ${APPLY ? 'APPLY' : 'dry run'} · MW_RECORDINGS ${recordingsEnabled() ? 'on' : 'off'} · ` +
    `sidecar ${process.env.MW_VOICEPRINT_URL || 'http://127.0.0.1:3004'} · cache ${CACHE_FILE}` +
    (LIMIT !== null ? ` · limit ${LIMIT}` : '') +
    (ONLY ? ` · only ${JSON.stringify(ONLY)}` : '')
);

// Migration 050 must be in: the INSERT writes weight_secs.
const [col] = await sql<Array<{ n: number }>>`
  SELECT count(*)::int AS n FROM information_schema.columns
  WHERE table_schema = ${SCHEMA} AND table_name = 'voiceprints' AND column_name = 'weight_secs'
`;
if (!col || col.n === 0) {
  console.error('refused: voiceprints.weight_secs is missing — apply migrations/050_voiceprint_weight_secs.sql first');
  await sql.end();
  process.exit(2);
}

// Embedding cache.
const cache = new Map<string, number[]>();
mkdirSync(CACHE_DIR, { recursive: true });
if (existsSync(CACHE_FILE)) {
  for (const line of readFileSync(CACHE_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const { k, e } = JSON.parse(line) as { k: string; e: number[] };
      cache.set(k, e);
    } catch {
      // a torn last line after a crash — ignore it
    }
  }
  console.log(`[rebuild] ${cache.size} cached embedding(s) loaded`);
}

const before = await sql<OldRow[]>`
  SELECT name, name_key, sample_count, weight_secs FROM ${sql(SCHEMA)}.voiceprints ORDER BY name
`;

interface MappingRef {
  transcript_id: number;
  assemblyai_id: string;
  speaker_labels: Array<{ originalSpeaker: string; customName: string }>;
}
const refs = await sql<MappingRef[]>`
  SELECT t.id AS transcript_id, t.assemblyai_id, m.speaker_labels
  FROM ${sql(SCHEMA)}.transcripts t
  JOIN ${sql(SCHEMA)}.speaker_mappings m
    ON m.user_id = t.user_id AND m.assemblyai_id = t.assemblyai_id
  WHERE t.status = 'completed'
    AND t.deleted_at IS NULL
    AND jsonb_typeof(m.speaker_labels) = 'array'
    AND jsonb_array_length(m.speaker_labels) > 0
  ORDER BY t.created_at DESC, t.id DESC
`;
// Newest first so a `--limit N` smoke test walks meetings that HAVE audio —
// the oldest rows are Meet-transcript-only imports (`gmeet-…` ids, no file),
// and a 2026-09-24 `--limit 50` dry run read as "no media ×50" because of it.

const eligible = refs.flatMap((r) =>
  (r.speaker_labels ?? [])
    .filter((l) => l && typeof l.customName === 'string' && l.customName.trim())
    .map((l) => ({ ref: r, speaker: l.originalSpeaker, name: l.customName.trim() }))
);
console.log(`[rebuild] ${refs.length} meeting(s), ${eligible.length} named label(s), ${before.length} voiceprint row(s) now`);

const stats = emptyStats();
const samples: VoiceSample[] = [];
const spellingsSeen: string[] = [];
const seenAudio = new Set<string>();
// One meeting row loaded at a time — 480 payloads in memory at once is not needed.
type LoadedMeeting = { id: number; content: Awaited<ReturnType<typeof resolveMeetingContent>> };
let loaded = null as LoadedMeeting | null;

for (const item of eligible) {
  if (LIMIT !== null && stats.labels >= LIMIT) break;
  if (ONLY_KEY && personNameKey(item.name) !== ONLY_KEY) continue;
  stats.labels++;
  if (stats.labels % 50 === 0) {
    console.log(
      `[rebuild] ${stats.labels}/${eligible.length} labels · ${stats.embedded} embedded (${stats.cacheHits} cached) · ${stats.failed} failed`
    );
  }
  if (isGroupLabel(item.name)) { stats.skippedGroup++; continue; }
  spellingsSeen.push(item.name);

  const tag = `${item.ref.assemblyai_id} ${item.speaker}→${cleanDisplayName(item.name)}`;
  try {
    if (loaded?.id !== item.ref.transcript_id) {
      type Row = Parameters<typeof resolveMeetingContent>[0];
      const rows = await sql<Row[]>`SELECT * FROM ${sql(SCHEMA)}.transcripts WHERE id = ${item.ref.transcript_id}`;
      loaded = { id: item.ref.transcript_id, content: await resolveMeetingContent(rows[0]!) };
    }
    const { content, media } = loaded.content;
    if (!content?.utterances?.length) { stats.skippedNoContent++; continue; }
    const from = mediaForSpeaker(media, item.speaker);
    if (!from) {
      // Meet/Teams transcript-only imports carry names but no audio: expected, not a fault.
      if (item.ref.assemblyai_id.startsWith('gmeet-') || item.ref.assemblyai_id.startsWith('teams-')) stats.skippedTranscriptOnly++;
      else stats.skippedNoMedia++;
      continue;
    }
    const audioPath = audioPathFor(from);
    if (!audioPath || !existsSync(audioPath)) { stats.skippedMissingFile++; continue; }

    const { segments, seconds } = pickSegments(content, item.speaker, from);
    if (segments.length === 0) { stats.skippedNoSegment++; continue; }

    // Two users holding the same job = the same seconds of the same voice.
    const audioKey = `${audioPath}|${item.speaker}|${personNameKey(item.name)}`;
    if (seenAudio.has(audioKey)) { stats.skippedDuplicateAudio++; continue; }
    seenAudio.add(audioKey);

    const cacheKey = `${item.ref.transcript_id}|${item.speaker}|${seconds.toFixed(2)}`;
    let embedding = cache.get(cacheKey) ?? null;
    if (embedding) {
      stats.cacheHits++;
    } else {
      embedding = await embedViaSidecar(audioPath, segments);
      if (!embedding) { stats.skippedNoSegment++; continue; }
      cache.set(cacheKey, embedding);
      appendFileSync(CACHE_FILE, JSON.stringify({ k: cacheKey, e: embedding }) + '\n');
    }
    stats.embedded++;
    samples.push({ name: item.name, embedding, seconds });
  } catch (err) {
    stats.failed++;
    console.warn(`[rebuild] ${tag}: FAILED ${String(err).slice(0, 200)}`);
  }
}

const after = aggregateSamples(samples, spellingsSeen);
console.log('\n' + buildReport(before, after, stats).join('\n'));

if (!APPLY) {
  console.log('\n[rebuild] dry run — nothing written. Re-run with --apply to replace the table.');
  await sql.end();
  process.exit(0);
}

if (after.length === 0) {
  console.error('refused: the rebuild produced no identities — not truncating the table');
  await sql.end();
  process.exit(2);
}

// Nothing may reference voiceprints.id, or TRUNCATE would cascade/refuse.
const refsToVp = await sql<Array<{ conname: string }>>`
  SELECT conname FROM pg_constraint
  WHERE confrelid = ${`${SCHEMA}.voiceprints`}::regclass
`;
if (refsToVp.length > 0) {
  console.error(`refused: voiceprints.id is referenced by ${refsToVp.map((r) => r.conname).join(', ')}`);
  await sql.end();
  process.exit(2);
}

const sgt = new Date(Date.now() + 8 * 3600_000).toISOString(); // SGT wall clock
let backup = `voiceprints_backup_${sgt.slice(0, 10).replace(/-/g, '')}`;
const exists = async (name: string) =>
  (await sql`SELECT to_regclass(${`${SCHEMA}.${name}`}) AS t`)[0]!.t !== null;
if (await exists(backup)) {
  if (!FORCE_BACKUP) {
    console.error(`refused: ${SCHEMA}.${backup} already exists (pass --force-backup to write a _HHMMSS one alongside)`);
    await sql.end();
    process.exit(2);
  }
  backup = `${backup}_${sgt.slice(11, 19).replace(/:/g, '')}`;
}

await sql.begin(async (tx) => {
  await tx`LOCK TABLE ${tx(SCHEMA)}.voiceprints IN EXCLUSIVE MODE`;
  await tx`CREATE TABLE ${tx(SCHEMA)}.${tx(backup)} AS TABLE ${tx(SCHEMA)}.voiceprints`;
  await tx`TRUNCATE ${tx(SCHEMA)}.voiceprints`;
  for (const a of after) {
    await tx`
      INSERT INTO ${tx(SCHEMA)}.voiceprints (name, name_key, embedding, sample_count, weight_secs)
      VALUES (${a.name}, ${a.key}, ${tx.json(a.embedding)}, ${a.samples}, ${a.weightSecs})
    `;
  }
});
const [{ n }] = (await sql`SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.voiceprints`) as unknown as [{ n: number }];
console.log(`\n[rebuild] APPLIED: backup ${SCHEMA}.${backup} (${before.length} rows), voiceprints now ${n} rows.`);
await sql.end();
