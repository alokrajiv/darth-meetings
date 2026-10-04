/**
 * Where the media archive has got to — READ ONLY.
 *
 * Counts what `recording_media` says (archived / still to copy / nothing to
 * copy, by kind and in bytes), prints the lifecycle canary's verdict, the
 * queue of blobs waiting to be deleted, and how many recordings are in the
 * blob but not (yet) on this VM — Stage C's normal state for a few minutes.
 * This is the totals line the sweeper's per-tick log deliberately does not
 * print (docs/recordings-blob-spec.md, Stage A.3/A.4/C).
 *
 *   SCHEMA_PREFIX=prod bun run scripts/media-archive-status.ts
 *   SCHEMA_PREFIX=prod bun run scripts/media-archive-status.ts --check-blobs
 *   SCHEMA_PREFIX=prod bun run scripts/media-archive-status.ts --check-blobs --limit 50 --verbose
 *
 * `--check-blobs` additionally asks Azure about the archived blobs themselves
 * — size and the stored sha256 metadata against the row — so it only works
 * where `DARTH_MEDIA_ACCOUNT` is set and the identity can read the container
 * (i.e. on the VM). It reads; it never writes a blob, and the DB session is
 * opened `default_transaction_read_only` so even a bug cannot change a row.
 *
 * Stage D (docs/recordings-stage-d-spec.md, migration 051): per kind, how many
 * archived files have been READ BACK and matched (verified), not yet
 * (unverified), whose last read-back did not match (verify-failed — a human
 * decides; the rows are listed), and whose local copy Stage D removed
 * (evicted — a missing file is then the normal state, not a defect).
 *
 *   SCHEMA_PREFIX=prod bun --conditions=react-server scripts/media-archive-status.ts --verify [--limit N]
 *
 * `--verify` is the fast drain of the sweeper's read-back: it runs
 * `verifyArchivedBlob` synchronously over the rows still to verify (all of
 * them unless `--limit`), printing one OK / MISMATCH line per row and a total.
 * It is the only mode that WRITES — the verification columns, through the
 * app's own db-ops and connection (the report's session stays read-only) —
 * and it needs the server libs, hence `--conditions=react-server`, plus the
 * VM's managed identity to read the container.
 *
 * Exit code 0 = healthy, 1 = the canary is gone, a blob disagrees with its
 * row or a read-back did not match, 2 = refused to run.
 */

