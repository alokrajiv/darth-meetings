import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { AAI_JOB_ID_RE } from '@/lib/aai-job-state';

/**
 * `transcripts.aai_job_id` (migration 045) — the column, and the flag that
 * decides whether new meetings take an id we mint (Phase 1b,
 * docs/recordings-phase1b-spec.md §3/§4).
 *
 * Two things live here because they are the same concern:
 *
 *   1. **Does the column exist?** A server deployed before 045 is applied
 *      would break every upload on the first statement that names the column,
 *      so it is probed once per process (cached promise) and every writer and
 *      every projection asks first. When it is missing, the job-id writes are
 *      skipped, the SQL twins fall back to the pre-1b expression, and minting
 *      is forced OFF — a minted row with nowhere to record its job id would
 *      be a row we could never poll and never delete at AssemblyAI.
 *   2. **The SQL twins of `aaiJobIdOf`.** The JS accessor (@/lib/aai-job-state)
 *      and these fragments must agree exactly: when the column EXISTS it is
 *      the whole answer — NULL means no job, never "try the meeting id"
 *      (045 stamped every legacy row, so the only UUID-shaped rows left with
 *      a NULL are meetings whose id we minted: made early from a recording,
 *      split off another meeting; asking AssemblyAI about one of those 404s
 *      and the 404 flips the meeting to 'error' — prod, 2026-10-02). Only
 *      when the column is MISSING is a UUID-shaped `assemblyai_id` the job
 *      (pre-1b, minting forced off).
 *
 * Both are read lazily, never at module scope: `bun run build` must succeed
 * with no environment and no database at all.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

type Fragment = ReturnType<typeof sql>;

// globalThis, not module scope: Next bundles this module once per route
// graph, and each copy would otherwise run its own probe.
const g = globalThis as unknown as { __mwAaiJobIdColumn?: Promise<boolean> };

/**
 * `true` when migration 045 has been applied to this schema. Probed once; a
 * FAILED probe is not cached (a DB hiccup must not disable the column for the
 * life of the process).
 */
export function aaiJobIdColumnExists(): Promise<boolean> {
  return (g.__mwAaiJobIdColumn ??= (async () => {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM information_schema.columns
      WHERE table_schema = ${SCHEMA}
        AND table_name = 'transcripts'
        AND column_name = 'aai_job_id'
    `;
    const present = (rows[0]?.n ?? 0) > 0;
    if (!present) {
      console.warn(
        '[aai-job-id] column missing — apply migrations/045_aai_job_id.sql; ' +
          'job ids are being read from UUID-shaped meeting ids and MW_MINTED_IDS is forced off'
      );
    }
    return present;
  })().catch((err) => {
    g.__mwAaiJobIdColumn = undefined;
    throw err;
  }));
}

/**
 * Phase 1b's flag. Lazy per call (a pm2 restart flips it, not a rebuild) and
 * AND-ed with the column: minting without somewhere to put the job id would
 * strand the row.
 */
export async function mintedIdsEnabled(): Promise<boolean> {
  const raw = process.env.MW_MINTED_IDS;
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return false;
  return aaiJobIdColumnExists();
}

export interface JobIdSql {
  /**
   * For a projection, always named `aai_job_id`. Either the column itself or,
   * when 045 has not been applied, the pre-1b answer (the UUID-shaped meeting
   * id) under that name — so `aaiJobIdOf()` reads a resolved value either way
   * and a NULL in it always means "no job".
   */
  column: Fragment;
  /**
   * The SQL twin of `aaiJobIdOf(row)`: the job id this row belongs to, or
   * NULL. For WHERE clauses, and wherever the resolved value is what the
   * caller needs.
   */
  expr: Fragment;
  /** A second `expr`, for queries that need it in both SELECT and WHERE. */
  expr2: Fragment;
}

/**
 * The fragments, for the given table alias. One `await` per query; the
 * fragments themselves are plain objects, so a caller interpolates them like
 * any other value.
 */
export async function jobIdSql(alias: 't' | null = null): Promise<JobIdSql> {
  const present = await aaiJobIdColumnExists();
  return jobIdFragments(present, alias);
}

/** `jobIdSql` with the probe already answered — exported for the tests. */
export function jobIdFragments(present: boolean, alias: 't' | null = null): JobIdSql {
  const legacy = (): Fragment =>
    alias === 't'
      ? sql`CASE WHEN t.assemblyai_id ~* ${AAI_JOB_ID_RE.source} THEN t.assemblyai_id END`
      : sql`CASE WHEN assemblyai_id ~* ${AAI_JOB_ID_RE.source} THEN assemblyai_id END`;
  // Column present ⇒ the column, and nothing else — never COALESCEd with the
  // legacy expression: that fallback is what polled a minted meeting id at
  // AssemblyAI on 2026-10-02 (see the header).
  const expr = (): Fragment =>
    present ? (alias === 't' ? sql`t.aai_job_id` : sql`aai_job_id`) : legacy();
  return {
    column: present
      ? alias === 't'
        ? sql`t.aai_job_id`
        : sql`aai_job_id`
      : sql`${legacy()} AS aai_job_id`,
    expr: expr(),
    expr2: expr(),
  };
}
