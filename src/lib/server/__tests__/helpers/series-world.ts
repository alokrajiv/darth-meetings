/**
 * A tiny in-memory "database" for the curated-series v2 tests, answering the
 * queries the series db-ops / engine / routes emit (over the fake postgres
 * tag). Visibility predicates are EVALUATED here from the world — the tests
 * separately assert that the real SQL carries the predicate — so a route
 * that forgot to scope would leak in these tests the way it would in prod.
 */
import type { RenderedQuery } from '../../../../db-ops/__tests__/helpers/fake-sql';
import type { SeriesPattern } from '@/lib/series-patterns';

export interface WSeries {
  id: number;
  title: string;
  priority: number;
  patterns: SeriesPattern[];
  owner_email: string | null;
  owner_user_id: string | null;
  editors: string[];
  followers: string[];
  /** Default labels: rule id → label id. */
  rules: Array<{ id: number; label_id: number }>;
  auto_import?: unknown;
}

export interface WTranscript {
  id: number;
  assemblyai_id: string;
  user_id: string;
  title: string | null;
  scratch?: boolean;
  deleted?: boolean;
  ctx?: Record<string, unknown> | null;
  /** series id → how */
  memberships: Array<[number, string]>;
  excluded?: number[];
  shares: Array<[string, string, string | null]>;
  ledgered?: string[];
  labels?: Array<[number, string, number | null]>;
  removedLabels?: number[];
}

export interface World {
  ready053: boolean;
  ready054: boolean;
  auditors: string[];
  series: WSeries[];
  transcripts: WTranscript[];
  /** user id → emails (the activity log). */
  identities: Record<string, string[]>;
}

const seriesRow = (s: WSeries) => ({
  id: s.id,
  title: s.title,
  created_by: s.owner_user_id ?? 'creator-id',
  notes: null,
  description: null,
  patterns: s.patterns,
  priority: s.priority,
  auto_import: s.auto_import ?? null,
  owner_email: s.owner_email,
  owner_user_id: s.owner_user_id,
  created_at: '',
  updated_at: '',
});

/**
 * Caller from the params of a `seriesVisibleTo` fragment: the LAST four
 * params are (email, userId, email, email) — or the fragment rendered as
 * `true` (an auditor) and carries none.
 */
export function visibleIdsFor(world: World, q: RenderedQuery): Set<number> | 'all' {
  if (!q.text.includes('ed.email')) return 'all';
  const p = q.params;
  const email = String(p[p.length - 4] ?? '').toLowerCase();
  const userId = String(p[p.length - 3] ?? '');
  return new Set(
    world.series
      .filter(
        (s) =>
          s.owner_email === email ||
          (!!s.owner_user_id && s.owner_user_id === userId) ||
          s.editors.includes(email) ||
          s.followers.includes(email)
      )
      .map((s) => s.id)
  );
}

const visible = (v: Set<number> | 'all', id: number) => v === 'all' || v.has(id);

