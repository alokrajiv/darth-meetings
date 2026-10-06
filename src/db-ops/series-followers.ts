import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Series followers (migration 053, docs/curated-series-spec.md §5): people
 * who get a read share of every meeting in a series, past and future.
 *
 * Plain rows. The shares themselves are written and taken back by the
 * membership engine (lib/server/curated-series.ts), and WHO may add or
 * remove a follower is lib/series-permissions.ts — following grants read
 * access to other people's meetings, so it is an auditor's act. Everyone may
 * SEE who follows a series (spec §6).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface SeriesFollower {
  series_id: number;
  /** Lower-cased. */
  email: string;
  name: string | null;
  added_by_email: string;
  added_at: string;
}

export async function listFollowers(seriesIds: number[]): Promise<SeriesFollower[]> {
  if (seriesIds.length === 0) return [];
  return sql<SeriesFollower[]>`
    SELECT series_id, email, name, added_by_email, added_at::text AS added_at
    FROM ${sql(SCHEMA)}.series_followers
    WHERE series_id = ANY(${seriesIds}::int[])
    ORDER BY series_id, email
  `;
}

/** true = newly added (false: already following). */
export async function insertFollower(
  seriesId: number,
  person: { email: string; name: string | null },
  by: { userId: string; email: string }
): Promise<boolean> {
  const rows = await sql<Array<{ email: string }>>`
    INSERT INTO ${sql(SCHEMA)}.series_followers
      (series_id, email, name, added_by_user_id, added_by_email)
    VALUES (
      ${seriesId}, ${person.email.trim().toLowerCase()}, ${person.name},
      ${by.userId}, ${by.email.trim().toLowerCase()}
    )
    ON CONFLICT (series_id, email) DO NOTHING
    RETURNING email
  `;
  return rows.length > 0;
}

/** true = they were following. */
export async function deleteFollower(seriesId: number, email: string): Promise<boolean> {
  const rows = await sql<Array<{ email: string }>>`
    DELETE FROM ${sql(SCHEMA)}.series_followers
    WHERE series_id = ${seriesId} AND email = ${email.trim().toLowerCase()}
    RETURNING email
  `;
  return rows.length > 0;
}

/** Ids of the series that have at least one follower (the matcher ranks them
 * first — lib/series-patterns compareSeriesPrecedence). */
export async function followedSeriesIds(): Promise<Set<number>> {
  const rows = await sql<Array<{ series_id: number }>>`
    SELECT DISTINCT series_id FROM ${sql(SCHEMA)}.series_followers
  `;
  return new Set(rows.map((r) => r.series_id));
}
