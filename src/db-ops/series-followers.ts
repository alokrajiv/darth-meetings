import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Series followers (migration 053, docs/curated-series-spec.md §5): people
 * who get a read share of every meeting in a series, past and future.
 *
 * Plain rows. The shares themselves are written and taken back by the
 * membership engine (lib/server/curated-series.ts) — only for members the
 * series' OWNER may share (§11.4) — and WHO may add or remove a follower is
 * lib/series-permissions.ts (owner + editors; a follower removes themselves).
 * Only people who can see the series see who follows it (§11.6).
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

/** Every follower row (the matcher cache — a small table). */
export async function listAllFollowers(): Promise<SeriesFollower[]> {
  return sql<SeriesFollower[]>`
    SELECT series_id, email, name, added_by_email, added_at::text AS added_at
    FROM ${sql(SCHEMA)}.series_followers
    ORDER BY series_id, email
  `;
}
