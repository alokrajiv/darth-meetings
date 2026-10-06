import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { unlessDraining } from '@/lib/server/deploy-drain';
import { curatedSeriesReady } from '@/db-ops/curated-series-schema';
import {
  addExclusion,
  deleteAutoMembership,
  deleteMembershipIn,
  deleteSeriesRow,
  getMembership,
  insertAutoMembership,
  listAllMemberIds,
  listAllSeries,
  listMemberRefs,
  upsertManualMembership,
  type SeriesRow,
} from '@/db-ops/series';
import { deleteFollower, insertFollower, listFollowers } from '@/db-ops/series-followers';
import { addAutoReadShares, removeAutoReadShares } from '@/db-ops/auditor-shares';
import {
  applySeriesLabels,
  dropSeriesLabelRules,
  removeSeriesRuleLabels,
} from '@/lib/server/series-labels';
import { SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';
import { ownAttendeesForOccurrences } from '@/db-ops/calendar-event-cache';
import {
  factsFromCalendarRow,
  factsFromContext,
  pickSeries,
  seriesMatches,
  type SeriesContextFields,
  type SeriesFacts,
  type SeriesPattern,
} from '@/lib/series-patterns';
import type { LabelActor } from '@/db-ops/labels';

/**
 * THE membership engine for curated series (docs/curated-series-spec.md §3):
 * which series a meeting is in, and everything that follows a membership —
 * the series' default labels (§4, lib/server/series-labels.ts) and its
 * followers' read shares (§5).
 *
 *  - `syncSeriesForTranscript(id)` — one meeting: compute its facts, keep a
 *    MANUAL membership as it is, otherwise the winner = the best-priority
 *    series whose patterns match, minus the series it was excluded from;
 *    add / move / remove the 'auto' membership and run the leave + join
 *    effects for the old and new series. Trashed or temporary rows lose an
 *    auto membership. Called from every import path, link-event, restore.
 *  - `rematchAll()` — every row, after a series is created or its patterns
 *    or priority change, and every 10 minutes as a backstop (catches
 *    retitles and links that no hook saw).
 *  - leave/join effects: join → default labels + follow shares; leave → the
 *    labels this series' rules made and its followers' 'series-follow'
 *    shares come off. Nothing a person did by hand is touched.
 *
 * Nothing here runs until migration 053 is applied (curatedSeriesReady):
 * without it there are no patterns, no followers and no ledger origin.
 *
 * Never throws out of the import-path entry point — series bookkeeping must
 * not fail an import.
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
}

const g = globalThis as unknown as {
  __mwCuratedSeriesCache?: { at: number; series: CuratedSeries[] };
  __mwCuratedSeriesSweep?: ReturnType<typeof setInterval> | null;
};

/** Every series with its matcher inputs — cached ~60 s per process, busted
 * on every series write in this process. */
export async function loadCuratedSeries(): Promise<CuratedSeries[]> {
  const hit = g.__mwCuratedSeriesCache;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.series;
  const rows = await listAllSeries();
  const series = rows.map((r) => ({
    id: r.id,
    title: r.title,
    priority: r.priority,
    patterns: r.patterns,
    auto_import: r.auto_import,
  }));
  g.__mwCuratedSeriesCache = { at: Date.now(), series };
  return series;
}

export function bustCuratedSeriesCache(): void {
  g.__mwCuratedSeriesCache = undefined;
}

// ---------------------------------------------------------------------------
// The membership decision (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface MembershipState {
  /** Current membership, if any. */
  seriesId: number | null;
  /** 'auto' | 'manual' (legacy 'confirmed' counts as a human answer). */
  how: string | null;
  /** Trashed or temporary: out of the archive, so out of any auto series. */
  outOfArchive: boolean;
  facts: SeriesFacts;
  excluded: ReadonlySet<number>;
}

export type MembershipDecision =
  | { action: 'none' }
  | { action: 'join'; to: number }
  | { action: 'leave'; from: number }
  | { action: 'move'; from: number; to: number };

