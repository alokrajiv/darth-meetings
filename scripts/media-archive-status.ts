/**
 * Where the media archive has got to — READ ONLY.
 *
 * Counts what `recording_media` says (archived / still to copy / nothing to
 * copy, by kind and in bytes), prints the lifecycle canary's verdict and the
 * queue of blobs waiting to be deleted. This is the totals line the sweeper's
 * per-tick log deliberately does not print (docs/recordings-blob-spec.md,
 * Stage A.3/A.4).
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
 * Exit code 0 = healthy, 1 = the canary is gone or a blob disagrees with its
 * row, 2 = refused to run.
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

  console.log('─────────────────────────────────────────────────────────────');
  await sql.end();
  process.exit(bad > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[media-archive-status] failed:', err);
  await sql.end();
  process.exit(2);
});
