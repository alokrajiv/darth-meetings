import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { unlessDraining } from '@/lib/server/deploy-drain';
import { seriesOwnershipReady } from '@/db-ops/series-ownership-schema';
import {
  addExclusion,
  deleteAutoMembership,
  deleteMembershipIn,
  deleteSeriesRow,
  isMemberOf,
  insertAutoMembership,
  listAllMemberIds,
  listAllSeries,
  setSeriesOwner,
  upsertManualMembership,
  visibleSeriesIds,
  type SeriesRow,
} from '@/db-ops/series';
import { deleteFollower, insertFollower, listAllFollowers } from '@/db-ops/series-followers';
import { deleteEditor, insertEditor, listAllEditors } from '@/db-ops/series-editors';
import { auditorEmails, isAuditor } from '@/db-ops/auditors';
import { addAutoReadShares, recordAutoShareRemoval, removeAutoReadShares } from '@/db-ops/auditor-shares';
import {
  deleteRuleLabels,
  dropSeriesLabelRules,
  insertRuleLabels,
  listAllSeriesLabelRules,
  repointRuleLabel,
} from '@/lib/server/series-labels';
import { SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';
import { ownAttendeesForOccurrences } from '@/db-ops/calendar-event-cache';
import {
  compareSeriesOrder,
  factsFromCalendarRow,
  factsFromContext,
  matchingSeries,
  seriesMatches,
  type SeriesContextFields,
  type SeriesFacts,
  type SeriesPattern,
} from '@/lib/series-patterns';
import type { LabelActor } from '@/db-ops/labels';

/**
 * THE membership engine for curated series — v2, "a series runs as its
 * OWNER" (docs/curated-series-spec.md §11, superseding §3/§6).
 *
 * A series can only ever hold what its owner can already open:
 *
 *  - REACH (§11.2): an auditor-owned series reaches every live meeting;
 *    anyone else's reaches the meetings its owner owns or holds ANY share on
 *    (the resolveAccess rule). Membership = meetings in reach whose facts
 *    match any pattern, minus that series' exclusions, plus manual members
 *    that are still in reach. A meeting can be in SEVERAL series — no
 *    cross-series competition (priority is display order only).
 *  - FOLLOW SHARES (§11.4) and DEFAULT LABELS (§11.5) are written for a
 *    member only where the owner may ACT on it (`ownerMayActOn`): owns it,
 *    or holds an `edit` share — the same right that lets a person share or
 *    label a meeting by hand. Auditor-owned series: every member (policy).
 *
 * The engine is a reconciler: for one meeting it computes what SHOULD be
 * (memberships, the rule labels of every acting series, the follow shares
 * of every acting series' followers) from all series at once, and writes
 * only the difference (`planTranscript`, pure, unit-tested). Steady state
 * writes nothing. Nothing a person did by hand is touched: hand-made labels
 * (how <> 'rule'), shares without the 'series-follow' origin; a person
 * taken off a meeting (the removal ledger) and a label a person took off a
 * meeting (its label_remove activity) are never put back by automation.
 *
 * Entry points:
 *  - `syncSeriesForTranscript(id)` — every import path, link-event, restore,
 *    and every share writer (a share TO a series owner changes its reach).
 *  - `rematchAll()` — after a create / patterns change / transfer, and every
 *    10 minutes as a backstop.
 *  - `reconcileTranscripts(ids)` — after a follower/label change (only the
 *    series' members can be affected).
 *
 * Nothing runs until migrations 053 + 054 are applied (seriesOwnershipReady):
 * without an owner there is no reach. Never throws out of the import-path
 * entry point — series bookkeeping must not fail an import.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const CACHE_TTL_MS = 60_000;
const SWEEP_MS = 10 * 60_000;

export interface CuratedSeries {
  id: number;
  title: string;
  priority: number;
  patterns: SeriesPattern[];
  auto_import: SeriesRow['auto_import'];
  ownerUserId: string | null;
  ownerEmail: string | null;
  ownerIsAuditor: boolean;
  /** Lower-cased. */
  editors: string[];
  followers: Array<{ email: string; name: string | null }>;
  /** Default labels: the series' label_rules. */
  rules: Array<{ ruleId: number; labelId: number }>;
}

const g = globalThis as unknown as {
  __mwCuratedSeriesCache?: { at: number; series: CuratedSeries[] };
  __mwCuratedSeriesSweep?: ReturnType<typeof setInterval> | null;
};

/** Every series with its matcher + reach inputs — cached ~60 s per process,
 * busted on every series write in this process. Empty before 054. */