export function decideMembership(
  state: MembershipState,
  series: readonly CuratedSeries[]
): MembershipDecision {
  const manual = state.seriesId !== null && state.how !== 'auto';
  if (manual) return { action: 'none' }; // a person put it there — leave it alone
  const winner = state.outOfArchive ? null : pickSeries(series, state.facts, state.excluded);
  const to = winner?.id ?? null;
  const from = state.seriesId;
  if (to === from) return { action: 'none' };
  if (from === null) return { action: 'join', to: to! };
  if (to === null) return { action: 'leave', from };
  return { action: 'move', from, to };
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
  series_id: number | null;
  how: string | null;
  excluded: number[] | null;
}

/** The projection the matcher needs — only the four context fields, never
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
  m.series_id, m.how,
  (SELECT array_agg(x.series_id) FROM ${sql(SCHEMA)}.series_exclusions x
    WHERE x.transcript_id = t.id) AS excluded
`;

function stateOf(row: SyncRow): MembershipState {
  return {
    seriesId: row.series_id,
    how: row.how,
    outOfArchive: row.deleted || row.scratch,
    facts: factsFromContext({ title: row.title, gmeet_context: row.ctx }),
    excluded: new Set(row.excluded ?? []),
  };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

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

/** Follow shares of `seriesId`'s followers on these meetings (owner skipped,
 * the removal ledger respected inside addAutoReadShares). */
async function addFollowShares(
  seriesId: number,
  members: Array<{ transcript_id: number; user_id: string }>,
  onlyEmails?: string[]
): Promise<number> {
  if (members.length === 0) return 0;
  let followers = (await listFollowers([seriesId])).map((f) => ({ email: f.email, name: f.name }));
  if (onlyEmails) {
    const only = new Set(onlyEmails.map((e) => e.toLowerCase()));
    followers = followers.filter((f) => only.has(f.email));
  }
  if (followers.length === 0) return 0;
  const owners = await ownerEmailsFor(members.map((m) => m.user_id));
  let added = 0;
  for (const m of members) {
    const ownerEmails = owners.get(m.user_id) ?? new Set<string>();
    const people = followers.filter((f) => !ownerEmails.has(f.email));
    added += (await addAutoReadShares(m.transcript_id, m.user_id, people, SHARE_ORIGIN_SERIES_FOLLOW)).length;
  }
  return added;
}

async function joinEffects(
  seriesId: number,
  members: Array<{ transcript_id: number; user_id: string }>,
  actor?: LabelActor | null
): Promise<void> {
  const ids = members.map((m) => m.transcript_id);
  await applySeriesLabels(seriesId, ids, actor).catch((err) =>
    console.warn(`[curated-series] labels on join failed (series ${seriesId}):`, err)
  );
  await addFollowShares(seriesId, members).catch((err) =>
    console.warn(`[curated-series] follow shares on join failed (series ${seriesId}):`, err)
  );
}

async function leaveEffects(seriesId: number, transcriptIds: number[]): Promise<void> {
  if (transcriptIds.length === 0) return;
  await removeSeriesRuleLabels(seriesId, transcriptIds).catch((err) =>
    console.warn(`[curated-series] labels on leave failed (series ${seriesId}):`, err)
  );
  const followers = await listFollowers([seriesId]).catch(() => []);
  if (followers.length > 0) {
    await removeAutoReadShares({
      transcriptIds,
      emails: followers.map((f) => f.email),
      origin: SHARE_ORIGIN_SERIES_FOLLOW,
    }).catch((err) => console.warn(`[curated-series] follow shares on leave failed (series ${seriesId}):`, err));
  }
}

/** Carry out one decision for one row. Returns what actually happened (the
 * guarded writes may lose a race to a person's manual attach). */
