/**
 * The curated-series membership engine (docs/curated-series-spec.md §3-§5),
 * over the fake postgres tag: assertions are on the SQL actually run.
 *
 *   - join  → membership 'auto' + the series' default labels (how='rule')
 *             + a read 'series-follow' share for each follower;
 *   - leave → the labels this series' rules made and its followers'
 *             'series-follow' shares come off — nothing else;
 *   - a MANUAL member survives a pattern change;
 *   - "not this series" (an exclusion) beats the patterns;
 *   - a follower removed from a meeting (the removal ledger) is never added
 *     back by automation;
 *   - nothing at all before migration 053.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';
import { SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';
import type { SeriesPattern } from '@/lib/series-patterns';

type Engine = typeof import('@/lib/server/curated-series');

const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const TID = 501;

let sql: FakeSql;
let engine: Engine;

// ---- the "database" ---------------------------------------------------------
interface World {
  ready: boolean;
  series: Array<{ id: number; title: string; patterns: SeriesPattern[]; priority: number }>;
  row: {
    id: number;
    assemblyai_id: string;
    user_id: string;
    title: string | null;
    scratch: boolean;
    deleted: boolean;
    ctx: Record<string, unknown> | null;
    series_id: number | null;
    how: string | null;
    excluded: number[] | null;
  };
  followers: Array<{ series_id: number; email: string; name: string | null }>;
  ownerEmails: string[];
  /** Emails the removal ledger blocks on TID. */
  ledgered: string[];
}
let world: World;

const freshWorld = (): World => ({
  ready: true,
  series: [
    { id: 1, title: 'AI - Daily', patterns: [{ kind: 'title', regex: '^AI - Daily' }], priority: 100 },
    { id: 2, title: 'Data Cadence', patterns: [{ kind: 'title', regex: '^Data Cadence' }], priority: 100 },
  ],
  row: {
    id: TID,
    assemblyai_id: 'm-501',
    user_id: OWNER,
    title: 'AI - Daily',
    scratch: false,
    deleted: false,
    ctx: null,
    series_id: null,
    how: null,
    excluded: null,
  },
  followers: [{ series_id: 1, email: 'alok@trames.sg', name: 'Alok Rajiv' }],
  ownerEmails: ['kawen.koh@trames.sg'],
  ledgered: [],
});

const MEMBERSHIP_INSERT = /INSERT INTO "[a-z_]+"\.series_members\b/;
const MEMBERSHIP_DELETE = /DELETE FROM "[a-z_]+"\.series_members\b/;
const LABEL_APPLY = /INSERT INTO "[a-z_]+"\.transcript_labels\b/;
const LABEL_REMOVE = /DELETE FROM "[a-z_]+"\.transcript_labels tl USING/;
const SHARE_INSERT = /INSERT INTO "[a-z_]+"\.transcript_shares\b/;
const SHARE_DELETE = /DELETE FROM "[a-z_]+"\.transcript_shares\b/;

function respond(q: RenderedQuery): unknown[] {
  const t = q.text;
  if (t.includes('information_schema')) {
    // 053 probe (three counts), the 052 ledger probe and the 048 origin probe.
    if (t.includes('AS ledger_origin')) {
      const n = world.ready ? 1 : 0;
      return [{ patterns: n, followers: n, ledger_origin: n }];
    }
    return [{ n: 1 }];
  }
  if (/SELECT \* FROM "[a-z_]+"\.series ORDER BY id/.test(t)) {
    return world.series.map((s) => ({ ...s, created_by: OWNER, auto_import: null, notes: null }));
  }
  if (t.includes('AS excluded') && t.includes('WHERE t.id =')) return [world.row];
  if (MEMBERSHIP_INSERT.test(t)) return [{ id: 1 }];
  if (MEMBERSHIP_DELETE.test(t)) return [{ id: 1 }];
  if (LABEL_APPLY.test(t)) {
    return [
      {
        transcript_id: TID,
        label_id: 70,
        rule_id: 7,
        added_by: OWNER,
        added_by_email: 'alok@trames.sg',
        assemblyai_id: 'm-501',
        path: 'Team/AI',
      },
    ];
  }
  if (LABEL_REMOVE.test(t)) return [{ transcript_id: TID, assemblyai_id: 'm-501' }];
  if (/FROM "[a-z_]+"\.series_followers/.test(t) && t.startsWith('SELECT')) {
    const ids = q.params[0] as number[];
    return world.followers.filter((f) => ids.includes(f.series_id)).map((f) => ({ ...f, added_by_email: 'alok@trames.sg', added_at: '' }));
  }
  if (/INSERT INTO "[a-z_]+"\.series_followers/.test(t)) return [{ email: q.params[1] }];
  if (t.includes('SELECT DISTINCT user_id, lower(user_email) AS email')) {
    return world.ownerEmails.map((email) => ({ user_id: OWNER, email }));
  }
  if (SHARE_INSERT.test(t)) {
    const email = q.params.find((p): p is string => typeof p === 'string' && p.includes('@'));
    return email && world.ledgered.includes(email) ? [] : [{ id: 99 }];
  }
  if (SHARE_DELETE.test(t)) return [{ transcript_id: TID, shared_with_email: 'alok@trames.sg' }];
  if (/SELECT transcript_id FROM "[a-z_]+"\.series_members WHERE series_id/.test(t)) {
    return [{ transcript_id: TID }];
  }
  if (t.includes('m.transcript_id, t.user_id, t.assemblyai_id')) {
    return [{ transcript_id: TID, user_id: OWNER, assemblyai_id: 'm-501' }];
  }
  return [];
}

