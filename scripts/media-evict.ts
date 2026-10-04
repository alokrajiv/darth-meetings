/**
 * Stage D — remove LOCAL copies whose blob has been read back and matched
 * (docs/recordings-stage-d-spec.md). DRY RUN unless `--apply`.
 *
 *   SCHEMA_PREFIX=prod bun --conditions=react-server scripts/media-evict.ts
 *   SCHEMA_PREFIX=prod bun --conditions=react-server scripts/media-evict.ts --min-age-days 0 --limit 50
 *   SCHEMA_PREFIX=prod bun --conditions=react-server scripts/media-evict.ts --apply [--limit N] [--largest-first]
 *   SCHEMA_PREFIX=prod bun --conditions=react-server scripts/media-evict.ts --orphans
 *
 * The dry run prints the candidate table — media id, kind, bytes, captured,
 * verified at, local path — and the totals: rows read back and matched at
 * least `--min-age-days` (default `MW_MEDIA_EVICT_AFTER_DAYS`, 7) days ago,
 * not yet evicted. Expect 0 until the age gate passes; `--min-age-days 0`
 * shows the full set.
 *
 * `--apply` runs `evictLocalCopy` (src/lib/server/media-evict.ts) per row —
 * the same per-row procedure as the sweeper's pass: busy checks, the 1 h mtime
 * gate, the local re-hash, the blob HEAD, ledger row + `local_evicted_at` in
 * one transaction, THEN the unlink — with `evicted_by = 'script:<user>@<host>'`.
 * It needs the VM's managed identity (DARTH_MEDIA_ACCOUNT) and must run from
 * the LIVE colour's app dir, whose `storage/` is the one the rows describe.
 *
 * `--orphans` is report-only: files under `storage/audio*` that no media row
 * (nor a meeting's `local_audio_path`) names, and files whose row says Stage D
 * evicted them — the leftover of a crash between the ledger and the unlink,
 * which is harmless and is what this listing is for. Nothing is deleted.
 *
 * Exit code 0 = done (or nothing to do), 1 = some row failed, 2 = refused.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
function value(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

if (flag('--help') || flag('-h')) {
  console.log(
    'usage: SCHEMA_PREFIX=<p> bun --conditions=react-server scripts/media-evict.ts ' +
      '[--apply] [--limit N] [--min-age-days N] [--largest-first] [--orphans]'
  );
  process.exit(0);
}

const APPLY = flag('--apply');
const ORPHANS = flag('--orphans');
const LARGEST_FIRST = flag('--largest-first');
const LIMIT = Number(value('--limit') ?? 200);
const MIN_AGE_RAW = value('--min-age-days');

if (!Number.isInteger(LIMIT) || LIMIT <= 0) {
  console.error('refused: --limit takes a positive integer');
  process.exit(2);
}
if (MIN_AGE_RAW !== null && !(Number.parseFloat(MIN_AGE_RAW) >= 0)) {
  console.error('refused: --min-age-days takes a number ≥ 0');
  process.exit(2);
}
if (APPLY && ORPHANS) {
  console.error('refused: --orphans is report-only and cannot be combined with --apply');
  process.exit(2);
}

const explicitPrefix = (value('--schema-prefix') || process.env.SCHEMA_PREFIX || '').trim() || null;
if (!explicitPrefix) {
  console.error(
    'refused: set SCHEMA_PREFIX (env or --schema-prefix <name>) so the schema being changed is a choice, not a default.'
  );
  process.exit(2);
}
// BEFORE the app modules load: `@/lib/constants/database` builds the schema
// name at import time.
process.env.SCHEMA_PREFIX = explicitPrefix;
const SCHEMA = `meeting_whisperer_${explicitPrefix}`;

const { sql } = await import('@/lib/db');
const { getStorageDir } = await import('@/lib/server/audio-storage');
const { fmtBytes } = await import('@/lib/server/media-archive');
const { evictAfterDays, evictLocalCopy } = await import('@/lib/server/media-evict');
const { listEvictableMedia, mediaEvictionColumnsExist } = await import('@/db-ops/recordings');
const { mediaStore } = await import('@/lib/server/media-store');

const BY = `script:${os.userInfo().username}@${os.hostname()}`;
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);
const iso = (v: unknown) => (v == null ? '—' : new Date(v as string).toISOString().slice(0, 16).replace('T', ' '));

// ---------------------------------------------------------------------------
// --orphans
// ---------------------------------------------------------------------------

async function orphans(): Promise<void> {
  const storage = getStorageDir();
  const named = await sql<Array<{ kind: string; filename: string; evicted: boolean }>>`
    SELECT kind, filename, (local_evicted_at IS NOT NULL) AS evicted
    FROM ${sql(SCHEMA)}.recording_media
    WHERE filename IS NOT NULL
  `;
  const meetings = await sql<Array<{ filename: string }>>`
    SELECT local_audio_path AS filename FROM ${sql(SCHEMA)}.transcripts
    WHERE local_audio_path IS NOT NULL
    UNION
    SELECT p->>'filename' FROM ${sql(SCHEMA)}.transcripts t,
      jsonb_array_elements(CASE WHEN jsonb_typeof(t.gmeet_context->'videoParts') = 'array'
                                THEN t.gmeet_context->'videoParts' ELSE '[]'::jsonb END) p
    WHERE p->>'filename' IS NOT NULL
  `;
  const audioNames = new Set<string>(meetings.map((m) => m.filename));
  const audioOnlyNames = new Set<string>();
  const evicted = new Set<string>();
  for (const r of named) {
    const dir = r.kind === 'audio_only' ? 'audio-only' : 'audio';
    (dir === 'audio' ? audioNames : audioOnlyNames).add(r.filename);
    if (r.evicted) evicted.add(`${dir}/${r.filename}`);
  }
  // An extract is also "named" by its source's stem (the derivative sweep's
  // rule) — before the sync has written its row it is not an orphan.
  const sourceStems = new Set([...audioNames].map((f) => path.parse(f).name));

  let unnamed = 0;
  let unnamedBytes = 0;
  let ledgerSaysGone = 0;
  let ledgerBytes = 0;
  for (const dir of ['audio', 'audio-only'] as const) {
    const abs = path.join(storage, dir);
    const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      const st = await fsp.stat(path.join(abs, e.name)).catch(() => null);
      const size = st?.size ?? 0;
      const key = `${dir}/${e.name}`;
      if (evicted.has(key)) {
        ledgerSaysGone += 1;
        ledgerBytes += size;
        console.log(`  EVICTED-BUT-PRESENT ${pad(key, 64)} ${padL(fmtBytes(size), 10)}`);
        continue;
      }
      const isNamed =
        dir === 'audio'
          ? audioNames.has(e.name)
          : audioOnlyNames.has(e.name) || sourceStems.has(path.parse(e.name).name);
      if (!isNamed) {
        unnamed += 1;
        unnamedBytes += size;
        const temp = /\.(tmp|part)$/.test(e.name) ? '  (temp file)' : '';
        console.log(`  UNNAMED             ${pad(key, 64)} ${padL(fmtBytes(size), 10)}${temp}`);
      }
    }
  }
  console.log(
    `orphans           : ${unnamed} file(s) no row names (${fmtBytes(unnamedBytes)}), ` +
      `${ledgerSaysGone} the ledger says are evicted (${fmtBytes(ledgerBytes)}) — report only, nothing deleted`
  );
}

// ---------------------------------------------------------------------------
// The candidates, and --apply
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log('─── media evict (Stage D) ───────────────────────────────────');
  console.log(`schema            : ${SCHEMA}`);
  console.log(`storage           : ${getStorageDir()}`);
  console.log(`mode              : ${ORPHANS ? 'orphans (report only)' : APPLY ? `APPLY as ${BY}` : 'dry run'}`);

  if (!(await mediaEvictionColumnsExist())) {
    console.log('refused           : migration 051 (media_local_eviction) is not applied on this schema');
    return 2;
  }
  if (ORPHANS) {
    await orphans();
    return 0;
  }
  if (APPLY && !mediaStore()) {
    console.log('refused           : --apply needs DARTH_MEDIA_ACCOUNT (the blob is re-checked before every delete)');
    return 2;
  }

  const minAgeDays = MIN_AGE_RAW !== null ? Number.parseFloat(MIN_AGE_RAW) : evictAfterDays();
  const rows = await listEvictableMedia({ minAgeDays, limit: LIMIT, largestFirst: LARGEST_FIRST });
  console.log(
    `candidates        : ${rows.length} (verified ≥ ${minAgeDays} day(s) ago, not evicted, ` +
      `${LARGEST_FIRST ? 'largest' : 'oldest capture'} first, limit ${LIMIT})`
  );
  console.log('');
  console.log(
    `  ${pad('media id', 37)}${pad('kind', 11)}${padL('bytes', 10)}  ${pad('captured', 17)} ${pad('verified at', 17)} path`
  );
  let total = 0;
  for (const r of rows) {
    total += r.bytes ?? 0;
    const dir = r.kind === 'audio_only' ? 'audio-only' : 'audio';
    console.log(
      `  ${pad(r.id, 37)}${pad(r.kind, 11)}${padL(fmtBytes(r.bytes ?? 0), 10)}  ${pad(iso(r.created_at), 17)} ` +
        `${pad(iso(r.blob_verified_at), 17)} ${dir}/${r.filename}`
    );
  }
  console.log(`  TOTAL ${rows.length} file(s), ${fmtBytes(total)}`);

  if (!APPLY) {
    console.log('');
    console.log('dry run — nothing deleted. Re-run with --apply to evict these.');
    return 0;
  }

  console.log('');
  let evicted = 0;
  let freed = 0;
  let failed = 0;
  const tally = new Map<string, number>();
  for (const r of rows) {
    const out = await evictLocalCopy(r, { by: BY });
    tally.set(out.status, (tally.get(out.status) ?? 0) + 1);
    const label = `${pad(r.id, 37)}${pad(r.kind, 11)}`;
    switch (out.status) {
      case 'evicted':
        evicted += 1;
        freed += out.bytes;
        console.log(`  EVICTED      ${label}${fmtBytes(out.bytes)}`);
        break;
      case 'already-gone':
        console.log(`  ALREADY GONE ${label}(marked evicted, ledger note)`);
        break;
      case 'rewritten':
        console.log(`  REWRITTEN    ${label}${out.reason} — kept, verification cleared`);
        break;
      case 'skipped':
        console.log(`  SKIPPED      ${label}${out.reason}`);
        break;
      case 'failed':
        failed += 1;
        console.log(`  FAILED       ${label}${out.error}`);
        break;
    }
  }
  console.log('');
  console.log(
    `applied           : ${evicted} evicted, ${fmtBytes(freed)} freed | ` +
      [...tally.entries()].map(([k, n]) => `${k} ${n}`).join(', ')
  );
  return failed > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    console.log('─────────────────────────────────────────────────────────────');
    await sql.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[media-evict] failed:', err);
    await sql.end().catch(() => {});
    process.exit(2);
  });