export async function loadCuratedSeries(): Promise<CuratedSeries[]> {
  const hit = g.__mwCuratedSeriesCache;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.series;
  if (!(await seriesOwnershipReady())) return [];
  const [rows, editors, followers, rules, auditors] = await Promise.all([
    listAllSeries(),
    listAllEditors(),
    listAllFollowers(),
    listAllSeriesLabelRules(),
    auditorEmails(),
  ]);
  const series: CuratedSeries[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    priority: r.priority,
    patterns: r.patterns,
    auto_import: r.auto_import,
    ownerUserId: r.owner_user_id,
    ownerEmail: r.owner_email,
    ownerIsAuditor: !!r.owner_email && auditors.has(r.owner_email),
    editors: editors.filter((e) => e.series_id === r.id).map((e) => e.email),
    followers: followers
      .filter((f) => f.series_id === r.id)
      .map((f) => ({ email: f.email.toLowerCase(), name: f.name })),
    rules: rules.filter((x) => x.series_id === r.id).map((x) => ({ ruleId: x.id, labelId: x.label_id })),
  }));
  g.__mwCuratedSeriesCache = { at: Date.now(), series };
  return series;
}

export function bustCuratedSeriesCache(): void {
  g.__mwCuratedSeriesCache = undefined;
}

// ---------------------------------------------------------------------------
// Reach + the right to act (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface SeriesOwnerFacts {
  ownerUserId: string | null;
  ownerEmail: string | null;
  ownerIsAuditor: boolean;
}

export interface MeetingAccessFacts {
  /** transcripts.user_id */
  ownerUserId: string;
  /** Every share on the meeting: email lower-cased. */
  shares: ReadonlyArray<{ email: string; access: string; origin?: string | null }>;
}

function shareOf(m: MeetingAccessFacts, email: string | null): { access: string } | null {
  if (!email) return null;
  return m.shares.find((s) => s.email === email) ?? null;
}

/** §11.2: can the series' owner OPEN this meeting (auditor → always)? */
export function seriesReaches(s: SeriesOwnerFacts, m: MeetingAccessFacts): boolean {
  if (s.ownerIsAuditor) return true;
  if (s.ownerUserId && m.ownerUserId === s.ownerUserId) return true;
  return shareOf(m, s.ownerEmail) !== null;
}

/**
 * §11.4/§11.5 `ownerMayActOn`: may the series' owner SHARE and LABEL this
 * meeting — its owner, or an editor of it (`canManageShares` in the shares
 * route); auditor-owned series always (policy). A member the owner can only
 * READ is in the series but gives its followers nothing and gets no labels.
 */
export function ownerMayActOn(s: SeriesOwnerFacts, m: MeetingAccessFacts): boolean {
  if (s.ownerIsAuditor) return true;
  if (s.ownerUserId && m.ownerUserId === s.ownerUserId) return true;
  return shareOf(m, s.ownerEmail)?.access === 'edit';
}

// ---------------------------------------------------------------------------
// The per-meeting plan (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface TranscriptState extends MeetingAccessFacts {
  id: number;
  /** Trashed or temporary: out of the archive, so out of any AUTO series. */
  outOfArchive: boolean;
  facts: SeriesFacts;
  excluded: ReadonlySet<number>;
  /** series id → how ('auto' | 'manual' | legacy 'confirmed'). */
  memberships: ReadonlyMap<number, string>;
  /** Emails the share-removal ledger blocks on this meeting. */
  ledgered: ReadonlySet<string>;
  /** Every label on the meeting. */
  labels: ReadonlyArray<{ labelId: number; how: string; ruleId: number | null }>;
  /** Labels a PERSON took off this meeting (label_remove activity) — the
   * labels' twin of the share-removal ledger: automation never puts them
   * back. Optional for callers that predate it. */
  removedLabels?: ReadonlySet<number>;
  /** Every address the meeting's OWNER has used — a follower who owns the
   * meeting gets no share of it. */
  meetingOwnerEmails: ReadonlySet<string>;
}

export interface TranscriptPlan {
  /** New 'auto' memberships. */
  join: number[];
  /** Auto memberships whose series no longer matches (guarded: how='auto'). */
  leaveAuto: number[];
  /** Any membership whose series' owner can no longer open the meeting. */
  leaveOutOfReach: number[];
  labelInserts: Array<{ labelId: number; ruleId: number; seriesId: number }>;
  /** Rule ids whose assignment on this meeting goes. */
  labelDeletes: number[];
  labelRepoints: Array<{ from: number; to: number }>;
  shareInserts: Array<{ email: string; name: string | null }>;
  shareDeletes: string[];
  /** Series the meeting is in after the plan. */
  membersOf: number[];
}

export const isEmptyPlan = (p: TranscriptPlan) =>
  p.join.length === 0 &&
  p.leaveAuto.length === 0 &&
  p.leaveOutOfReach.length === 0 &&
  p.labelInserts.length === 0 &&
  p.labelDeletes.length === 0 &&
  p.labelRepoints.length === 0 &&
  p.shareInserts.length === 0 &&
  p.shareDeletes.length === 0;

