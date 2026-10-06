import 'server-only';
import { listFollowers, type SeriesFollower } from '@/db-ops/series-followers';
import { listSeriesLabelRules } from '@/lib/server/series-labels';
import { resolveOrCreatePath, type LabelActor } from '@/db-ops/labels';
import { publishEvent } from '@/lib/server/event-bus';
import { LabelPathError } from '@/lib/labels';
import { seriesPermissions, type SeriesPermissions } from '@/lib/series-permissions';
import type { SeriesRow } from '@/db-ops/series';

/**
 * What the series routes serve about a series beyond its row: its default
 * labels, its followers, and what THIS caller may do with it (the dialog
 * greys out the rest; the routes enforce the same rules).
 *
 * Everyone sees every series — name, description, patterns, labels,
 * followers, auto-import status (spec §6). Nothing here names a meeting.
 */

export interface SeriesLabelRef {
  id: number;
  path: string;
  name: string;
  color: string | null;
}

export interface SeriesDecorations {
  labels: SeriesLabelRef[];
  followers: Array<Pick<SeriesFollower, 'email' | 'name' | 'added_by_email' | 'added_at'>>;
  permissions: SeriesPermissions;
}

export async function decorateSeries(
  rows: ReadonlyArray<Pick<SeriesRow, 'id' | 'created_by'>>,
  caller: { userId: string; email: string }
): Promise<Map<number, SeriesDecorations>> {
  const ids = rows.map((r) => r.id);
  const [rules, followers] = await Promise.all([listSeriesLabelRules(ids), listFollowers(ids)]);
  const out = new Map<number, SeriesDecorations>();
  for (const r of rows) {
    const mine = followers.filter((f) => f.series_id === r.id);
    out.set(r.id, {
      labels: rules
        .filter((x) => Number(x.value) === r.id)
        .map((x) => ({ id: x.label_id, path: x.path, name: x.name, color: x.color })),
      followers: mine.map((f) => ({
        email: f.email,
        name: f.name,
        added_by_email: f.added_by_email,
        added_at: f.added_at,
      })),
      permissions: seriesPermissions(
        { createdBy: r.created_by, followerEmails: mine.map((f) => f.email) },
        caller
      ),
    });
  }
  return out;
}

export function parseSeriesId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export class SeriesInputError extends Error {}

/**
 * Default labels arrive as PATHS ("Team/Data", "AM Briefing/Jacq"); a path
 * that does not exist is created with its missing parents, exactly like the
 * labels API does. Returns the label ids in input order, de-duplicated.
 */
export async function resolveLabelPaths(paths: unknown, actor: LabelActor): Promise<number[]> {
  if (!Array.isArray(paths)) throw new SeriesInputError('labels must be a list of label paths');
  if (paths.length > 10) throw new SeriesInputError('at most 10 default labels per series');
  const ids: number[] = [];
  let created = false;
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new SeriesInputError('each label must be a path like "Team/Data"');
    }
    try {
      const r = await resolveOrCreatePath(raw.trim(), actor);
      if (r.created.length > 0) created = true;
      if (!ids.includes(r.label.id)) ids.push(r.label.id);
    } catch (err) {
      if (err instanceof LabelPathError) throw new SeriesInputError(`label "${raw}": ${err.message}`);
      throw err;
    }
  }
  if (created) publishEvent({ kind: 'labels' });
  return ids;
}

/** Description: one line, trimmed, ≤ 300 chars; '' clears. */
export function parseDescription(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new SeriesInputError('description must be text');
  const v = raw.replace(/\s+/g, ' ').trim();
  if (v.length > 300) throw new SeriesInputError('description: at most 300 characters');
  return v || null;
}

export function parsePriority(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 1000) {
    throw new SeriesInputError('priority must be a whole number from 0 to 1000 (lower wins)');
  }
  return raw;
}

export function parseTitle(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new SeriesInputError('name is required');
  const v = raw.trim();
  if (v.length > 120) throw new SeriesInputError('name: at most 120 characters');
  return v;
}