import postgres from 'postgres';
import {
  DARTH_MEDIA_ACCOUNT_ENV,
  mediaConfigFromEnv,
  mediaStore,
  type MediaBlobLike,
} from '@/lib/server/media-store';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
function value(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

const CHECK_BLOBS = flag('--check-blobs');
const VERIFY = flag('--verify');
const VERBOSE = flag('--verbose');
const LIMIT = Number(value('--limit') ?? 200);

const explicitPrefix = (value('--schema-prefix') || process.env.SCHEMA_PREFIX || '').trim() || null;
if (!explicitPrefix) {
  console.error(
    'refused: set SCHEMA_PREFIX (env or --schema-prefix <name>) so the schema being read is a choice, not a default.'
  );
  process.exit(2);
}
const SCHEMA = `meeting_whisperer_${explicitPrefix}`;

const sql = postgres({ max: 1, onnotice: () => {} });

function fmtBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${n} B`;
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);

interface TotalRow {
  kind: string;
  archived: number;
  pending: number;
  no_file: number;
  archived_bytes: number;
  pending_bytes: number;
}

interface StageDRow {
  kind: string;
  verified: number;
  unverified: number;
  verify_failed: number;
  evicted: number;
  verified_bytes: number;
  unverified_bytes: number;
  evicted_bytes: number;
}

interface CanaryRow {
  name: string;
  written_at: Date;
  last_ok_at: Date | null;
  missing_at: Date | null;
}

interface ArchivedRow {
  id: string;
  recording_id: string;
  kind: string;
  blob_name: string;
  bytes: number | null;
  sha256: string | null;
}

async function main() {
  await sql.unsafe('SET default_transaction_read_only = on');

  let cfg: ReturnType<typeof mediaConfigFromEnv> = null;
  try {
    cfg = mediaConfigFromEnv();
  } catch (err) {
    console.error(`[media-archive-status] bad ${DARTH_MEDIA_ACCOUNT_ENV} config:`, err);
  }

  console.log('─── media archive status ────────────────────────────────────');
  console.log(`schema            : ${SCHEMA} (read-only)`);
  console.log(
    `media account     : ${cfg ? `${cfg.account} / ${cfg.container}` : `not configured on this host (${DARTH_MEDIA_ACCOUNT_ENV} unset)`}`
  );
  console.log(
    `archive flag      : MW_MEDIA_ARCHIVE=${process.env.MW_MEDIA_ARCHIVE ?? '(unset)'}`
  );
  console.log(
    `blob-first flag   : MW_AAI_FROM_BLOB=${process.env.MW_AAI_FROM_BLOB ?? '(unset)'}`
  );

  // ---- totals -----------------------------------------------------------
  const totals = await sql<TotalRow[]>`
    SELECT kind,
           count(*) FILTER (WHERE blob_name IS NOT NULL)::int AS archived,
           count(*) FILTER (WHERE blob_name IS NULL AND filename IS NOT NULL)::int AS pending,
           count(*) FILTER (WHERE filename IS NULL)::int AS no_file,
           COALESCE(sum(bytes) FILTER (WHERE blob_name IS NOT NULL), 0)::float8 AS archived_bytes,
           COALESCE(sum(bytes) FILTER (WHERE blob_name IS NULL AND filename IS NOT NULL), 0)::float8
             AS pending_bytes
    FROM ${sql(SCHEMA)}.recording_media
    GROUP BY kind
    ORDER BY kind
  `;

  console.log('');
  console.log(
    `  ${pad('kind', 12)}${padL('archived', 9)}${padL('pending', 9)}${padL('no file', 9)}` +
      `${padL('archived bytes', 17)}${padL('pending bytes', 16)}`
  );
  const sum = { archived: 0, pending: 0, no_file: 0, ab: 0, pb: 0 };
  for (const t of totals) {
    sum.archived += t.archived;
    sum.pending += t.pending;
    sum.no_file += t.no_file;
    sum.ab += t.archived_bytes;
    sum.pb += t.pending_bytes;
    console.log(
      `  ${pad(t.kind, 12)}${padL(t.archived, 9)}${padL(t.pending, 9)}${padL(t.no_file, 9)}` +
        `${padL(fmtBytes(t.archived_bytes), 17)}${padL(fmtBytes(t.pending_bytes), 16)}`
    );
  }
  console.log(
    `  ${pad('TOTAL', 12)}${padL(sum.archived, 9)}${padL(sum.pending, 9)}${padL(sum.no_file, 9)}` +
      `${padL(fmtBytes(sum.ab), 17)}${padL(fmtBytes(sum.pb), 16)}`
  );
  console.log(
    '  (pending bytes are what the row last recorded; a row that has never been ' +
      'archived often has none)'
  );

  let bad = 0;

  // ---- Stage D: read-back verification and eviction ---------------------
  const has051 =
    (
      await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = 'recording_media'
          AND column_name IN ('blob_verified_at', 'blob_verify_failed_at', 'local_evicted_at')
      `
    )[0]?.n === 3;
  console.log('');
  if (!has051) {
    console.log('read-back / evict : migration 051 (media_local_eviction) not applied on this schema');
  } else {
    const stageD = await sql<StageDRow[]>`
      SELECT kind,
             count(*) FILTER (WHERE blob_verified_at IS NOT NULL AND blob_verified_sha256 = sha256)::int
               AS verified,
             count(*) FILTER (WHERE blob_verified_at IS NULL AND blob_verify_failed_at IS NULL)::int
               AS unverified,
             count(*) FILTER (WHERE blob_verified_at IS NULL AND blob_verify_failed_at IS NOT NULL)::int
               AS verify_failed,
             count(*) FILTER (WHERE local_evicted_at IS NOT NULL)::int AS evicted,
             COALESCE(sum(bytes) FILTER (WHERE blob_verified_at IS NOT NULL
                                           AND blob_verified_sha256 = sha256), 0)::float8 AS verified_bytes,
             COALESCE(sum(bytes) FILTER (WHERE blob_verified_at IS NULL), 0)::float8 AS unverified_bytes,
             COALESCE(sum(bytes) FILTER (WHERE local_evicted_at IS NOT NULL), 0)::float8 AS evicted_bytes
      FROM ${sql(SCHEMA)}.recording_media
      WHERE blob_name IS NOT NULL
      GROUP BY kind
      ORDER BY kind
    `;
    console.log(
      `  ${pad('kind', 12)}${padL('verified', 9)}${padL('unverif.', 9)}${padL('failed', 8)}${padL('evicted', 9)}` +
        `${padL('verified bytes', 16)}${padL('unverif. bytes', 16)}${padL('evicted bytes', 15)}`
    );
    const t = { v: 0, u: 0, f: 0, e: 0, vb: 0, ub: 0, eb: 0 };
    for (const r of stageD) {
      t.v += r.verified;
      t.u += r.unverified;
      t.f += r.verify_failed;
      t.e += r.evicted;
      t.vb += r.verified_bytes;
      t.ub += r.unverified_bytes;
      t.eb += r.evicted_bytes;
      console.log(
        `  ${pad(r.kind, 12)}${padL(r.verified, 9)}${padL(r.unverified, 9)}${padL(r.verify_failed, 8)}${padL(r.evicted, 9)}` +
          `${padL(fmtBytes(r.verified_bytes), 16)}${padL(fmtBytes(r.unverified_bytes), 16)}${padL(fmtBytes(r.evicted_bytes), 15)}`
      );
    }
    console.log(
      `  ${pad('TOTAL', 12)}${padL(t.v, 9)}${padL(t.u, 9)}${padL(t.f, 8)}${padL(t.e, 9)}` +
        `${padL(fmtBytes(t.vb), 16)}${padL(fmtBytes(t.ub), 16)}${padL(fmtBytes(t.eb), 15)}`
    );
    console.log(
      `read-back         : verified ${t.v}/${t.v + t.u + t.f}` +
        (t.f > 0 ? ` — ${t.f} DID NOT MATCH (a human decides; the local file, if present, is the truth)` : '')
    );
    console.log(
      `evicted           : ${t.e} local cop${t.e === 1 ? 'y' : 'ies'} removed by Stage D (MW_MEDIA_EVICT=${process.env.MW_MEDIA_EVICT ?? '(unset)'}); ` +
        'a missing local file on these rows is the normal state'
    );
    if (t.f > 0) {
      bad += t.f;
      const failed = await sql<
        Array<{ id: string; kind: string; blob_name: string; blob_verify_failed_at: Date; blob_verify_error: string | null }>
      >`
        SELECT id, kind, blob_name, blob_verify_failed_at, blob_verify_error
        FROM ${sql(SCHEMA)}.recording_media
        WHERE blob_name IS NOT NULL AND blob_verified_at IS NULL AND blob_verify_failed_at IS NOT NULL
        ORDER BY blob_verify_failed_at DESC
        LIMIT 50
      `;
      for (const r of failed) {
        console.log(
          `  FAILED ${pad(r.blob_name, 48)} ${r.kind} ${r.blob_verify_failed_at.toISOString()} ${r.blob_verify_error ?? ''}`
        );
      }
    }
  }

  // ---- the canary (spec Stage A.4) --------------------------------------
  console.log('');
  const canaries = await sql<CanaryRow[]>`
    SELECT name, written_at, last_ok_at, missing_at
    FROM ${sql(SCHEMA)}.media_archive_canaries
    ORDER BY written_at
  `.catch(() => null);
  if (!canaries) {
    console.log('canary            : migration 047 not applied on this schema');
  } else if (canaries.length === 0) {
    console.log('canary            : none yet (nothing has been archived on this host)');
  } else {
    const gone = canaries.filter((c) => c.missing_at);
    for (const c of canaries) {
      const age = ((Date.now() - c.written_at.getTime()) / 3_600_000).toFixed(1);
      console.log(
        `  ${pad(c.name, 22)} written ${c.written_at.toISOString()} (${age} h ago)` +
          (c.missing_at ? `  MISSING since ${c.missing_at.toISOString()}` : '') +
          (c.last_ok_at ? `  last seen ${c.last_ok_at.toISOString()}` : '')
      );
    }
    if (gone.length > 0) {
      bad += gone.length;
      console.log('canary            : CANARY GONE — archiving is stopped.');
      console.log(
        '                    A blob nobody touched was deleted: check the account\'s lifecycle rules\n' +
          '                    (`az storage account management-policy show`). Once the rule is gone, clear it with\n' +
          `                    UPDATE ${SCHEMA}.media_archive_canaries SET missing_at = NULL;`
      );
    } else {
      console.log('canary            : CANARY OK');
    }
  }

  // ---- the delete queue -------------------------------------------------
  const pendingDeletes = await sql<Array<{ n: number; oldest: Date | null; stuck: number }>>`
    SELECT count(*)::int AS n, min(queued_at) AS oldest,
           count(*) FILTER (WHERE attempts >= 5)::int AS stuck
    FROM ${sql(SCHEMA)}.media_blob_deletes
  `.catch(() => null);
  if (pendingDeletes) {
    const p = pendingDeletes[0]!;
    console.log(
      `blobs to delete   : ${p.n}` +
        (p.oldest ? ` (oldest queued ${p.oldest.toISOString()})` : '') +
        (p.stuck > 0 ? `, ${p.stuck} with ≥ 5 failed attempts` : '')
    );
    if (VERBOSE && p.n > 0) {
      const rows = await sql<Array<{ blob_name: string; attempts: number; last_error: string | null }>>`
        SELECT blob_name, attempts, last_error
        FROM ${sql(SCHEMA)}.media_blob_deletes
        ORDER BY attempts DESC, queued_at
        LIMIT 20
      `;
      for (const r of rows) {
        console.log(`  ${pad(r.blob_name, 48)} attempts ${r.attempts} ${r.last_error ?? ''}`);
      }
    }
  }

  // ---- blob before local (DEC-3 Stage C) --------------------------------
  // A recording whose bytes went to AssemblyAI straight from the blob has no
  // local copy until the background fetch lands one. That is NOT drift and
  // never touches the exit code — but a row still waiting hours later means
  // the fetch (and its per-tick sweeper retry) is failing, so it is counted
  // here rather than left to be discovered by a 404 on playback.
  const blobFirst = await sql<Array<{ total: number; pending: number; stale: number; remuxed: number }>>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE gmeet_context->'blobFirst'->>'landedAt' IS NULL)::int AS pending,
           count(*) FILTER (WHERE gmeet_context->'blobFirst'->>'landedAt' IS NULL
                              AND created_at < now() - interval '6 hours')::int AS stale,
           count(*) FILTER (WHERE (gmeet_context->'blobFirst'->>'remuxed') = 'true')::int AS remuxed
    FROM ${sql(SCHEMA)}.transcripts
    WHERE deleted_at IS NULL AND gmeet_context->'blobFirst' IS NOT NULL
  `.catch(() => null);
  if (blobFirst?.[0] && blobFirst[0].total > 0) {
    const b = blobFirst[0];
    console.log(
      `blob before local : ${b.total} recording(s) reached AssemblyAI from the blob; ` +
        `${b.pending} still waiting for their local copy` +
        (b.stale > 0 ? `, ${b.stale} of them older than 6 h — CHECK THE LOG` : '') +
        (b.remuxed > 0 ? ` (${b.remuxed} re-archived after a faststart remux)` : '')
    );
  }

  // ---- --check-blobs ----------------------------------------------------
  if (CHECK_BLOBS) {
    console.log('');
    const store: MediaBlobLike | null = mediaStore();
    if (!store) {
      console.log(`--check-blobs     : skipped — ${DARTH_MEDIA_ACCOUNT_ENV} is not set on this host`);
    } else {
      const rows = await sql<ArchivedRow[]>`
        SELECT id, recording_id, kind, blob_name, bytes::float8 AS bytes, sha256
        FROM ${sql(SCHEMA)}.recording_media
        WHERE blob_name IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ${LIMIT}
      `;
      let ok = 0;
      const problems: string[] = [];
      for (const r of rows) {
        const props = await store.properties(r.blob_name).catch((e) => {
          problems.push(`${r.blob_name}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (!props) {
          problems.push(`${r.blob_name}: NOT IN THE CONTAINER (row ${r.id} says it is archived)`);
          continue;
        }
        if (r.bytes != null && props.bytes !== r.bytes) {
          problems.push(`${r.blob_name}: blob is ${props.bytes} B, row says ${r.bytes} B`);
          continue;
        }
        if (r.sha256 && props.metadata.sha256 !== r.sha256) {
          problems.push(
            `${r.blob_name}: blob metadata sha256 ${props.metadata.sha256 ?? '(none)'}, row says ${r.sha256}`
          );
          continue;
        }
        ok += 1;
        if (VERBOSE) console.log(`  OK ${pad(r.blob_name, 48)} ${fmtBytes(props.bytes)} ${r.kind}`);
      }
      console.log(`--check-blobs     : ${ok}/${rows.length} newest archived blobs match their row`);
      for (const p of problems) console.log(`  ${p}`);
      bad += problems.length;
    }
  }

  // ---- --verify: the fast drain of the read-back (Stage D) --------------
  if (VERIFY) {
    console.log('');
    if (!has051) {
      console.log('--verify          : skipped — migration 051 is not applied on this schema');
    } else if (!mediaStore()) {
      console.log(`--verify          : skipped — ${DARTH_MEDIA_ACCOUNT_ENV} is not set on this host`);
    } else {
      bad += await runVerify();
    }
  }

  console.log('─────────────────────────────────────────────────────────────');
  await sql.end();
  process.exit(bad > 0 ? 1 : 0);
}

