/**
 * The curated-series membership engine, v2 — "a series runs as its OWNER"
 * (docs/curated-series-spec.md §11):
 *
 *   - REACH (§11.2): a non-auditor's series only matches meetings its owner
 *     can open (owns / any share); an auditor's matches every meeting; a
 *     manual member outside reach is dropped; several series at once;
 *   - FOLLOW SHARES + LABELS (§11.4/§11.5): only on members the owner OWNS or
 *     EDITS (auditor series: all) — a member the owner can only read gives
 *     followers nothing and gets no labels; an AUDITOR follower gets every
 *     member regardless (Alok, 2026-10-07);
 *   - a meeting in two series carries BOTH label sets; leaving one keeps a
 *     label the other still wants (re-pointed, not deleted);
 *   - nothing a person did by hand is touched; the ledger blocks re-adds;
 *   - nothing before migration 054.
 *
 * The pure planner first, then the SQL it actually runs (fake postgres tag).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql } from '../../../db-ops/__tests__/helpers/fake-sql';
import { seriesWorldResponder, type World } from './helpers/series-world';
import { SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';
import type { CuratedSeries, TranscriptState } from '@/lib/server/curated-series';

type Engine = typeof import('@/lib/server/curated-series');

const KAWEN = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'kawen.koh@trames.sg' };
const ALOK = { id: 'aaaaaaaa-0000-4000-8000-00000000000b', email: 'alok@trames.sg' };
const SIQIAN = { id: 'aaaaaaaa-0000-4000-8000-00000000000c', email: 'siqian@trames.sg' };
const JAC = 'jacqueline.ng@trames.sg';

let sql: FakeSql;
let engine: Engine;

// ---------------------------------------------------------------------------
// Pure: planTranscript
// ---------------------------------------------------------------------------

const series = (over: Partial<CuratedSeries> & { id: number }): CuratedSeries => ({
  title: `S${over.id}`,
  priority: 100,
  patterns: [{ kind: 'title', regex: 'Weekly' }],
  auto_import: null,
  ownerUserId: KAWEN.id,
  ownerEmail: KAWEN.email,
  ownerIsAuditor: false,
  editors: [],
  followers: [{ email: JAC, name: null }],
  rules: [],
  ...over,
});
const auditorSeries = (over: Partial<CuratedSeries> & { id: number }) =>
  series({ ownerEmail: ALOK.email, ownerUserId: ALOK.id, ownerIsAuditor: true, ...over });

const meeting = (over: Partial<TranscriptState> = {}): TranscriptState => ({
  id: 501,
  ownerUserId: SIQIAN.id,
  shares: [],
  outOfArchive: false,
  facts: { title: 'Weekly COG and HF', emails: [], recurring: true },
  excluded: new Set(),
  memberships: new Map(),
  ledgered: new Set(),
  labels: [],
  meetingOwnerEmails: new Set([SIQIAN.email]),
  ...over,
});

let plan: Engine['planTranscript'];

describe('reach (§11.2)', () => {
  test("PRIVACY: a non-auditor's series does NOT match a meeting outside its owner's reach", () => {
    // Siqian's meeting, Kawen has no share: the title matches, the series must not.
    const p = plan(meeting(), [series({ id: 1 })]);
    expect(p.join).toEqual([]);
    expect(p.shareInserts).toEqual([]);
    expect(p.labelInserts).toEqual([]);
  });

  test('…and does once the owner can open it (any share — read is enough to be IN the series)', () => {
    const p = plan(meeting({ shares: [{ email: KAWEN.email, access: 'read', origin: null }] }), [series({ id: 1 })]);
    expect(p.join).toEqual([1]);
  });

  test("the owner's OWN meeting is in reach", () => {
    expect(plan(meeting({ ownerUserId: KAWEN.id }), [series({ id: 1 })]).join).toEqual([1]);
  });

  test('an auditor-owned series reaches every meeting', () => {
    expect(plan(meeting(), [auditorSeries({ id: 2 })]).join).toEqual([2]);
  });

  test('a manual member the owner can no longer open is DROPPED', () => {
    const p = plan(meeting({ memberships: new Map([[1, 'manual']]) }), [series({ id: 1 })]);
    expect(p.leaveOutOfReach).toEqual([1]);
    expect(p.membersOf).toEqual([]);
  });

  test('an auto member that leaves reach leaves the series', () => {
    expect(plan(meeting({ memberships: new Map([[1, 'auto']]) }), [series({ id: 1 })]).leaveAuto).toEqual([1]);
  });

  test('a meeting can be in SEVERAL series — no competition, no stealing', () => {
    const a = series({ id: 1, ownerUserId: SIQIAN.id, ownerEmail: SIQIAN.email, priority: 1 });
    expect(plan(meeting(), [auditorSeries({ id: 2 }), a]).join).toEqual([1, 2]);
  });

  test('exclusion beats patterns; trashed rows leave AUTO series but keep manual ones', () => {
    const s = series({ id: 1, ownerUserId: SIQIAN.id, ownerEmail: SIQIAN.email });
    expect(plan(meeting({ excluded: new Set([1]) }), [s]).join).toEqual([]);
    expect(plan(meeting({ outOfArchive: true, memberships: new Map([[1, 'auto']]) }), [s]).leaveAuto).toEqual([1]);
    const manual = plan(meeting({ outOfArchive: true, memberships: new Map([[1, 'manual']]) }), [s]);
    expect(manual.leaveAuto).toEqual([]);
    expect(manual.membersOf).toEqual([1]);
  });
});

describe('follow shares + labels only where the owner may act (§11.4, §11.5)', () => {
  const withRules = (s: CuratedSeries) => ({ ...s, rules: [{ ruleId: 71, labelId: 7 }] });

  test('PRIVACY: owner has only READ → member, but followers get NO share and no labels', () => {
    const p = plan(meeting({ shares: [{ email: KAWEN.email, access: 'read', origin: null }] }), [withRules(series({ id: 1 }))]);
    expect(p.join).toEqual([1]);
    expect(p.shareInserts).toEqual([]);
    expect(p.labelInserts).toEqual([]);
  });

  test('AUDITOR follower gets a READ-only member anyway; a non-auditor follower of the same series does not; no labels', () => {
    const s = withRules(
      series({ id: 1, followers: [{ email: JAC, name: null }, { email: ALOK.email, name: null, isAuditor: true }] })
    );
    const p = plan(meeting({ shares: [{ email: KAWEN.email, access: 'read', origin: null }] }), [s]);
    expect(p.join).toEqual([1]);
    expect(p.shareInserts).toEqual([{ email: ALOK.email, name: null }]);
    expect(p.labelInserts).toEqual([]);
  });

  test("PRIVACY: an auditor follower gets nothing OUTSIDE the owner's reach (the member must exist first)", () => {
    const s = series({ id: 1, followers: [{ email: ALOK.email, name: null, isAuditor: true }] });
    const p = plan(meeting(), [s]);
    expect(p.join).toEqual([]);
    expect(p.shareInserts).toEqual([]);
  });

  test("an auditor follower's share stays while the member is read-only (not swept as unwanted)", () => {
    const s = series({ id: 1, followers: [{ email: ALOK.email, name: null, isAuditor: true }] });
    const p = plan(
      meeting({
        memberships: new Map([[1, 'auto']]),
        shares: [
          { email: KAWEN.email, access: 'read', origin: null },
          { email: ALOK.email, access: 'read', origin: SHARE_ORIGIN_SERIES_FOLLOW },
        ],
      }),
      [s]
    );
    expect(p.shareDeletes).toEqual([]);
    expect(p.shareInserts).toEqual([]);
  });

  test('owner has EDIT → followers get a read follow share, labels apply', () => {
    const p = plan(meeting({ shares: [{ email: KAWEN.email, access: 'edit', origin: null }] }), [withRules(series({ id: 1 }))]);
    expect(p.shareInserts).toEqual([{ email: JAC, name: null }]);
    expect(p.labelInserts).toEqual([{ labelId: 7, ruleId: 71, seriesId: 1 }]);
  });

  test('owner OWNS it → share; auditor-owned → share + labels on anyone’s meeting', () => {
    const own = plan(meeting({ ownerUserId: KAWEN.id, meetingOwnerEmails: new Set([KAWEN.email]) }), [withRules(series({ id: 1 }))]);
    expect(own.shareInserts).toHaveLength(1);
    const p = plan(meeting(), [withRules(auditorSeries({ id: 2 }))]);
    expect(p.shareInserts).toEqual([{ email: JAC, name: null }]);
    expect(p.labelInserts).toHaveLength(1);
  });

  test('owner downgraded edit → read: the follow share and rule labels come OFF (membership stays)', () => {
    const p = plan(
      meeting({
        memberships: new Map([[1, 'auto']]),
        shares: [
          { email: KAWEN.email, access: 'read', origin: null },
          { email: JAC, access: 'read', origin: SHARE_ORIGIN_SERIES_FOLLOW },
        ],
        labels: [{ labelId: 7, how: 'rule', ruleId: 71 }],
      }),
      [withRules(series({ id: 1 }))]
    );
    expect(p.membersOf).toEqual([1]);
    expect(p.shareDeletes).toEqual([JAC]);
    expect(p.labelDeletes).toEqual([71]);
  });

  test('a follower removed before (ledger), already shared, or owning the meeting is never inserted', () => {
    const aud = auditorSeries({
      id: 2,
      followers: [
        { email: JAC, name: null },
        { email: 'eli@trames.sg', name: null },
        { email: SIQIAN.email, name: null },
      ],
    });
    const p = plan(
      meeting({ ledgered: new Set([JAC]), shares: [{ email: 'eli@trames.sg', access: 'edit', origin: null }] }),
      [aud]
    );
    expect(p.shareInserts).toEqual([]);
    expect(p.shareDeletes).toEqual([]); // a person's share is never removed
  });

  test('a follow share another ACTING series still gives is kept when one series stops giving it', () => {
    const p = plan(
      meeting({
        memberships: new Map([[1, 'auto'], [2, 'auto']]),
        shares: [
          { email: KAWEN.email, access: 'read', origin: null },
          { email: JAC, access: 'read', origin: SHARE_ORIGIN_SERIES_FOLLOW },
        ],
      }),
      [series({ id: 1 }), auditorSeries({ id: 2 })]
    );
    expect(p.shareDeletes).toEqual([]);
    expect(p.shareInserts).toEqual([]);
  });

  test('a meeting in two series gets BOTH label sets', () => {
    const a = series({ id: 1, ownerUserId: SIQIAN.id, ownerEmail: SIQIAN.email, rules: [{ ruleId: 71, labelId: 7 }] });
    const b = auditorSeries({ id: 2, rules: [{ ruleId: 81, labelId: 8 }, { ruleId: 82, labelId: 9 }] });
    const p = plan(meeting(), [a, b]);
    expect(p.join).toEqual([1, 2]);
    expect(p.labelInserts.map((x) => x.labelId).sort()).toEqual([7, 8, 9]);
  });

  test('leaving one of two series that share a label: the label is RE-POINTED, not deleted', () => {
    const a = series({ id: 1, ownerUserId: SIQIAN.id, ownerEmail: SIQIAN.email, rules: [{ ruleId: 71, labelId: 7 }] });
    const b = auditorSeries({ id: 2, rules: [{ ruleId: 81, labelId: 7 }] });
    const p = plan(
      meeting({
        excluded: new Set([1]),
        memberships: new Map([[1, 'auto'], [2, 'auto']]),
        labels: [{ labelId: 7, how: 'rule', ruleId: 71 }],
      }),
      [a, b]
    );
    expect(p.leaveAuto).toEqual([1]);
    expect(p.labelDeletes).toEqual([]);
    expect(p.labelRepoints).toEqual([{ from: 71, to: 81 }]);
    expect(p.labelInserts).toEqual([]);
  });

  test('a rule label a PERSON took off the meeting is never put back (the 10-minute sweep would otherwise)', () => {
    const p = plan(meeting({ removedLabels: new Set([7]) }), [withRules(auditorSeries({ id: 2 }))]);
    expect(p.join).toEqual([2]);
    expect(p.labelInserts).toEqual([]);
  });

  test('a label someone added by hand is never touched', () => {
    const p = plan(meeting({ labels: [{ labelId: 7, how: 'manual', ruleId: null }] }), [withRules(series({ id: 1 }))]);
    expect(p.labelDeletes).toEqual([]);
    expect(p.labelInserts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The SQL it runs
// ---------------------------------------------------------------------------

let world: World;
const fresh = (): World => ({
  ready053: true,
  ready054: true,
  auditors: [ALOK.email, 'ivan@trames.sg'],
  identities: { [SIQIAN.id]: [SIQIAN.email] },
  series: [
    {
      id: 1,
      title: 'COG weekly (Kawen)',
      priority: 100,
      patterns: [{ kind: 'title', regex: '^Weekly COG' }],
      owner_email: KAWEN.email,
      owner_user_id: KAWEN.id,
      editors: [],
      followers: [JAC],
      rules: [{ id: 71, label_id: 7 }],
    },
    {
      id: 2,
      title: 'AM Briefing: Kawen (Alok)',
      priority: 50,
      patterns: [{ kind: 'title', regex: 'COG' }],
      owner_email: ALOK.email,
      owner_user_id: ALOK.id,
      editors: [],
      followers: [ALOK.email],
      rules: [{ id: 81, label_id: 8 }],
    },
  ],
  transcripts: [
    { id: 501, assemblyai_id: 'm-501', user_id: SIQIAN.id, title: 'Weekly COG and HF', memberships: [], shares: [] },
  ],
});

const MEMBERSHIP_INSERT = /INSERT INTO "[a-z_]+"\.series_members\b/;
const MEMBERSHIP_DELETE = /DELETE FROM "[a-z_]+"\.series_members\b/;
const LABEL_INSERT = /INSERT INTO "[a-z_]+"\.transcript_labels\b/;
const SHARE_INSERT = /INSERT INTO "[a-z_]+"\.transcript_shares\b/;
const SHARE_DELETE = /DELETE FROM "[a-z_]+"\.transcript_shares\b/;
const LEDGER = /INSERT INTO "[a-z_]+"\.auditor_share_removals\b/;
const WRITE = /INSERT|DELETE|UPDATE/;
const ran = (re: RegExp) => sql.executed.filter((q) => re.test(q.text));
const emailParam = (q: { params: unknown[] }) => q.params.find((p) => typeof p === 'string' && p.includes('@'));
let memberAfter = false;
/** Series whose membership INSERT does not land (before migration 055). */
let joinFails: number[] = [];

