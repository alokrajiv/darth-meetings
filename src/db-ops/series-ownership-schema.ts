import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { curatedSeriesReady } from '@/db-ops/curated-series-schema';

/**
 * Is migration 054 (series ownership + the auditors table) applied?
 * docs/curated-series-spec.md §11.8.
 *
 * Probed like db-ops/curated-series-schema.ts — on globalThis, never at module
 * scope (`bun run build` has no database), a FAILED probe not cached — with
 * one difference: a NEGATIVE answer is re-probed after a minute, because 054
 * is applied AFTER a deploy may already be running (the rollout order is
 * 054 → deploy → 055, but a deploy that lands first must switch itself on
 * without a restart).
 *
 * Until it is applied:
 *  - there is no owner, so no reach (§11.2) — the matcher writes nothing and
 *    every series write route answers 503;
 *  - nobody can be told they may see a series (§11.6) — reads serve none;
 *  - there is no auditors table — `loadAuditors()` is empty, so auditor
 *    auto-shares pause (never re-added wrongly: the share writer is a no-op).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const NEGATIVE_TTL_MS = 60_000;

export interface OwnershipSchema {
  /** series.owner_email + series_editors (054). */
  ownership: boolean;
  /** The auditors table (054). */
  auditors: boolean;
}

const g = globalThis as unknown as {
  __mwSeries054?: { at: number; p: Promise<OwnershipSchema> };
};

export function probeOwnershipSchema(): Promise<OwnershipSchema> {
  const hit = g.__mwSeries054;
  if (hit) return hit.p;
  const p = (async () => {
    const rows = await sql<Array<{ owner_email: number; editors: number; auditors: number }>>`
      SELECT
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = ${SCHEMA} AND table_name = 'series'
            AND column_name = 'owner_email') AS owner_email,
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = ${SCHEMA} AND table_name = 'series_editors') AS editors,
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = ${SCHEMA} AND table_name = 'auditors') AS auditors
    `;
    const r = rows[0];
    const out: OwnershipSchema = {
      ownership: !!r && r.owner_email > 0 && r.editors > 0,
      auditors: !!r && r.auditors > 0,
    };
    if (!out.ownership || !out.auditors) {
      console.warn(
        '[series-ownership] schema missing — apply migrations/054_series_ownership.sql; ' +
          'series stay read-only/invisible and auditor auto-shares pause until then'
      );
      // Re-probe after a minute (054 lands after the deploy).
      setTimeout(() => {
        if (g.__mwSeries054?.p === p) g.__mwSeries054 = undefined;
      }, NEGATIVE_TTL_MS).unref?.();
    }
    return out;
  })().catch((err) => {
    if (g.__mwSeries054?.p === p) g.__mwSeries054 = undefined;
    throw err;
  });
  g.__mwSeries054 = { at: Date.now(), p };
  return p;
}

/** 053 + 054 both applied: owners exist, the v2 engine and routes may run. */
export async function seriesOwnershipReady(): Promise<boolean> {
  if (!(await curatedSeriesReady())) return false;
  return (await probeOwnershipSchema()).ownership;
}

/** Route answer while 053/054 is missing. */
export const SERIES_OWNERSHIP_NOT_READY =
  'Series are not switched on yet (migrations 053/054 have not been applied)';
