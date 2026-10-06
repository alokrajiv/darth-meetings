import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Series editors (migration 054, docs/curated-series-spec.md §11.1): people
 * who may edit a series' definition and manage its editors and followers —
 * never transfer or delete it. Plain rows; WHO may add or remove one is
 * lib/series-permissions.ts (owner + editors; on an auditor-owned series the
 * editor must be an auditor too).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface SeriesEditor {
  series_id: number;
  /** Lower-cased. */
  email: string;
  name: string | null;
  added_by_email: string;
  added_at: string;
}

export async function listEditors(seriesIds: number[]): Promise<SeriesEditor[]> {
  if (seriesIds.length === 0) return [];
  return sql<SeriesEditor[]>`
    SELECT series_id, email, name, added_by_email, added_at::text AS added_at
    FROM ${sql(SCHEMA)}.series_editors
    WHERE series_id = ANY(${seriesIds}::int[])
    ORDER BY series_id, email
  `;
}

/** Every editor row (the matcher cache — a small table). */
export async function listAllEditors(): Promise<SeriesEditor[]> {
  return sql<SeriesEditor[]>`
    SELECT series_id, email, name, added_by_email, added_at::text AS added_at
    FROM ${sql(SCHEMA)}.series_editors
    ORDER BY series_id, email
  `;
}

/** true = newly added. */
export async function insertEditor(
  seriesId: number,
  person: { email: string; name: string | null },
  byEmail: string
): Promise<boolean> {
  const rows = await sql<Array<{ email: string }>>`
    INSERT INTO ${sql(SCHEMA)}.series_editors (series_id, email, name, added_by_email)
    VALUES (${seriesId}, ${person.email.trim().toLowerCase()}, ${person.name}, ${byEmail.trim().toLowerCase()})
    ON CONFLICT (series_id, email) DO NOTHING
    RETURNING email
  `;
  return rows.length > 0;
}

/** true = they were an editor. */
export async function deleteEditor(seriesId: number, email: string): Promise<boolean> {
  const rows = await sql<Array<{ email: string }>>`
    DELETE FROM ${sql(SCHEMA)}.series_editors
    WHERE series_id = ${seriesId} AND email = ${email.trim().toLowerCase()}
    RETURNING email
  `;
  return rows.length > 0;
}