async function applyDecision(
  row: Pick<SyncRow, 'id' | 'user_id' | 'assemblyai_id'>,
  d: MembershipDecision
): Promise<'joined' | 'left' | 'moved' | 'none'> {
  if (d.action === 'none') return 'none';
  let left = false;
  if (d.action === 'leave' || d.action === 'move') {
    left = await deleteAutoMembership(d.from, row.id);
    if (left) await leaveEffects(d.from, [row.id]);
  }
  let joined = false;
  if (d.action === 'join' || d.action === 'move') {
    joined = await insertAutoMembership(d.to, row.id);
    if (joined) await joinEffects(d.to, [{ transcript_id: row.id, user_id: row.user_id }]);
  }
  if (left || joined) publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  return left && joined ? 'moved' : joined ? 'joined' : left ? 'left' : 'none';
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Re-decide one meeting's series. Every import path calls this after the row
 * exists (ingest, ingest-parsed, clip split, recording actions), as do
 * link-event (an event link changes the facts) and restore. Never throws.
 */
export async function syncSeriesForTranscript(transcriptId: number): Promise<void> {
  try {
    if (!(await curatedSeriesReady())) return;
    const [row] = await sql<SyncRow[]>`
      SELECT ${SYNC_COLUMNS()}
      FROM ${sql(SCHEMA)}.transcripts t
      LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.transcript_id = t.id
      WHERE t.id = ${transcriptId}
    `;
    if (!row) return;
    const series = await loadCuratedSeries();
    const outcome = await applyDecision(row, decideMembership(stateOf(row), series));
    if (outcome !== 'none') {
      console.log(`[curated-series] transcript ${transcriptId}: ${outcome}`);
    }
  } catch (err) {
    console.warn(`[curated-series] sync failed for transcript ${transcriptId} (continuing):`, err);
  }
}

/**
 * Re-decide every meeting: all live non-temporary rows, plus any member that
 * went out of the archive (to drop its auto membership). Logs
 * `[curated-series] rematch: +N −M moved K`.
 */
export async function rematchAll(reason = 'sweep'): Promise<{ joined: number; left: number; moved: number }> {
  const out = { joined: 0, left: 0, moved: 0 };
  if (!(await curatedSeriesReady())) return out;
  bustCuratedSeriesCache();
  const series = await loadCuratedSeries();
  const rows = await sql<SyncRow[]>`
    SELECT ${SYNC_COLUMNS()}
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.transcript_id = t.id
    WHERE (t.deleted_at IS NULL AND NOT t.scratch) OR m.id IS NOT NULL
  `;
  for (const row of rows) {
    try {
      const r = await applyDecision(row, decideMembership(stateOf(row), series));
      if (r === 'joined') out.joined++;
      else if (r === 'left') out.left++;
      else if (r === 'moved') out.moved++;
    } catch (err) {
      console.warn(`[curated-series] rematch skipped transcript ${row.id}:`, err);
    }
  }
  console.log(`[curated-series] rematch (${reason}): +${out.joined} −${out.left} moved ${out.moved}`);
  return out;
}

/** A person attached the meeting to `seriesId` (the route checked they own
 * or edit it). Moves it out of any other series first. */
export async function attachManually(
  seriesId: number,
  row: { id: number; user_id: string; assemblyai_id: string },
  by: { userId: string; email: string }
): Promise<void> {
  const prev = await getMembership(row.id);
  await upsertManualMembership(seriesId, row.id, by.userId);
  if (prev && prev.series_id !== seriesId) await leaveEffects(prev.series_id, [row.id]);
  if (!prev || prev.series_id !== seriesId) {
    await joinEffects(seriesId, [{ transcript_id: row.id, user_id: row.user_id }], by);
  }
  publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
}

/**
 * Take the meeting out of `seriesId` — and only that series (a stale tab
 * must not detach it from wherever it moved since). `remember` = "not this
 * series": an exclusion the patterns never override. Then the meeting is
 * re-decided (without `remember` a pattern match puts it straight back).
 * Returns false when it was not a member of `seriesId`.
 */
export async function detachFromSeries(
  seriesId: number,
  row: { id: number; assemblyai_id: string },
  opts: { remember: boolean; userId: string }
): Promise<boolean> {
  const was = await deleteMembershipIn(seriesId, row.id);
  if (was) await leaveEffects(seriesId, [row.id]);
  if (opts.remember) await addExclusion(seriesId, row.id, opts.userId);
  if (!was && !opts.remember) return false;
  publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  await syncSeriesForTranscript(row.id);
  return was;
}

/** Delete a series: labels + follow shares off every member, the row (which
 * cascades members, exclusions, followers, the auto-import log), its label
 * rules — then the former members are re-decided (another series may now
 * win them). */
export async function deleteSeriesFully(seriesId: number): Promise<void> {
  const memberIds = await listAllMemberIds(seriesId);
  await leaveEffects(seriesId, memberIds);
  await deleteSeriesRow(seriesId);
  await dropSeriesLabelRules(seriesId);
  bustCuratedSeriesCache();
  for (const id of memberIds) await syncSeriesForTranscript(id);
  publishEvent({ kind: 'labels' });
}

/** New follower: a read share of every current member. */
export async function followSeries(
  seriesId: number,
  person: { email: string; name: string | null },
  by: { userId: string; email: string }
): Promise<{ added: boolean; shares: number }> {
  const added = await insertFollower(seriesId, person, by);
  const members = await listMemberRefs(seriesId);
  const shares = await addFollowShares(seriesId, members, [person.email]);
  return { added, shares };
}

/** Follower removed: their follow shares on this series' members go. */
export async function unfollowSeries(seriesId: number, email: string): Promise<{ removed: boolean; shares: number }> {
  const removed = await deleteFollower(seriesId, email);
  const memberIds = await listAllMemberIds(seriesId);
  const gone = await removeAutoReadShares({
    transcriptIds: memberIds,
    emails: [email],
    origin: SHARE_ORIGIN_SERIES_FOLLOW,
  });
  return { removed, shares: gone.length };
}

// ---------------------------------------------------------------------------
// Calendar occurrences (no stored meeting yet) — spec §7
// ---------------------------------------------------------------------------

/** The series a calendar occurrence belongs to: the same winner rule as
 * membership (an import of it joins exactly this series), minus exclusions,
 * which belong to stored meetings. */
export async function seriesForFacts(facts: SeriesFacts): Promise<CuratedSeries | null> {
  return pickSeries(await loadCuratedSeries(), facts);
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
 * Batch form for the calendar listings (calendar-meetings, calendar/events)
 * and the auto-import owner: the series of each occurrence, keyed by `key`.
 * When some series has an INVITE rule and an occurrence arrives without its
 * attendees, they are read from the CALLER's OWN calendar row for it
 * (`ownAttendeesForOccurrences` — never another person's calendar).
 */
export async function seriesForOccurrences(
  callerUserId: string | null,
  occs: OccurrenceForSeries[]
): Promise<Map<string, CuratedSeries>> {
  const out = new Map<string, CuratedSeries>();
  if (occs.length === 0) return out;
  const series = await loadCuratedSeries();
  if (series.every((s) => s.patterns.length === 0)) return out;
  const needsInvite = series.some((s) => s.patterns.some((p) => p.kind === 'invite'));
  let invitees = new Map<string, string[]>();
  const missing = occs.filter((o) => o.attendees === undefined && o.code && o.startIso);
  if (needsInvite && callerUserId && missing.length > 0) {
    invitees = await ownAttendeesForOccurrences(
      callerUserId,
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
    const winner = pickSeries(series, facts);
    if (winner) out.set(o.key, winner);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview (POST /api/series/preview)
// ---------------------------------------------------------------------------

export interface PreviewResult {
  /** Meetings these patterns match, org-wide — a NUMBER only. */
  matched: number;
  /** Of those, the ones the caller owns or holds a share on. */
  visibleToYou: number;
  /** Up to 10 of the caller-visible ones, newest first. */
  sample: Array<{ assemblyai_id: string; title: string | null; when: string }>;
}

/**
 * What would these patterns match? The global count is a number and nothing
 * more; every meeting NAMED in the answer is one the caller can open
 * (spec §6). Raw pattern matches — priority and exclusions are not applied
 * (a preview answers "what does this grep catch").
 */
export async function previewPatterns(
  patterns: SeriesPattern[],
  caller: { userId: string; email: string }
): Promise<PreviewResult> {
  const email = caller.email.trim().toLowerCase();
  const rows = await sql<
    Array<SyncRow & { visible: boolean; at: string }>
  >`
    SELECT ${SYNC_COLUMNS()},
           COALESCE(t.recorded_at, t.created_at)::text AS at,
           (t.user_id = ${caller.userId} OR EXISTS (
             SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares sh
             WHERE sh.transcript_id = t.id AND sh.shared_with_email = ${email}
           )) AS visible
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.transcript_id = t.id
    WHERE t.deleted_at IS NULL AND NOT t.scratch
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

/** After a create or a patterns/priority change: re-decide every meeting. */
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
