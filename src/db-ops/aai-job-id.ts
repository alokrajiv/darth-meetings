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
 *      and these fragments must agree exactly: `aai_job_id` when set, else a
 *      UUID-shaped `assemblyai_id` (a row that predates 1b), else nothing.
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
   * For a projection. Either the column itself or, when 045 has not been
   * applied, a NULL of the right type under the same name — so `aaiJobIdOf()`
   * sees `null` and falls back to the meeting id, exactly as for a legacy row.
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
  const legacy = (): Fragment =>
    alias === 't'
      ? sql`CASE WHEN t.assemblyai_id ~* ${AAI_JOB_ID_RE.source} THEN t.assemblyai_id END`
      : sql`CASE WHEN assemblyai_id ~* ${AAI_JOB_ID_RE.source} THEN assemblyai_id END`;
  const expr = (): Fragment => {
    if (!present) return legacy();
    return alias === 't' ? sql`COALESCE(t.aai_job_id, ${legacy()})` : sql`COALESCE(aai_job_id, ${legacy()})`;
  };
  return {
    column: present
      ? alias === 't'
        ? sql`t.aai_job_id`
        : sql`aai_job_id`
      : sql`NULL::text AS aai_job_id`,
    expr: expr(),
    expr2: expr(),
  };
}