export function planTranscript(state: TranscriptState, series: readonly CuratedSeries[]): TranscriptPlan {
  const plan: TranscriptPlan = {
    join: [],
    leaveAuto: [],
    leaveOutOfReach: [],
    labelInserts: [],
    labelDeletes: [],
    labelRepoints: [],
    shareInserts: [],
    shareDeletes: [],
    membersOf: [],
  };
  const ordered = [...series].sort(compareSeriesOrder);
  const members: CuratedSeries[] = [];
  for (const s of ordered) {
    const how = state.memberships.get(s.id);
    const reach = seriesReaches(s, state);
    const matches =
      !state.outOfArchive && !state.excluded.has(s.id) && reach && seriesMatches(s.patterns, state.facts);
    if (how === undefined) {
      if (matches) {
        plan.join.push(s.id);
        members.push(s);
      }
    } else if (how === 'auto') {
      if (matches) members.push(s);
      else plan.leaveAuto.push(s.id);
    } else {
      // A person put it there: it stays while the owner can open it.
      if (reach) members.push(s);
      else plan.leaveOutOfReach.push(s.id);
    }
  }
  plan.membersOf = members.map((s) => s.id);

  const acting = members.filter((s) => ownerMayActOn(s, state));

  // ---- labels: every acting series' default labels -----------------------
  const ruleSeries = new Map<number, number>();
  for (const s of series) for (const r of s.rules) ruleSeries.set(r.ruleId, s.id);
  const actingRules = new Set(acting.flatMap((s) => s.rules.map((r) => r.ruleId)));
  const desired = new Map<number, { ruleId: number; seriesId: number }>();
  for (const s of acting) {
    for (const r of s.rules) {
      if (!desired.has(r.labelId)) desired.set(r.labelId, { ruleId: r.ruleId, seriesId: s.id });
    }
  }
  const present = new Set(state.labels.map((l) => l.labelId));
  for (const l of state.labels) {
    if (l.how !== 'rule' || l.ruleId === null || !ruleSeries.has(l.ruleId)) continue; // not ours
    const want = desired.get(l.labelId);
    if (!want) plan.labelDeletes.push(l.ruleId);
    else if (want.ruleId !== l.ruleId && !actingRules.has(l.ruleId)) {
      plan.labelRepoints.push({ from: l.ruleId, to: want.ruleId });
    }
  }
  for (const [labelId, want] of desired) {
    if (present.has(labelId) || state.removedLabels?.has(labelId)) continue;
    plan.labelInserts.push({ labelId, ruleId: want.ruleId, seriesId: want.seriesId });
  }

  // ---- follow shares: every acting series' followers ----------------------
  const wanted = new Map<string, string | null>();
  for (const s of acting) {
    for (const f of s.followers) {
      if (state.meetingOwnerEmails.has(f.email)) continue;
      if (!wanted.has(f.email)) wanted.set(f.email, f.name);
    }
  }
  const shared = new Set(state.shares.map((x) => x.email));
  for (const x of state.shares) {
    if (x.origin === SHARE_ORIGIN_SERIES_FOLLOW && !wanted.has(x.email)) plan.shareDeletes.push(x.email);
  }
  for (const [email, name] of wanted) {
    if (shared.has(email) || state.ledgered.has(email)) continue;
    plan.shareInserts.push({ email, name });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface SyncRow {
  id: number;
  assemblyai_id: string;
  user_id: string;
  title: string | null;
  scratch: boolean;
  deleted: boolean;
  ctx: SeriesContextFields | null;
  memberships: Array<[number, string]> | null;
  excluded: number[] | null;
  shares: Array<[string, string, string | null]> | null;
  ledgered: string[] | null;
  labels: Array<[number, string, number | null]> | null;
  removed_labels: number[] | null;
}

/** The projection the reconciler needs — only the four context fields, never
 * the whole gmeet_context (it carries transcripts and clip graphs). */
const SYNC_COLUMNS = () => sql`
  t.id, t.assemblyai_id, t.user_id, t.title, t.scratch,
  (t.deleted_at IS NOT NULL) AS deleted,
  jsonb_build_object(
    'eventTitle', t.gmeet_context->>'eventTitle',
    'organizerEmail', t.gmeet_context->>'organizerEmail',
    'recurringEventId', t.gmeet_context->>'recurringEventId',
    'attendees', CASE WHEN jsonb_typeof(t.gmeet_context->'attendees') = 'array'
                      THEN t.gmeet_context->'attendees' END
  ) AS ctx,
  (SELECT jsonb_agg(jsonb_build_array(m.series_id, m.how)) FROM ${sql(SCHEMA)}.series_members m
    WHERE m.transcript_id = t.id) AS memberships,
  (SELECT array_agg(x.series_id) FROM ${sql(SCHEMA)}.series_exclusions x
    WHERE x.transcript_id = t.id) AS excluded,
  (SELECT jsonb_agg(jsonb_build_array(lower(sh.shared_with_email), sh.access, sh.origin))
    FROM ${sql(SCHEMA)}.transcript_shares sh WHERE sh.transcript_id = t.id) AS shares,
  (SELECT array_agg(DISTINCT lower(r.auditor_email)) FROM ${sql(SCHEMA)}.auditor_share_removals r
    WHERE r.transcript_id = t.id) AS ledgered,
  (SELECT jsonb_agg(jsonb_build_array(tl.label_id, tl.how, tl.rule_id))
    FROM ${sql(SCHEMA)}.transcript_labels tl WHERE tl.transcript_id = t.id) AS labels,
  (SELECT array_agg(DISTINCT (a.details->>'label_id')::int)
    FROM ${sql(SCHEMA)}.transcript_activity a
    WHERE a.transcript_id = t.id AND a.action = 'label_remove'
      AND a.details->>'label_id' ~ '^[0-9]+$'
      AND COALESCE(a.details->>'via', '') <> 'label_delete') AS removed_labels
`;

function stateOf(row: SyncRow, ownerEmails: Map<string, Set<string>>): TranscriptState {
  return {
    id: row.id,
    ownerUserId: row.user_id,
    outOfArchive: row.deleted || row.scratch,
    facts: factsFromContext({ title: row.title, gmeet_context: row.ctx }),
    excluded: new Set(row.excluded ?? []),
    memberships: new Map((row.memberships ?? []).map(([id, how]) => [Number(id), how])),
    shares: (row.shares ?? []).map(([email, access, origin]) => ({ email, access, origin })),
    ledgered: new Set(row.ledgered ?? []),
    labels: (row.labels ?? []).map(([labelId, how, ruleId]) => ({
      labelId: Number(labelId),
      how,
      ruleId: ruleId === null ? null : Number(ruleId),
    })),
    meetingOwnerEmails: ownerEmails.get(row.user_id) ?? new Set(),
    removedLabels: new Set((row.removed_labels ?? []).map(Number)),
  };
}

/** Every email each owner has used (the activity log is the only identity
 * table) — a follower who OWNS the meeting gets no share of it. */
async function ownerEmailsFor(userIds: string[]): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, Set<string>>();
  if (ids.length === 0) return out;
  const rows = await sql<Array<{ user_id: string; email: string }>>`
    SELECT DISTINCT user_id, lower(user_email) AS email
    FROM ${sql(SCHEMA)}.transcript_activity
    WHERE user_id = ANY(${ids}::uuid[])
  `;
  for (const r of rows) {
    const set = out.get(r.user_id) ?? new Set<string>();
    set.add(r.email);
    out.set(r.user_id, set);
  }
  return out;
}

async function loadRows(where: 'ids' | 'all', ids: number[] = []): Promise<SyncRow[]> {
  if (where === 'ids') {
    if (ids.length === 0) return [];
    return sql<SyncRow[]>`
      SELECT ${SYNC_COLUMNS()}
      FROM ${sql(SCHEMA)}.transcripts t
      WHERE t.id = ANY(${ids}::int[])
    `;
  }
  return sql<SyncRow[]>`
    SELECT ${SYNC_COLUMNS()}
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE (t.deleted_at IS NULL AND NOT t.scratch)
       OR EXISTS (SELECT 1 FROM ${sql(SCHEMA)}.series_members m WHERE m.transcript_id = t.id)
  `;
}

// ---------------------------------------------------------------------------
// Carrying out a plan
// ---------------------------------------------------------------------------

type FollowShareRef = { transcript_id: number; shared_with_email: string };

interface Applied {
  joined: number;
  left: number;
  /** Follow shares this run took off (for the human-detach ledger). */
  followSharesRemoved: FollowShareRef[];
  followSharesAdded: FollowShareRef[];
  /** A share was added to someone who owns a series — their reach changed. */
  reachChanged: boolean;
}

async function applyPlan(
  row: Pick<SyncRow, 'id' | 'user_id' | 'assemblyai_id'>,
  state: TranscriptState,
  planned: TranscriptPlan,
  series: readonly CuratedSeries[],
  actor?: LabelActor | null
): Promise<Applied> {
  const out: Applied = { joined: 0, left: 0, followSharesRemoved: [], followSharesAdded: [], reachChanged: false };
  if (isEmptyPlan(planned)) return out;
  let plan = planned;
  for (const id of plan.leaveAuto) if (await deleteAutoMembership(id, row.id)) out.left++;
  for (const id of plan.leaveOutOfReach) if (await deleteMembershipIn(id, row.id)) out.left++;
  const failed: number[] = [];
  for (const id of plan.join) {
    if (await insertAutoMembership(id, row.id)) out.joined++;
    else failed.push(id);
  }
  if (failed.length > 0) {
    // A join that did not land (before migration 055 the meeting can only be
    // in one series; or a concurrent write) must not hand out that series'
    // labels or follow shares — re-plan as if those series did not match.
    const memberships = new Map(state.memberships);
    for (const id of [...plan.leaveAuto, ...plan.leaveOutOfReach]) memberships.delete(id);
    for (const id of plan.join) if (!failed.includes(id)) memberships.set(id, 'auto');
    plan = planTranscript(
      { ...state, memberships, excluded: new Set([...state.excluded, ...failed]) },
      series
    );
  }

  if (plan.labelDeletes.length > 0) await deleteRuleLabels(row.id, plan.labelDeletes);
  for (const r of plan.labelRepoints) await repointRuleLabel(row.id, r.from, r.to);
  if (plan.labelInserts.length > 0) await insertRuleLabels(row.id, plan.labelInserts, actor);

  if (plan.shareDeletes.length > 0) {
    out.followSharesRemoved = await removeAutoReadShares({
      transcriptIds: [row.id],
      emails: plan.shareDeletes,
      origin: SHARE_ORIGIN_SERIES_FOLLOW,
    });
  }
  if (plan.shareInserts.length > 0) {
    const added = await addAutoReadShares(row.id, row.user_id, plan.shareInserts, SHARE_ORIGIN_SERIES_FOLLOW);
    out.followSharesAdded = added.map((e) => ({ transcript_id: row.id, shared_with_email: e }));
    // A new share only widens the reach of a NON-auditor owner (an auditor's
    // series reaches everything already; an owner who had any share would
    // not have been given another).
    const owners = new Set(
      series.filter((s) => !s.ownerIsAuditor && s.ownerEmail).map((s) => s.ownerEmail as string)
    );
    out.reachChanged = added.some((e) => owners.has(e));
  }
  if (out.joined > 0 || out.left > 0) publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  return out;
}

export interface ReconcileTotals {
  joined: number;
  left: number;
  /** Meetings that had anything written. */
  changed: number;
  followSharesRemoved: FollowShareRef[];
  followSharesAdded: FollowShareRef[];
}

const emptyTotals = (): ReconcileTotals => ({
  joined: 0,
  left: 0,
  changed: 0,
  followSharesRemoved: [],
  followSharesAdded: [],
});

async function reconcileRows(
  rows: SyncRow[],
  series: readonly CuratedSeries[],
  actor?: LabelActor | null
): Promise<ReconcileTotals & { reachChangedIds: number[] }> {
  const totals = { ...emptyTotals(), reachChangedIds: [] as number[] };
  if (rows.length === 0) return totals;
  const owners = await ownerEmailsFor(rows.map((r) => r.user_id));
  for (const row of rows) {
    try {
      const state = stateOf(row, owners);
      const plan = planTranscript(state, series);
      if (isEmptyPlan(plan)) continue;
      const r = await applyPlan(row, state, plan, series, actor);
      totals.joined += r.joined;
      totals.left += r.left;
      totals.changed++;
      totals.followSharesRemoved.push(...r.followSharesRemoved);
      totals.followSharesAdded.push(...r.followSharesAdded);
      if (r.reachChanged) totals.reachChangedIds.push(row.id);
    } catch (err) {
      console.warn(`[curated-series] reconcile skipped transcript ${row.id}:`, err);
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Re-decide these meetings (and run their labels + follow shares). A share
 * the run gave to a series owner can widen that owner's reach — such rows
 * get one more pass (bounded). */
export async function reconcileTranscripts(ids: number[], actor?: LabelActor | null): Promise<ReconcileTotals> {
  const out = emptyTotals();
  if (!(await seriesOwnershipReady())) return out;
  let todo = [...new Set(ids)];
  for (let pass = 0; pass < 3 && todo.length > 0; pass++) {
    const series = await loadCuratedSeries();
    const r = await reconcileRows(await loadRows('ids', todo), series, actor);
    out.joined += r.joined;
    out.left += r.left;
    out.changed += r.changed;
    out.followSharesRemoved.push(...r.followSharesRemoved);
    out.followSharesAdded.push(...r.followSharesAdded);
    todo = r.reachChangedIds;
  }
  return out;
}

/**
 * Re-decide one meeting. Every import path calls this after the row exists,
 * as do link-event, restore and every share writer (a share to or from a
 * series owner moves the meeting in or out of that series' reach). Never
 * throws.
 */
export async function syncSeriesForTranscript(transcriptId: number, actor?: LabelActor | null): Promise<void> {
  try {
    const r = await reconcileTranscripts([transcriptId], actor);
    if (r.changed > 0) console.log(`[curated-series] transcript ${transcriptId}: +${r.joined} −${r.left}`);
  } catch (err) {
    console.warn(`[curated-series] sync failed for transcript ${transcriptId} (continuing):`, err);
  }
}

/** Fire-and-forget form for the share writers: never awaited by the
 * response, never throws. */
export function syncSeriesAfterShareChange(transcriptId: number): void {
  void syncSeriesForTranscript(transcriptId);
}

/**
 * Re-decide every meeting: all live non-temporary rows, plus any member that
 * went out of the archive. Logs `[curated-series] rematch: +N −M (K changed)`.
 */
export async function rematchAll(reason = 'sweep'): Promise<{ joined: number; left: number; changed: number }> {
  const out = { joined: 0, left: 0, changed: 0 };
  if (!(await seriesOwnershipReady())) return out;
  bustCuratedSeriesCache();
  const series = await loadCuratedSeries();
  const r = await reconcileRows(await loadRows('all'), series);
  out.joined = r.joined;
  out.left = r.left;
  out.changed = r.changed;
  if (r.reachChangedIds.length > 0) {
    const again = await reconcileTranscripts(r.reachChangedIds);
    out.joined += again.joined;
    out.left += again.left;
  }
  console.log(`[curated-series] rematch (${reason}): +${out.joined} −${out.left} (${out.changed} changed)`);
  return out;
}

/**
 * DRY RUN (scripts/series-ownership-seed.ts): what a full rematch WOULD do
 * against `series` (e.g. the live list with owners/editors/followers
 * swapped for a proposed table) — every meeting's current memberships and
 * the plan, nothing written.
 */
export async function planEverything(
  series: readonly CuratedSeries[]
): Promise<Array<{ transcriptId: number; current: number[]; plan: TranscriptPlan }>> {
  const rows = await loadRows('all');
  const owners = await ownerEmailsFor(rows.map((r) => r.user_id));
  return rows.map((row) => {
    const state = stateOf(row, owners);
    return { transcriptId: row.id, current: [...state.memberships.keys()], plan: planTranscript(state, series) };
  });
}

/** The members of one series, re-reconciled (followers or labels changed). */
export async function reconcileSeriesMembers(seriesId: number, actor?: LabelActor | null) {
  bustCuratedSeriesCache();
  return reconcileTranscripts(await listAllMemberIds(seriesId), actor);
}

/**
 * A person attached the meeting to `seriesId` by hand. The route checked
 * they own or edit the SERIES and that the meeting is in its owner's reach
 * (§11.6). Other series the meeting is in are untouched. false = it could
 * not be added (before migration 055, when it already sits in a series).
 */
export async function attachManually(
  seriesId: number,
  row: { id: number; user_id: string; assemblyai_id: string },
  by: { userId: string; email: string }
): Promise<boolean> {
  const ok = await upsertManualMembership(seriesId, row.id, by.userId);
  await reconcileTranscripts([row.id], by);
  publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  return ok;
}

/**
 * A PERSON took a meeting out of a series and its followers lost their
 * shares. That is a removal like deleting the share in the Share dialog —
 * allowed, and recorded in the same ledger, which also keeps automation from
 * re-adding them.
 */
async function recordHumanFollowRemovals(
  gone: FollowShareRef[],
  by: { userId: string; email: string }
): Promise<void> {
  if (gone.length === 0) return;
  const titles = await sql<Array<{ id: number; title: string | null }>>`
    SELECT id, title FROM ${sql(SCHEMA)}.transcripts
    WHERE id = ANY(${[...new Set(gone.map((x) => x.transcript_id))]}::int[])
  `;
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));
  for (const x of gone) {
    await recordAutoShareRemoval({
      transcriptId: x.transcript_id,
      email: x.shared_with_email,
      origin: SHARE_ORIGIN_SERIES_FOLLOW,
      removedByUserId: by.userId,
      removedByEmail: by.email,
      meetingTitle: titleOf.get(x.transcript_id) ?? null,
    }).catch((err) => console.warn('[curated-series] recording a follow removal failed:', err));
  }
}

/**
 * Take the meeting out of `seriesId` — and only that series. `remember` =
 * "not this series": an exclusion the patterns never override. Then the
 * meeting is re-decided (without `remember` a pattern match puts it straight
 * back). A removal that STICKS and cost followers their share is ledgered
 * (by whom); one the patterns undo at once is not. Returns false when it was
 * not a member of `seriesId`.
 */
export async function detachFromSeries(
  seriesId: number,
  row: { id: number; assemblyai_id: string },
  opts: { remember: boolean; userId: string; email: string }
): Promise<boolean> {
  const was = await deleteMembershipIn(seriesId, row.id);
  if (opts.remember) await addExclusion(seriesId, row.id, opts.userId);
  if (!was && !opts.remember) return false;
  publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  const r = await reconcileTranscripts([row.id], { userId: opts.userId, email: opts.email });
  if (r.followSharesRemoved.length > 0 && !(await isMemberOf(seriesId, row.id))) {
    await recordHumanFollowRemovals(r.followSharesRemoved, { userId: opts.userId, email: opts.email });
  }
  return was;
}

/** Delete a series: the row (cascades members, exclusions, editors,
 * followers, the auto-import log) and its label rules — then the former
 * members are re-decided, which takes off the labels and follow shares no
 * other series still gives. The owner's call: no ledger rows (§11.4). */
export async function deleteSeriesFully(seriesId: number): Promise<void> {
  const memberIds = await listAllMemberIds(seriesId);
  await deleteSeriesRow(seriesId);
  await dropSeriesLabelRules(seriesId);
  bustCuratedSeriesCache();
  await reconcileTranscripts(memberIds);
  publishEvent({ kind: 'labels' });
}

/** New follower: a read share of every member the owner may share. */
export async function followSeries(
  seriesId: number,
  person: { email: string; name: string | null },
  by: { userId: string; email: string }
): Promise<{ added: boolean; shares: number }> {
  const added = await insertFollower(seriesId, person, by);
  const r = await reconcileSeriesMembers(seriesId, by);
  const me = person.email.trim().toLowerCase();
  return { added, shares: r.followSharesAdded.filter((x) => x.shared_with_email === me).length };
}

/** Follower removed: their follow shares go wherever no other series they
 * follow still gives them. */
export async function unfollowSeries(seriesId: number, email: string): Promise<{ removed: boolean; shares: number }> {
  const removed = await deleteFollower(seriesId, email);
  const r = await reconcileSeriesMembers(seriesId);
  const me = email.trim().toLowerCase();
  return { removed, shares: r.followSharesRemoved.filter((x) => x.shared_with_email === me).length };
}

export async function addSeriesEditor(
  seriesId: number,
  person: { email: string; name: string | null },
  byEmail: string
): Promise<boolean> {
  const added = await insertEditor(seriesId, person, byEmail);
  bustCuratedSeriesCache();
  return added;
}

export async function removeSeriesEditor(seriesId: number, email: string): Promise<boolean> {
  const removed = await deleteEditor(seriesId, email);
  bustCuratedSeriesCache();
  return removed;
}

/**
 * Hand the series to a new owner (the route checked §11.1). The old owner
 * becomes an editor; the new owner stops being one. Reach changes with the
 * owner, so every meeting is re-decided.
 */
export async function transferSeries(
  seriesId: number,
  to: { userId: string; email: string; name: string | null },
  from: { email: string | null; name: string | null },
  byEmail: string
): Promise<void> {
  await setSeriesOwner(seriesId, to);
  await deleteEditor(seriesId, to.email);
  if (from.email && from.email !== to.email.trim().toLowerCase()) {
    await insertEditor(seriesId, { email: from.email, name: from.name }, byEmail);
  }
  bustCuratedSeriesCache();
  await rematchAll(`series ${seriesId} transferred to ${to.email}`);
}

// ---------------------------------------------------------------------------
// Calendar occurrences (no stored meeting yet) — spec §7, §11.6
// ---------------------------------------------------------------------------

/**
 * The auto-import series that owns a calendar occurrence (§11.2: priority
 * decides): the first matching series, by priority then id, that carries an
 * explicit auto-import setting. Not caller-scoped — the automation resolver
 * (lib/server/auto-import-plan) uses it; never serve its title to a person
 * without a canSeeSeries check.
 */
export async function autoImportSeriesForFacts(facts: SeriesFacts): Promise<CuratedSeries | null> {
  return matchingSeries(await loadCuratedSeries(), facts).find((s) => !!s.auto_import) ?? null;
}

/** A calendar row's series, in the shape the listings serve. */
export interface SeriesHit {
  series_id: number;
  title: string;
  auto_import: SeriesRow['auto_import'];
}

export const toSeriesHit = (s: CuratedSeries): SeriesHit => ({
  series_id: s.id,
  title: s.title,
  auto_import: s.auto_import,
});

export interface OccurrenceForSeries {
  /** Caller's key for the answer map. */
  key: string;
  title: string | null;
  organizerEmail?: string | null;
  recurringEventId?: string | null;
  /** Invitee emails; undefined = not known to the caller (see below). */
  attendees?: string[] | null;
  /** Meet code / `teams-…` stamp + instant — how missing attendees are found. */
  code?: string | null;
  startIso?: string | null;
}

/**
 * Batch form for the calendar listings (calendar-meetings, calendar/events):
 * per occurrence, the first series — by priority, then id — that matches it
 * AND that the CALLER may see (§11.6: never name a series the caller cannot
 * see). When some series has an INVITE rule and an occurrence arrives
 * without its attendees, they are read from the CALLER's OWN calendar row
 * for it (`ownAttendeesForOccurrences` — never another person's calendar).
 */
export async function seriesForOccurrences(
  caller: { userId: string; email: string },
  occs: OccurrenceForSeries[]
): Promise<Map<string, CuratedSeries>> {
  const out = new Map<string, CuratedSeries>();
  if (occs.length === 0) return out;
  const all = await loadCuratedSeries();
  if (all.length === 0) return out;
  const visible = await visibleSeriesIds(caller, await isAuditor(caller.email));
  const series = all.filter((s) => visible.has(s.id) && s.patterns.length > 0);
  if (series.length === 0) return out;
  const needsInvite = series.some((s) => s.patterns.some((p) => p.kind === 'invite'));
  let invitees = new Map<string, string[]>();
  const missing = occs.filter((o) => o.attendees === undefined && o.code && o.startIso);
  if (needsInvite && missing.length > 0) {
    invitees = await ownAttendeesForOccurrences(
      caller.userId,
      missing.map((o) => ({ code: o.code!, startIso: o.startIso! }))
    ).catch(() => new Map<string, string[]>());
  }
  for (const o of occs) {
    const attendees =
      o.attendees ?? (o.code && o.startIso ? invitees.get(`${o.code}|${o.startIso}`) : undefined) ?? [];
    const facts = factsFromCalendarRow({
      title: o.title,
      organizer_email: o.organizerEmail ?? null,
      recurring_event_id: o.recurringEventId ?? null,
      attendees: attendees.map((email) => ({ email })),
    });
    const first = matchingSeries(series, facts)[0];
    if (first) out.set(o.key, first);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview (POST /api/series/preview)
// ---------------------------------------------------------------------------

export interface PreviewResult {
  /** Meetings these patterns match within the REACH previewed (the caller's,
   * or — for an editor of an existing series — its owner's). */
  matched: number;
  /** Of those, the ones the caller owns or holds a share on. */
  visibleToYou: number;
  /** Up to 10 of the caller-visible ones, newest first. */
  sample: Array<{ assemblyai_id: string; title: string | null; when: string }>;
}

/**
 * What would these patterns match within `reach` (§11.6)? Every meeting
 * NAMED in the answer is one the caller can open. Raw pattern matches —
 * exclusions are not applied (a preview answers "what does this grep
 * catch").
 */
export async function previewPatterns(
  patterns: SeriesPattern[],
  reach: SeriesOwnerFacts,
  caller: { userId: string; email: string }
): Promise<PreviewResult> {
  const email = caller.email.trim().toLowerCase();
  const ownsArm = reach.ownerUserId ? sql`t.user_id = ${reach.ownerUserId}::uuid` : sql`false`;
  const reachSql = reach.ownerIsAuditor
    ? sql`true`
    : sql`(${ownsArm} OR EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares rs
        WHERE rs.transcript_id = t.id AND rs.shared_with_email = ${reach.ownerEmail ?? ''}
      ))`;
  const rows = await sql<
    Array<{ assemblyai_id: string; title: string | null; ctx: SeriesContextFields | null; at: string; visible: boolean }>
  >`
    SELECT t.assemblyai_id, t.title,
           jsonb_build_object(
             'eventTitle', t.gmeet_context->>'eventTitle',
             'organizerEmail', t.gmeet_context->>'organizerEmail',
             'recurringEventId', t.gmeet_context->>'recurringEventId',
             'attendees', CASE WHEN jsonb_typeof(t.gmeet_context->'attendees') = 'array'
                               THEN t.gmeet_context->'attendees' END
           ) AS ctx,
           COALESCE(t.recorded_at, t.created_at)::text AS at,
           (t.user_id = ${caller.userId} OR EXISTS (
             SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares sh
             WHERE sh.transcript_id = t.id AND sh.shared_with_email = ${email}
           )) AS visible
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE t.deleted_at IS NULL AND NOT t.scratch
      AND ${reachSql}
  `;
  let matched = 0;
  const visible: Array<{ assemblyai_id: string; title: string | null; when: string }> = [];
  for (const r of rows) {
    if (!seriesMatches(patterns, factsFromContext({ title: r.title, gmeet_context: r.ctx }))) continue;
    matched++;
    if (r.visible) visible.push({ assemblyai_id: r.assemblyai_id, title: r.title, when: r.at });
  }
  visible.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
  return { matched, visibleToYou: visible.length, sample: visible.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Definition edits that change who belongs
// ---------------------------------------------------------------------------

/** After a create or a patterns change: re-decide every meeting. */
export async function onSeriesMatchingChanged(seriesId: number, why: string): Promise<void> {
  bustCuratedSeriesCache();
  await rematchAll(`series ${seriesId} ${why}`);
}

// ---------------------------------------------------------------------------
// The 10-minute backstop
// ---------------------------------------------------------------------------

export function startCuratedSeriesSweeper(): void {
  if (g.__mwCuratedSeriesSweep) return;
  const tick = async () => {
    await rematchAll('sweep');
  };
  g.__mwCuratedSeriesSweep = setInterval(unlessDraining('curated-series', tick), SWEEP_MS);
  g.__mwCuratedSeriesSweep.unref?.();
  setTimeout(unlessDraining('curated-series', tick), 3 * 60_000).unref?.();
  console.log('[curated-series] re-match sweeper armed (every 10 min)');
}