function resetCaches() {
  const g = globalThis as Record<string, unknown>;
  for (const k of [
    '__mwCuratedSeries053',
    '__mwSeries054',
    '__mwAuditors',
    '__mwCuratedSeriesCache',
    '__mwAuditorLedger',
    '__mwShareOriginColumn',
  ]) {
    g[k] = undefined;
  }
}

beforeAll(async () => {
  sql = createFakeSql((q) => {
    const t = q.text;
    if (MEMBERSHIP_INSERT.test(t)) return joinFails.includes(q.params[0] as number) ? [] : [{ id: 1 }];
    if (MEMBERSHIP_DELETE.test(t)) return [{ id: 1 }];
    if (LABEL_INSERT.test(t)) return [];
    if (SHARE_INSERT.test(t)) return [{ id: 9 }];
    if (SHARE_DELETE.test(t)) {
      const emails = (q.params.find((p) => Array.isArray(p) && typeof p[0] === 'string') as string[]) ?? [];
      return emails.map((e) => ({ transcript_id: 501, shared_with_email: e }));
    }
    if (t.includes('SELECT 1 AS one FROM')) return memberAfter ? [{ one: 1 }] : [];
    if (/SELECT id, title FROM "[a-z_]+"\.transcripts/.test(t)) return [{ id: 501, title: 'Weekly COG and HF' }];
    return seriesWorldResponder(world)(q) ?? [];
  });
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  engine = await import('@/lib/server/curated-series');
  plan = engine.planTranscript;
});

