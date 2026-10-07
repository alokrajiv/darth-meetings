/**
 * Curated series v2 — seed OWNERSHIP (docs/curated-series-spec.md §11.10):
 * set owner, editors and followers for existing series from a table Alok
 * confirms, then ONE `rematchAll()`. DRY RUN unless `--apply`.
 *
 *   bun --env-file=.env.local --conditions=react-server scripts/series-ownership-seed.ts                 # dry run
 *   bun --env-file=.env.local --conditions=react-server scripts/series-ownership-seed.ts --apply
 *   … --table /path/to/ownership.json      # the table from a JSON file instead of OWNERSHIP below
 *
 * Run on the VM from the LIVE colour's app dir, AFTER migration 054 and the
 * v2 deploy (055 may come before or after — before it a meeting stays in its
 * first series).
 *
 * The table: one row per series —
 *   { "seriesId": 66, "ownerEmail": "alok@trames.sg",
 *     "editors": ["ivan@trames.sg"], "followers": ["alok@trames.sg"] }
 * `editors` / `followers` are the COMPLETE lists: people not listed are
 * removed. Series not in the table are left as they are.
 *
 * Dry run (reads only): validates the table (company addresses, owners who
 * have opened the app, an auditor-owned series has only auditor editors),
 * then plans a full rematch against the PROPOSED owners/editors/followers
 * with the engine's own planner (lib/server/curated-series planEverything)
 * and prints per series: owner/editors/followers before → after, members
 * before → after, and the follow shares that would be added / removed. It
 * also warns when a series' auto-import enabler would no longer be its owner
 * or an editor (the sweep stops firing for such a binding — §11.7).
 *
 * `--apply` writes owner + editors + followers through the db-ops layer, then
 * `rematchAll()` (the engine adds/removes memberships, labels and follow
 * shares), and prints the same per-series lines from the database. Removing
 * follow shares here is a POLICY change, not a person's removal of a meeting:
 * no ledger rows are written (the engine never ledgers).
 *
 * Exit code 0 = done, 1 = a write failed, 2 = refused before writing.
 */

