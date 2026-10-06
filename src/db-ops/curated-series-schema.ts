import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Is migration 053 (curated series) applied? Probed once per process like
 * db-ops/share-origin.ts and db-ops/auditor-shares.ts: cached on globalThis
 * (Next bundles a module once per route graph), never at module scope
 * (`bun run build` runs with no database), and a FAILED probe is not cached
 * — a DB hiccup must not switch the feature off for the process.
 *
 * Until it is applied, nothing curated runs: no membership writes, no
 * default labels (030's one-rule-per-series index would refuse a second
 * label), no follow shares (there is no follower table and no ledger
 * origin). Reads degrade to the columns that exist (no patterns, priority
 * 100), so a deploy that lands before the migration still serves /series.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

const g = globalThis as unknown as { __mwCuratedSeries053?: Promise<boolean> };

export function curatedSeriesReady(): Promise<boolean> {
  return (g.__mwCuratedSeries053 ??= (async () => {
    const rows = await sql<Array<{ patterns: number; followers: number; ledger_origin: number }>>`
      SELECT
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = ${SCHEMA} AND table_name = 'series'
            AND column_name = 'patterns') AS patterns,
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = ${SCHEMA} AND table_name = 'series_followers') AS followers,
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = ${SCHEMA} AND table_name = 'auditor_share_removals'
            AND column_name = 'origin') AS ledger_origin
    `;
    const r = rows[0];
    const ready = !!r && r.patterns > 0 && r.followers > 0 && r.ledger_origin > 0;
    if (!ready) {
      console.warn(
        '[curated-series] schema missing — apply migrations/053_curated_series.sql; ' +
          'series membership, default labels and follow shares stay off until then'
      );
    }
    return ready;
  })().catch((err) => {
    g.__mwCuratedSeries053 = undefined;
    throw err;
  }));
}

/** Route answer while 053 is missing (the write would have nowhere to go). */
export const CURATED_SERIES_NOT_READY =
  'Curated series are not switched on yet (migration 053 has not been applied)';