beforeEach(() => {
  world = fresh();
  memberAfter = false;
  joinFails = [];
  sql.executed.length = 0;
  sql.log.length = 0;
  resetCaches();
});

afterAll(() => resetCaches());

describe('syncSeriesForTranscript (SQL)', () => {
  test("joins ONLY the auditor series — Kawen's series cannot reach Siqian's meeting", async () => {
    await engine.syncSeriesForTranscript(501);
    const ins = ran(MEMBERSHIP_INSERT);
    expect(ins.map((q) => q.params[0])).toEqual([2]);
    // No conflict target: correct before AND after migration 055.
    expect(ins[0]!.text).toContain('ON CONFLICT DO NOTHING');
    // Jacqueline (Kawen's follower) gets nothing; Alok (auditor-series follower) gets a share.
    const shares = ran(SHARE_INSERT);
    expect(shares.map(emailParam)).toEqual([ALOK.email]);
    expect(shares[0]!.params).toContain(SHARE_ORIGIN_SERIES_FOLLOW);
    // Only the auditor series' label rule.
    const lab = ran(LABEL_INSERT);
    expect(lab).toHaveLength(1);
    expect(lab[0]!.params).toContainEqual([81]);
  });

  test('a READ share to Kawen → in BOTH series, but Jacqueline still gets nothing', async () => {
    world.transcripts[0]!.shares = [[KAWEN.email, 'read', null]];
    await engine.syncSeriesForTranscript(501);
    expect(ran(MEMBERSHIP_INSERT).map((q) => q.params[0]).sort()).toEqual([1, 2]);
    expect(ran(SHARE_INSERT).map(emailParam)).not.toContain(JAC);
  });

  test('an EDIT share to Kawen → both label sets, and Jacqueline gets her share', async () => {
    world.transcripts[0]!.shares = [[KAWEN.email, 'edit', null]];
    await engine.syncSeriesForTranscript(501);
    const lab = ran(LABEL_INSERT);
    expect(lab).toHaveLength(1);
    expect([...(lab[0]!.params.find(Array.isArray) as number[])].sort()).toEqual([71, 81]);
    expect(ran(SHARE_INSERT).map(emailParam).sort()).toEqual([ALOK.email, JAC].sort());
  });

  test('a join that does not land (before 055: one series per meeting) hands out none of its labels or shares', async () => {
    world.transcripts[0]!.shares = [[KAWEN.email, 'edit', null]];
    joinFails = [1];
    await engine.syncSeriesForTranscript(501);
    const lab = ran(LABEL_INSERT);
    expect(lab).toHaveLength(1);
    expect(lab[0]!.params).toContainEqual([81]);
    expect(ran(SHARE_INSERT).map(emailParam)).toEqual([ALOK.email]);
  });

  test('before migration 054 nothing is written', async () => {
    world.ready054 = false;
    await engine.syncSeriesForTranscript(501);
    expect(sql.executed.some((q) => WRITE.test(q.text))).toBe(false);
  });

  test('steady state writes nothing', async () => {
    world.transcripts[0]!.memberships = [[2, 'auto']];
    world.transcripts[0]!.shares = [[ALOK.email, 'read', SHARE_ORIGIN_SERIES_FOLLOW]];
    world.transcripts[0]!.labels = [[8, 'rule', 81]];
    await engine.syncSeriesForTranscript(501);
    expect(sql.executed.some((q) => WRITE.test(q.text))).toBe(false);
  });
});