import { readFileSync } from 'node:fs';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { seriesOwnershipReady } from '@/db-ops/series-ownership-schema';
import { listAllSeries, setSeriesOwner } from '@/db-ops/series';
import { deleteEditor, insertEditor, listAllEditors } from '@/db-ops/series-editors';
import { deleteFollower, insertFollower, listAllFollowers } from '@/db-ops/series-followers';
import { auditorEmails } from '@/db-ops/auditors';
import { userIdForEmail } from '@/db-ops/transcript-activity';
import {
  bustCuratedSeriesCache,
  loadCuratedSeries,
  planEverything,
  rematchAll,
  type CuratedSeries,
} from '@/lib/server/curated-series';
import { INTERNAL_DOMAINS } from '@/lib/internal-domains';
import { resolveLabelPaths } from '@/lib/server/series-api';
import { setSeriesLabels } from '@/lib/server/series-labels';
import { SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';

export interface OwnershipRow {
  seriesId: number;
  ownerEmail: string;
  editors: string[];
  followers: string[];
  /** Optional: REPLACE the series' default labels with these label paths
   * (missing paths are created). Omitted = labels left as they are. */
  labels?: string[];
}

// ===========================================================================
// The table Alok confirmed 2026-10-07: the lead who chairs each call owns it,
// co-chairs/leads edit (KB company/org-chart.md), Ivan and Alok edit everything
// (Alok's auto-imports need owner/editor), Alok follows all (as an auditor he gets every member).
// ===========================================================================
const OWNERSHIP: OwnershipRow[] = [
  { seriesId: 66, ownerEmail: 'ameya@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'radhika.rungta@trames-engineering.com', 'varadraj.sharma@trames.sg', 'indresh.upadhyay@trames-engineering.com'] },
  // #67 NOT applied yet (2026-10-07): Preet is not shared the 30 older occurrences she
  // organised (organizer not in attendees) — see docs/tech-debt/2026-10-07-one-person-several-emails.md.
  { seriesId: 67, ownerEmail: 'preet.singh@trames.sg', editors: ['ankit@trames.sg', 'ameya@trames.sg', 'kawen.koh@trames.sg', 'jacqueline.ng@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'swaralee@trames.sg'] },
  { seriesId: 68, ownerEmail: 'ankit@trames.sg', editors: ['chaitanya.konkar@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'kawen.koh@trames.sg', 'jacqueline.ng@trames.sg'] },
  { seriesId: 69, ownerEmail: 'ankit@trames.sg', editors: ['chaitanya.konkar@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'aniket.gore@trames-engineering.com', 'hitesh.ambaliya@trames-engineering.com', 'karnica.katiyar@trames-engineering.com', 'shridhar.tirthkar@trames-engineering.com', 'meghana.uppaluri@trames-engineering.com', 'komuravelly.nikhil@trames.sg'] },
  { seriesId: 70, ownerEmail: 'ankit@trames.sg', editors: ['chaitanya.konkar@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'ayush.agarwal@trames-engineering.com', 'sandip.singh@trames.sg', 'preet.singh@trames.sg'], labels: ['Team/Integration'] },
  { seriesId: 71, ownerEmail: 'chaitanya.konkar@trames.sg', editors: ['ankit@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'shridhar.tirthkar@trames-engineering.com', 'komuravelly.nikhil@trames.sg', 'meghana.uppaluri@trames-engineering.com'] },
  { seriesId: 72, ownerEmail: 'yadu.nm@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'pratiksha.mali@trames.sg', 'vignesh.sanmugam@trames-engineering.com'] },
  { seriesId: 73, ownerEmail: 'preet.singh@trames.sg', editors: ['kawen.koh@trames.sg', 'jacqueline.ng@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'swaralee@trames.sg'] },
  { seriesId: 74, ownerEmail: 'jacqueline.ng@trames.sg', editors: ['kawen.koh@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'chirag.anand@trames-engineering.com', 'ashey.sharma@trames-engineering.com'] },
  { seriesId: 75, ownerEmail: 'jacqueline.ng@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
  { seriesId: 76, ownerEmail: 'kawen.koh@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
  { seriesId: 77, ownerEmail: 'aniq.danial@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
  { seriesId: 78, ownerEmail: 'swaralee@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
  { seriesId: 79, ownerEmail: 'siqian.loh@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
  { seriesId: 80, ownerEmail: 'iman.sani@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
  { seriesId: 81, ownerEmail: 'aniq.danial@trames.sg', editors: ['ain.abdullah@trames.sg', 'ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg', 'nina.ghazzi@trames.sg'] },
  { seriesId: 82, ownerEmail: 'swaralee@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
  { seriesId: 83, ownerEmail: 'kawen.koh@trames.sg', editors: ['ivan@trames.sg', 'alok@trames.sg'], followers: ['alok@trames.sg'] },
];
// ===========================================================================

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'usage: bun --env-file=.env.local --conditions=react-server scripts/series-ownership-seed.ts [--table file.json] [--apply]'
  );
  process.exit(0);
}
const tableArg = argv.indexOf('--table');
const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const ACTOR_EMAIL = 'alok@trames.sg';

const norm = (e: string) => e.trim().toLowerCase();
const isInternal = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && INTERNAL_DOMAINS.has(e.split('@')[1] ?? '');
const list = (xs: string[]) => (xs.length ? xs.join(', ') : '—');

function loadTable(): OwnershipRow[] {
  if (tableArg < 0) return OWNERSHIP;
  const path = argv[tableArg + 1];
  if (!path) throw new Error('--table needs a file path');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('--table: the file must hold a JSON array of rows');
  return raw as OwnershipRow[];
}

async function main(): Promise<number> {
  console.log(`series ownership seed — ${APPLY ? 'APPLY' : 'dry run'} — schema ${SCHEMA}`);
  console.log('─────────────────────────────────────────────────────────────');

  const table = loadTable().map((r) => ({
    seriesId: Number(r.seriesId),
    ownerEmail: norm(String(r.ownerEmail ?? '')),
    editors: [...new Set((r.editors ?? []).map(norm))],
    followers: [...new Set((r.followers ?? []).map(norm))],
    labels: Array.isArray(r.labels) ? r.labels.map((x) => String(x).trim()).filter(Boolean) : undefined,
  }));
  for (const r of table) if (r.labels) console.log(`labels   #${r.seriesId} → ${list(r.labels)}`);
  if (table.length === 0) {
    console.error('refused: the ownership table is empty (fill OWNERSHIP in this script, or pass --table file.json)');
    return 2;
  }
  if (!(await seriesOwnershipReady())) {
    console.error('refused: migrations 053/054 are not applied (scripts/vm-apply-migration.sh 054 first)');
    return 2;
  }

  // ---- validate --------------------------------------------------------------
  const [rows, editorsNow, followersNow, auditors] = await Promise.all([
    listAllSeries(),
    listAllEditors(),
    listAllFollowers(),
    auditorEmails(),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ownerIds = new Map<string, string>();
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const r of table) {
    const s = byId.get(r.seriesId);
    if (!Number.isInteger(r.seriesId) || !s) problems.push(`#${r.seriesId}: no such series`);
    if (seen.has(r.seriesId)) problems.push(`#${r.seriesId}: listed twice`);
    seen.add(r.seriesId);
    for (const e of [r.ownerEmail, ...r.editors, ...r.followers]) {
      if (!isInternal(e)) problems.push(`#${r.seriesId}: "${e}" is not a company address`);
    }
    if (!ownerIds.has(r.ownerEmail)) {
      const id = await userIdForEmail(r.ownerEmail);
      if (id) ownerIds.set(r.ownerEmail, id);
      // Allowed (Alok 2026-10-07: @trames.sg is the true identity): reach is
      // what is shared to that address; the id fills in when they sign in.
      else console.log(`note     #${r.seriesId}: owner ${r.ownerEmail} has not opened Darth Meetings yet — no user id until they do`);
    }
    if (auditors.has(r.ownerEmail)) {
      const bad = r.editors.filter((e) => !auditors.has(e));
      if (bad.length) problems.push(`#${r.seriesId}: auditor-owned, so editors must be auditors — not ${bad.join(', ')}`);
    }
    if (r.editors.includes(r.ownerEmail)) problems.push(`#${r.seriesId}: the owner is also listed as an editor`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`refused: ${p}`);
    return 2;
  }

  // ---- plan against the proposed table ------------------------------------
  bustCuratedSeriesCache();
  const live = await loadCuratedSeries();
  const proposed: CuratedSeries[] = live.map((s) => {
    const r = table.find((x) => x.seriesId === s.id);
    if (!r) return s;
    return {
      ...s,
      ownerEmail: r.ownerEmail,
      ownerUserId: ownerIds.get(r.ownerEmail) ?? null,
      ownerIsAuditor: auditors.has(r.ownerEmail),
      editors: r.editors,
      followers: r.followers.map((email) => ({
        email,
        name: followersNow.find((f) => f.email === email)?.name ?? null,
      })),
    };
  });
  const plans = await planEverything(proposed);

  for (const r of table) {
    const s = byId.get(r.seriesId)!;
    const before = plans.filter((p) => p.current.includes(r.seriesId)).map((p) => p.transcriptId);
    const after = plans.filter((p) => p.plan.membersOf.includes(r.seriesId)).map((p) => p.transcriptId);
    const touched = new Set([...before, ...after]);
    const added = plans
      .filter((p) => touched.has(p.transcriptId))
      .flatMap((p) => p.plan.shareInserts.map((x) => x.email));
    const removed = plans.filter((p) => touched.has(p.transcriptId)).flatMap((p) => p.plan.shareDeletes);
    const tally = (xs: string[]) =>
      [...xs.reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map<string, number>())]
        .map(([e, n]) => `${e} ×${n}`)
        .join(', ') || '—';
    console.log(`#${s.id}  ${s.title}`);
    console.log(`    owner:     ${s.owner_email ?? '(none)'} → ${r.ownerEmail}${auditors.has(r.ownerEmail) ? ' (auditor — every meeting)' : ''}`);
    console.log(
      `    editors:   ${list(editorsNow.filter((e) => e.series_id === s.id).map((e) => e.email))} → ${list(r.editors)}`
    );
    console.log(
      `    followers: ${list(followersNow.filter((f) => f.series_id === s.id).map((f) => f.email))} → ${list(r.followers)}`
    );
    console.log(`    members:   ${before.length} → ${after.length}`);
    console.log(`    follow shares on its meetings: +${added.length} (${tally(added)})  −${removed.length} (${tally(removed)})`);
    const ai = s.auto_import;
    if (ai) {
      const by = norm(ai.byEmail);
      if (by !== r.ownerEmail && !r.editors.includes(by)) {
        console.log(
          `    WARNING: auto-import is bound to ${ai.byEmail}, who would be neither owner nor editor — the sweep stops firing for it (add them as an editor to keep it)`
        );
      }
    }
  }
  const allAdded = plans.reduce((n, p) => n + p.plan.shareInserts.length, 0);
  const allRemoved = plans.reduce((n, p) => n + p.plan.shareDeletes.length, 0);
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`whole rematch (every series): follow shares +${allAdded} −${allRemoved}`);

  if (!APPLY) {
    console.log('dry run — nothing written. Re-run with --apply to write.');
    return 0;
  }

  // ---- apply ----------------------------------------------------------------
  console.log('─────────────────────────────────────────────────────────────');
  const countMembers = async () =>
    new Map(
      (
        await sql<Array<{ series_id: number; n: number }>>`
          SELECT series_id, count(*)::int AS n FROM ${sql(SCHEMA)}.series_members GROUP BY series_id
        `
      ).map((x) => [x.series_id, x.n])
    );
  const followShares = async () =>
    new Set(
      (
        await sql<Array<{ k: string }>>`
          SELECT transcript_id || '|' || lower(shared_with_email) AS k
          FROM ${sql(SCHEMA)}.transcript_shares WHERE origin = ${SHARE_ORIGIN_SERIES_FOLLOW}
        `
      ).map((x) => x.k)
    );
  const actorId = (await userIdForEmail(ACTOR_EMAIL)) ?? ownerIds.get(table[0]!.ownerEmail)!;
  const membersBefore = await countMembers();
  const sharesBefore = await followShares();
  let failed = 0;
  for (const r of table) {
    try {
      await setSeriesOwner(r.seriesId, { userId: ownerIds.get(r.ownerEmail) ?? null, email: r.ownerEmail });
      const curEditors = editorsNow.filter((e) => e.series_id === r.seriesId).map((e) => e.email);
      for (const e of curEditors) if (!r.editors.includes(e)) await deleteEditor(r.seriesId, e);
      for (const e of r.editors) {
        if (!curEditors.includes(e)) await insertEditor(r.seriesId, { email: e, name: null }, ACTOR_EMAIL);
      }
      const curFollowers = followersNow.filter((f) => f.series_id === r.seriesId).map((f) => f.email);
      for (const e of curFollowers) if (!r.followers.includes(e)) await deleteFollower(r.seriesId, e);
      for (const e of r.followers) {
        if (!curFollowers.includes(e)) {
          await insertFollower(r.seriesId, { email: e, name: null }, { userId: actorId, email: ACTOR_EMAIL });
        }
      }
      if (r.labels) {
        const actor = { userId: actorId, email: ACTOR_EMAIL };
        await setSeriesLabels(r.seriesId, await resolveLabelPaths(r.labels, actor), actor);
      }
      console.log(`set      #${r.seriesId}  owner ${r.ownerEmail}`);
    } catch (err) {
      failed++;
      console.error(`FAILED   #${r.seriesId}:`, err);
    }
  }
  const rm = await rematchAll('ownership seed');
  console.log(`rematch: +${rm.joined} −${rm.left} (${rm.changed} meetings changed)`);
  const membersAfter = await countMembers();
  const sharesAfter = await followShares();
  for (const r of table) {
    console.log(
      `  #${String(r.seriesId).padEnd(4)} members ${membersBefore.get(r.seriesId) ?? 0} → ${membersAfter.get(r.seriesId) ?? 0}  ${byId.get(r.seriesId)!.title}`
    );
  }
  const plus = [...sharesAfter].filter((k) => !sharesBefore.has(k)).length;
  const minus = [...sharesBefore].filter((k) => !sharesAfter.has(k)).length;
  console.log(`follow shares: +${plus} −${minus} (no ledger rows — a policy change, not a person's removal)`);
  return failed > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    console.log('─────────────────────────────────────────────────────────────');
    await sql.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[series-ownership-seed] failed:', err);
    await sql.end().catch(() => {});
    process.exit(2);
  });
