import 'server-only';
import { listFollowers, type SeriesFollower } from '@/db-ops/series-followers';
import { listEditors, type SeriesEditor } from '@/db-ops/series-editors';
import { getSeries, type SeriesRow } from '@/db-ops/series';
import { auditorEmails } from '@/db-ops/auditors';
import { identitiesForUsers } from '@/db-ops/transcript-activity';
import { seriesOwnershipReady } from '@/db-ops/series-ownership-schema';
import { listSeriesLabelRules } from '@/lib/server/series-labels';
import { resolveOrCreatePath, type LabelActor } from '@/db-ops/labels';
import { publishEvent } from '@/lib/server/event-bus';
import { LabelPathError } from '@/lib/labels';
import { INTERNAL_DOMAINS } from '@/lib/internal-domains';
import type { GmeetContext } from '@/lib/format';
import {
  seriesPermissions,
  type SeriesPermissions,
  type SeriesRoleFacts,
} from '@/lib/series-permissions';

/**
 * What the series routes serve about a series beyond its row — its owner,
 * editors, followers, default labels, and what THIS caller may do with it —
 * and THE gate every `/api/series/:id…` route runs first (`seriesForCaller`):
 * a series the caller cannot see (§11.6: not its owner, an editor, a
 * follower or an auditor) does not exist for them → 404, exactly like a
 * missing id. Nothing here names a meeting.
 */

export interface SeriesLabelRef {
  id: number;
  path: string;
  name: string;
  color: string | null;
}

export type SeriesPersonView = Pick<SeriesFollower, 'email' | 'name' | 'added_by_email' | 'added_at'>;

export interface SeriesDecorations {
  owner: { email: string | null; name: string | null; isAuditor: boolean };
  editors: SeriesPersonView[];
  labels: SeriesLabelRef[];
  followers: SeriesPersonView[];
  permissions: SeriesPermissions;
}

export interface SeriesCaller {
  userId: string;
  email: string;
}

const person = (p: SeriesFollower | SeriesEditor): SeriesPersonView => ({
  email: p.email,
  name: p.name,
  added_by_email: p.added_by_email,
  added_at: p.added_at,
});

export function roleFactsOf(
  row: Pick<SeriesRow, 'owner_email' | 'owner_user_id'>,
  editors: ReadonlyArray<{ email: string }>,
  followers: ReadonlyArray<{ email: string }>,
  auditors: ReadonlySet<string>
): SeriesRoleFacts {
  return {
    ownerEmail: row.owner_email,
    ownerUserId: row.owner_user_id,
    ownerIsAuditor: !!row.owner_email && auditors.has(row.owner_email),
    editorEmails: editors.map((e) => e.email.toLowerCase()),
    followerEmails: followers.map((f) => f.email.toLowerCase()),
  };
}

/** Owner, editors, followers, labels and the caller's permissions for each
 * row. Callers pass only rows the caller may see (listSeries filters; the
 * detail routes run seriesForCaller first). Needs 054. */
export async function decorateSeries(
  rows: ReadonlyArray<Pick<SeriesRow, 'id' | 'owner_email' | 'owner_user_id'>>,
  caller: SeriesCaller,
  auditors?: ReadonlySet<string>
): Promise<Map<number, SeriesDecorations>> {
  const ids = rows.map((r) => r.id);
  const [rules, followers, editors, aud, names] = await Promise.all([
    listSeriesLabelRules(ids),
    listFollowers(ids),
    listEditors(ids),
    auditors ? Promise.resolve(auditors) : auditorEmails(),
    identitiesForUsers(rows.map((r) => r.owner_user_id).filter((x): x is string => !!x)).catch(
      () => new Map<string, { name: string | null }>()
    ),
  ]);
  const callerIsAuditor = aud.has(caller.email.trim().toLowerCase());
  const out = new Map<number, SeriesDecorations>();
  for (const r of rows) {
    const myFollowers = followers.filter((f) => f.series_id === r.id);
    const myEditors = editors.filter((e) => e.series_id === r.id);
    const facts = roleFactsOf(r, myEditors, myFollowers, aud);
    out.set(r.id, {
      owner: {
        email: r.owner_email,
        name: (r.owner_user_id ? names.get(r.owner_user_id)?.name : null) ?? null,
        isAuditor: facts.ownerIsAuditor,
      },
      editors: myEditors.map(person),
      labels: rules
        .filter((x) => Number(x.value) === r.id)
        .map((x) => ({ id: x.label_id, path: x.path, name: x.name, color: x.color })),
      followers: myFollowers.map(person),
      permissions: seriesPermissions(facts, {
        callerEmail: caller.email,
        callerUserId: caller.userId,
        callerIsAuditor,
      }),
    });
  }
  return out;
}

export interface SeriesForCaller {
  series: SeriesRow;
  deco: SeriesDecorations;
  facts: SeriesRoleFacts;
  auditors: ReadonlySet<string>;
  callerIsAuditor: boolean;
}

/**
 * THE per-series gate (§11.6): the series with everything the routes need,
 * or null when it does not exist OR the caller may not see it — the route
 * answers 404 either way, so an id probe learns nothing. Also null before
 * 054 (no owners → nobody can be shown a series).
 */
export async function seriesForCaller(id: number, caller: SeriesCaller): Promise<SeriesForCaller | null> {
  if (!(await seriesOwnershipReady().catch(() => false))) return null;
  const series = await getSeries(id);
  if (!series) return null;
  const auditors = await auditorEmails();
  const deco = (await decorateSeries([series], caller, auditors)).get(id)!;
  if (!deco.permissions.see) return null;
  const facts = roleFactsOf(series, deco.editors, deco.followers, auditors);
  return {
    series,
    deco,
    facts,
    auditors,
    callerIsAuditor: auditors.has(caller.email.trim().toLowerCase()),
  };
}

/** Editors, followers and new owners must be company people (§11 — a
 * follower gets read shares, an editor steers a reach). */
export function isInternalEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  return INTERNAL_DOMAINS.has(e.split('@')[1] ?? '');
}

/** `{ email, name? }` from a request body, or null. */
export function parsePerson(body: unknown): { email: string; name: string | null } | null {
  const b = (body ?? {}) as { email?: unknown; name?: unknown };
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email) return null;
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
  return { email, name };
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

/**
 * `gmeet_context.autoImport` (a series auto-import's provenance stamp) names
 * the series that imported the meeting. Everyone the row is shared with gets
 * the full row from the detail routes, so a series the CALLER cannot see
 * (curated series v2 §11.6) is redacted to `seriesId: 0` with no title.
 */
export async function withVisibleSeriesProvenance<T extends { gmeet_context: GmeetContext | null }>(
  row: T,
  caller: SeriesCaller
): Promise<T> {
  const ctx = row.gmeet_context;
  const ai = ctx?.autoImport;
  if (!ai?.seriesId) return row;
  if (await seriesForCaller(ai.seriesId, caller).catch(() => null)) return row;
  const { seriesTitle: _omit, ...rest } = ai;
  void _omit;
  return { ...row, gmeet_context: { ...ctx, autoImport: { ...rest, seriesId: 0 } } };
}