/**
 * `--verify`: the sweeper's read-back, run synchronously over every row still
 * to verify (or `--limit N` of them). Imported lazily: the report above must
 * keep working as a plain `bun run` with no server libs and no app env, and
 * only this mode needs them. `SCHEMA_PREFIX` is already in the env (checked
 * at the top), so the app's db layer reads the same schema.
 */
async function runVerify(): Promise<number> {
  process.env.SCHEMA_PREFIX = explicitPrefix!;
  const { verifyArchivedBlob, fmtBytes: fmt } = await import('@/lib/server/media-archive');
  const { listMediaToVerify } = await import('@/db-ops/recordings');
  const { sql: appSql } = await import('@/lib/db');
  const limit = value('--limit') ? LIMIT : 1_000_000;
  const rows = await listMediaToVerify(limit);
  console.log(`--verify          : ${rows.length} blob(s) to read back`);
  let ok = 0;
  let mismatch = 0;
  let skipped = 0;
  let bytes = 0;
  const started = Date.now();
  for (const r of rows) {
    const out = await verifyArchivedBlob(r);
    if (out.status === 'verified') {
      ok += 1;
      bytes += out.bytes;
      console.log(`  OK       ${pad(r.blob_name ?? '', 48)} ${pad(r.kind, 11)} ${fmt(out.bytes)} ${(out.ms / 1000).toFixed(1)}s`);
    } else if (out.status === 'mismatch') {
      mismatch += 1;
      console.log(`  MISMATCH ${pad(r.blob_name ?? '', 48)} ${pad(r.kind, 11)} ${out.error}`);
    } else {
      skipped += 1;
      console.log(`  SKIPPED  ${pad(r.blob_name ?? '', 48)} ${pad(r.kind, 11)} ${out.reason}`);
    }
  }
  console.log(
    `--verify          : ${ok} verified (${fmt(bytes)} in ${((Date.now() - started) / 1000).toFixed(0)}s), ` +
      `${mismatch} MISMATCH, ${skipped} skipped`
  );
  await appSql.end();
  return mismatch;
}

main().catch(async (err) => {
  console.error('[media-archive-status] failed:', err);
  await sql.end();
  process.exit(2);
});