describe('a person takes a meeting out of a series', () => {
  const by = { userId: KAWEN.id, email: KAWEN.email };
  test('"not this series" that costs a follower their share is ledgered, by whom', async () => {
    // What the reconcile reads after the delete + exclusion: excluded from
    // series 2, Alok's follow share still on the row.
    world.transcripts[0]!.excluded = [2];
    world.transcripts[0]!.shares = [[ALOK.email, 'read', SHARE_ORIGIN_SERIES_FOLLOW]];
    await engine.detachFromSeries(2, { id: 501, assemblyai_id: 'm-501' }, { remember: true, ...by });
    expect(ran(SHARE_DELETE)).toHaveLength(1);
    const led = ran(LEDGER);
    expect(led).toHaveLength(1);
    expect(led[0]!.params).toContain(ALOK.email);
    expect(led[0]!.params).toContain(KAWEN.email);
  });

  test('a detach the patterns undo at once is NOT ledgered', async () => {
    world.transcripts[0]!.shares = [['x@trames.sg', 'read', SHARE_ORIGIN_SERIES_FOLLOW]];
    memberAfter = true;
    await engine.detachFromSeries(2, { id: 501, assemblyai_id: 'm-501' }, { remember: false, ...by });
    expect(ran(SHARE_DELETE)).toHaveLength(1);
    expect(ran(LEDGER)).toHaveLength(0);
  });
});