const ran = (re: RegExp) => sql.executed.filter((q) => re.test(q.text));

function resetCaches() {
  const g = globalThis as Record<string, unknown>;
  g.__mwCuratedSeries053 = undefined;
  g.__mwCuratedSeriesCache = undefined;
  g.__mwAuditorLedger = undefined;
  g.__mwShareOriginColumn = undefined;
}

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  engine = await import('@/lib/server/curated-series');
});

beforeEach(() => {
  world = freshWorld();
  sql.executed.length = 0;
  sql.log.length = 0;
  resetCaches();
});

// The probes and the series cache live on globalThis — leave nothing behind.
afterAll(() => resetCaches());

describe('decideMembership (pure)', () => {
  const series = freshWorld().series.map((s) => ({ ...s, auto_import: null }));
  const state = (over: Partial<Parameters<Engine['decideMembership']>[0]> = {}) => ({
    seriesId: null,
    how: null,
    outOfArchive: false,
    facts: { title: 'AI - Daily', emails: [], recurring: false },
    excluded: new Set<number>(),
    ...over,
  });
  test('a matching meeting joins the winner', () => {
    expect(engine.decideMembership(state(), series)).toEqual({ action: 'join', to: 1 });
  });
  test('a retitle moves an auto member', () => {
    expect(
      engine.decideMembership(
        state({ seriesId: 1, how: 'auto', facts: { title: 'Data Cadence', emails: [], recurring: false } }),
        series
      )
    ).toEqual({ action: 'move', from: 1, to: 2 });
  });
  test('a MANUAL member survives its series no longer matching', () => {
    expect(
      engine.decideMembership(
        state({ seriesId: 1, how: 'manual', facts: { title: 'Lunch', emails: [], recurring: false } }),
        series
      )
    ).toEqual({ action: 'none' });
  });
  test('the exclusion beats the patterns', () => {
    expect(engine.decideMembership(state({ excluded: new Set([1]) }), series)).toEqual({ action: 'none' });
    expect(
      engine.decideMembership(state({ seriesId: 1, how: 'auto', excluded: new Set([1]) }), series)
    ).toEqual({ action: 'leave', from: 1 });
  });
  test('trashed / temporary rows leave their auto series', () => {
    expect(
      engine.decideMembership(state({ seriesId: 1, how: 'auto', outOfArchive: true }), series)
    ).toEqual({ action: 'leave', from: 1 });
  });
});