export function seriesWorldResponder(world: World) {
  return (q: RenderedQuery): unknown[] | undefined => {
    const t = q.text;
    if (t.includes('information_schema')) {
      if (t.includes('AS ledger_origin')) {
        const n = world.ready053 ? 1 : 0;
        return [{ patterns: n, followers: n, ledger_origin: n }];
      }
      if (t.includes('AS auditors')) {
        const n = world.ready054 ? 1 : 0;
        return [{ owner_email: n, editors: n, auditors: n }];
      }
      return [{ n: 1 }];
    }
    if (/FROM "[a-z_]+"\.auditors/.test(t)) {
      return world.auditors.map((email) => ({ email, name: email }));
    }
    if (/SELECT \* FROM "[a-z_]+"\.series WHERE id = \$1/.test(t)) {
      const s = world.series.find((x) => x.id === q.params[0]);
      return s ? [seriesRow(s)] : [];
    }
    if (/SELECT \* FROM "[a-z_]+"\.series ORDER BY id/.test(t)) return world.series.map(seriesRow);
    if (/^SELECT series_id, email, name, added_by_email, added_at::text AS added_at FROM "[a-z_]+"\.series_editors/.test(t)) {
      const ids = Array.isArray(q.params[0]) ? (q.params[0] as number[]) : null;
      return world.series
        .filter((s) => !ids || ids.includes(s.id))
        .flatMap((s) =>
          s.editors.map((email) => ({ series_id: s.id, email, name: null, added_by_email: 'x@trames.sg', added_at: '' }))
        );
    }
    if (/^SELECT series_id, email, name, added_by_email, added_at::text AS added_at FROM "[a-z_]+"\.series_followers/.test(t)) {
      const ids = Array.isArray(q.params[0]) ? (q.params[0] as number[]) : null;
      return world.series
        .filter((s) => !ids || ids.includes(s.id))
        .flatMap((s) =>
          s.followers.map((email) => ({ series_id: s.id, email, name: null, added_by_email: 'x@trames.sg', added_at: '' }))
        );
    }
    if (t.includes("lr.kind = 'series' AND lr.enabled AND lr.label_id IS NOT NULL ORDER BY lr.id")) {
      return world.series.flatMap((s) =>
        s.rules.map((r) => ({ id: r.id, label_id: r.label_id, value: String(s.id), created_by: 'c', created_by_email: 'c@trames.sg' }))
      );
    }
    if (t.includes('JOIN "') && t.includes('.labels l ON l.id = lr.label_id')) {
      const ids = (q.params.find(Array.isArray) as string[] | undefined) ?? [];
      return world.series
        .filter((s) => ids.includes(String(s.id)))
        .flatMap((s) =>
          s.rules.map((r) => ({
            id: r.id,
            label_id: r.label_id,
            value: String(s.id),
            created_by: 'c',
            created_by_email: 'c@trames.sg',
            path: `L/${r.label_id}`,
            name: String(r.label_id),
            color: null,
          }))
        );
    }
    if (t.includes('SELECT DISTINCT ON (user_id) user_id, user_email')) return [];
    if (t.includes('SELECT DISTINCT user_id, lower(user_email) AS email')) {
      return Object.entries(world.identities).flatMap(([user_id, emails]) => emails.map((email) => ({ user_id, email })));
    }
    // visibleSeriesIds
    if (/^SELECT s\.id FROM "[a-z_]+"\.series s WHERE/.test(t)) {
      const v = visibleIdsFor(world, q);
      return world.series.filter((s) => visible(v, s.id)).map((s) => ({ id: s.id }));
    }
    // listVisibleMemberships
    if (t.includes('SELECT m.series_id, s.title, m.how, s.priority')) {
      const tid = q.params[0] as number;
      const v = visibleIdsFor(world, q);
      const tr = world.transcripts.find((x) => x.id === tid);
      return (tr?.memberships ?? [])
        .map(([sid, how]) => ({ s: world.series.find((x) => x.id === sid)!, how }))
        .filter((x) => x.s && visible(v, x.s.id))
        .sort((a, b) => a.s.priority - b.s.priority || a.s.id - b.s.id)
        .map((x) => ({ series_id: x.s.id, title: x.s.title, how: x.how, priority: x.s.priority }));
    }
    // listSeries (index)
    if (t.includes('AS visible_member_count')) {
      const v = visibleIdsFor(world, q);
      return world.series
        .filter((s) => visible(v, s.id))
        .map((s) => ({ ...seriesRow(s), visible_member_count: 0, last_recorded_at: null, median_gap_secs: null }));
    }
    if (t.includes('AS memberships, count(t.id) FILTER')) return [{ memberships: 0, unattached: 0 }];
    // engine rows
    if (t.includes('AS memberships') && t.includes('AS ledgered')) {
      const ids = (q.params.find(Array.isArray) as number[] | undefined) ?? null;
      return world.transcripts
        .filter((x) => !ids || ids.includes(x.id))
        .map((x) => ({
          id: x.id,
          assemblyai_id: x.assemblyai_id,
          user_id: x.user_id,
          title: x.title,
          scratch: !!x.scratch,
          deleted: !!x.deleted,
          ctx: x.ctx ?? null,
          memberships: x.memberships.length ? x.memberships : null,
          excluded: x.excluded ?? null,
          shares: x.shares.length ? x.shares : null,
          ledgered: x.ledgered ?? null,
          labels: x.labels ?? null,
          removed_labels: x.removedLabels ?? null,
        }));
    }
    return undefined;
  };
}