describe('syncSeriesForTranscript', () => {
  test('join → auto membership, default labels (rule), a read follow share per follower', async () => {
    await engine.syncSeriesForTranscript(TID);
    const ins = ran(MEMBERSHIP_INSERT);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.params.slice(0, 2)).toEqual([1, TID]);
    expect(ins[0]!.text).toContain("'auto'");
    expect(ins[0]!.text).toContain('ON CONFLICT (transcript_id) DO NOTHING');

    const labels = ran(LABEL_APPLY);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text).toContain("'rule'");
    expect(labels[0]!.text).toContain("lr.kind = 'series'");
    expect(labels[0]!.params).toContain('1'); // label_rules.value = series id
    expect(labels[0]!.params).toContain(1); // series_members.series_id

    const shares = ran(SHARE_INSERT);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.params).toContain('alok@trames.sg');
    expect(shares[0]!.params).toContain(SHARE_ORIGIN_SERIES_FOLLOW);
    expect(shares[0]!.text).toContain("'read'");
    expect(shares[0]!.text).toContain('auditor_share_removals');
    expect(shares[0]!.text).toMatch(/ON CONFLICT \(transcript_id, shared_with_email\) DO NOTHING/);
  });

  test('a follower who OWNS the meeting gets no share of it', async () => {
    world.ownerEmails = ['alok@trames.sg'];
    await engine.syncSeriesForTranscript(TID);
    expect(ran(MEMBERSHIP_INSERT)).toHaveLength(1);
    expect(ran(SHARE_INSERT)).toHaveLength(0);
  });

  test('leave → the rule labels and the series-follow shares come off, nothing else', async () => {
    world.row = { ...world.row, title: 'Lunch', series_id: 1, how: 'auto' };
    await engine.syncSeriesForTranscript(TID);
    const del = ran(MEMBERSHIP_DELETE);
    expect(del).toHaveLength(1);
    expect(del[0]!.text).toContain("how = 'auto'");
    expect(del[0]!.params).toEqual([TID, 1]);

    const lab = ran(LABEL_REMOVE);
    expect(lab).toHaveLength(1);
    expect(lab[0]!.text).toContain("tl.how = 'rule'");
    expect(lab[0]!.params).toContain('1');

    const sh = ran(SHARE_DELETE);
    expect(sh).toHaveLength(1);
    expect(sh[0]!.text).toContain('origin = $');
    expect(sh[0]!.params).toContain(SHARE_ORIGIN_SERIES_FOLLOW);
    expect(sh[0]!.params).toContainEqual(['alok@trames.sg']);
    expect(ran(MEMBERSHIP_INSERT)).toHaveLength(0);
  });

  test('a manual member survives a pattern change — no writes at all', async () => {
    world.row = { ...world.row, title: 'Lunch', series_id: 1, how: 'manual' };
    await engine.syncSeriesForTranscript(TID);
    expect(ran(MEMBERSHIP_INSERT)).toHaveLength(0);
    expect(ran(MEMBERSHIP_DELETE)).toHaveLength(0);
    expect(ran(LABEL_REMOVE)).toHaveLength(0);
    expect(ran(SHARE_DELETE)).toHaveLength(0);
  });

  test('exclusion beats patterns: a matching meeting excluded from the series joins nothing', async () => {
    world.row = { ...world.row, excluded: [1] };
    await engine.syncSeriesForTranscript(TID);
    expect(ran(MEMBERSHIP_INSERT)).toHaveLength(0);
    expect(ran(SHARE_INSERT)).toHaveLength(0);
  });

  test('a trashed meeting drops its auto membership (labels + follow shares with it)', async () => {
    world.row = { ...world.row, deleted: true, series_id: 1, how: 'auto' };
    await engine.syncSeriesForTranscript(TID);
    expect(ran(MEMBERSHIP_DELETE)).toHaveLength(1);
    expect(ran(LABEL_REMOVE)).toHaveLength(1);
    expect(ran(SHARE_DELETE)).toHaveLength(1);
  });

  test('before migration 053 nothing is written', async () => {
    world.ready = false;
    await engine.syncSeriesForTranscript(TID);
    expect(sql.executed.every((q) => !/INSERT|DELETE/.test(q.text))).toBe(true);
  });
});

describe('followers', () => {
  test('a follower removed from a meeting is never re-added (the ledger guard)', async () => {
    world.ledgered = ['alok@trames.sg'];
    const r = await engine.followSeries(1, { email: 'alok@trames.sg', name: 'Alok Rajiv' }, {
      userId: OWNER,
      email: 'alok@trames.sg',
    });
    expect(r.shares).toBe(0);
    const ins = ran(SHARE_INSERT);
    expect(ins).toHaveLength(1);
    // The guard: ANY ledger row for (meeting, email) blocks the insert.
    expect(ins[0]!.text).toMatch(
      /WHERE NOT EXISTS \( SELECT 1 FROM "[a-z_]+"\.auditor_share_removals r WHERE r\.transcript_id = \$\d+ AND r\.auditor_email = \$\d+ \)/
    );
    expect(ins[0]!.params).toContain(TID);
  });

  test('unfollow takes only the follow shares off the series members', async () => {
    const r = await engine.unfollowSeries(1, 'Alok@trames.sg');
    expect(r.removed).toBe(false); // the fake DELETE … RETURNING on followers returned nothing
    const del = ran(SHARE_DELETE);
    expect(del).toHaveLength(1);
    expect(del[0]!.params).toContain(SHARE_ORIGIN_SERIES_FOLLOW);
    expect(del[0]!.params).toContainEqual(['alok@trames.sg']);
  });
});
