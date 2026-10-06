/**
 * Curated series — the seed set (docs/curated-series-spec.md §8 step 4, the
 * table Alok approved 2026-10-06). DRY RUN unless `--apply`.
 *
 *   bun --env-file=.env.local --conditions=react-server scripts/curated-series-seed.ts           # dry run
 *   bun --env-file=.env.local --conditions=react-server scripts/curated-series-seed.ts --apply
 *
 * Run on the VM from the LIVE colour's app dir, AFTER migration 053, the
 * deploy, and scripts/curated-series-reset.sql.
 *
 * Dry run (reads only): validates every seed pattern, resolves the two
 * auto-import enablers that are not Alok by email, says which default-label
 * paths exist and which would be created, lists any series already present,
 * and prints what each seed series would match today (count + up to 3
 * titles, the same matcher + priority rule the app uses) and how many
 * meetings no seed series catches.
 *
 * `--apply` goes through the app's own layers (db-ops + the membership
 * engine), not raw SQL, so labels, rules and the follower path are the real
 * code: per seed row create the series — or, when one with the exact same
 * name already exists (a re-run after a partial failure), update its
 * description / patterns / priority — set its default labels (missing paths
 * are created), carry its auto-import config, add Alok as follower; then ONE
 * `rematchAll()` and the per-series member counts. Idempotent: a re-run
 * converges.
 *
 * The acting user for everything is Alok (bf547379-…, alok@trames.sg).
 * Exit code 0 = done, 1 = a series failed, 2 = refused before writing.
 */

import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { curatedSeriesReady } from '@/db-ops/curated-series-schema';
import {
  createSeries,
  getSeriesByTitle,
  listAllSeries,
  setSeriesAutoImport,
  updateSeries,
  type SeriesAutoImportCfg,
} from '@/db-ops/series';
import { getLabelByPath } from '@/db-ops/labels';
import { userIdForEmail } from '@/db-ops/transcript-activity';
import { setSeriesLabels } from '@/lib/server/series-labels';
import { followSeries, rematchAll } from '@/lib/server/curated-series';
import { resolveLabelPaths } from '@/lib/server/series-api';
import { factsFromContext, pickSeries, validatePatterns, type SeriesPattern } from '@/lib/series-patterns';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: bun --env-file=.env.local --conditions=react-server scripts/curated-series-seed.ts [--apply]');
  process.exit(0);
}

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const ACTOR = { userId: 'bf547379-4c7e-4e17-932e-0246e50bfe54', email: 'alok@trames.sg' };
const FOLLOWERS = [{ email: 'alok@trames.sg', name: 'Alok Rajiv' }];

// ---------------------------------------------------------------------------
// The auto-import configs carried from the old series (values from the
// 2026-10-06 backup, given by the orchestrating session). An enabler whose
// user id is `lookup` is resolved by email at run time — and must start with
// `expectPrefix` when one is known (the backup value was truncated).
// ---------------------------------------------------------------------------

interface CarriedAutoImport {
  cfg: Omit<SeriesAutoImportCfg, 'byUserId'> & { byUserId: string | 'lookup' };
  expectPrefix?: string;
}

const ALOK_AI = (mode: SeriesAutoImportCfg['mode'], since: string): CarriedAutoImport => ({
  cfg: {
    enabled: true,
    byUserId: ACTOR.userId,
    byEmail: ACTOR.email,
    mode,
    report: 'detailed-video',
    since,
    lastError: null,
  },
});

const AUTO_IMPORT: Record<string, CarriedAutoImport> = {
  // old #18
  'AI - Daily': ALOK_AI('both', '2026-08-19T16:06:08.475Z'),
  // old #6
  'Integration Cadence': ALOK_AI('video', '2026-08-20T06:18:58.944Z'),
  // old #9
  'Data Cadence': ALOK_AI('both', '2026-08-21T08:30:37.543Z'),
  // old #24
  'DevOps Scrum': {
    cfg: {
      enabled: true,
      byUserId: 'lookup',
      byEmail: 'yadu.nm@trames.sg',
      mode: 'transcript',
      report: 'detailed-video',
      since: '2026-08-21T05:36:04.874Z',
      lastError: null,
    },
  },
  // old #5
  'LP-Global Weekly Catch Up': ALOK_AI('video', '2026-08-13T00:00:00.000Z'),
  // old #32 — 'summary' is the retired report value, read as the detailed
  // default by lib/report-pref storedReportPref (kept as the backup had it).
  'MCAP Phase 2 Weekly': {
    cfg: {
      enabled: true,
      byUserId: 'lookup',
      byEmail: 'kawen.koh@trames.sg',
      mode: 'both',
      report: 'summary',
      since: '2026-09-04T01:56:40.815Z',
      lastError: null,
    },
    expectPrefix: 'c478bf8e-1e50-4a0d-8841-db774fb3b2d',
  },
};

// ---------------------------------------------------------------------------
// The seed table (spec §8). Priorities: the AM/CS briefings 50, the rest 100.
// ---------------------------------------------------------------------------

interface Seed {
  title: string;
  description: string;
  regexes: string[];
  labels: string[];
  priority: number;
}

const SEEDS: Seed[] = [
  { title: 'AI - Daily', description: 'The AI team’s daily stand-up.', regexes: ['^AI - Daily'], labels: ['Team/AI'], priority: 100 },
  { title: 'Integration Cadence', description: 'The integration team’s recurring cadence call.', regexes: ['^Integration Cadence'], labels: ['Team/Integration'], priority: 100 },
  { title: 'Data Cadence', description: 'The data team’s recurring cadence call.', regexes: ['^Data Cadence'], labels: ['Team/Data'], priority: 100 },
  { title: 'Data scrum', description: 'The data team’s scrum.', regexes: ['^Data scrum'], labels: ['Team/Data'], priority: 100 },
  { title: 'Lothal scrum', description: 'The Lothal scrum (data team).', regexes: ['^Lothal scrum'], labels: ['Team/Data'], priority: 100 },
  { title: 'Data weekly / Data QA', description: 'The data team’s weekly and Data QA reviews.', regexes: ['^Data (weekly|QA)\\b'], labels: ['Team/Data'], priority: 100 },
  { title: 'DevOps Scrum', description: 'The DevOps (Engineering) scrum.', regexes: ['^DevOps (Engineering )?Scrum'], labels: ['Team/DevOps'], priority: 100 },
  { title: 'Preet Scrum', description: 'The Preet scrum.', regexes: ['^Preet Scrum'], labels: ['Team/Preet Scrum'], priority: 100 },
  { title: 'Analytics Cadence', description: 'The analytics cadence and analytics-transition calls.', regexes: ['^Analytics (Cadence|transition)'], labels: ['Team/Analytics'], priority: 100 },
  {
    title: 'AM Briefing: Jacq',
    description: 'Ivan’s recurring 1:1s with Jacqueline — weeks 1/3/4 and the Monday-review variant with Harshil.',
    regexes: ['spanish.*perf?ume', '^AI AM$'],
    labels: ['AM Briefing/Jacq'],
    priority: 50,
  },
  {
    title: 'AM Briefing: Kawen',
    description: 'Ivan’s recurring briefings with Ka Wen — MCAP/SL weekly, APP bookings, COG/HF round-ups.',
    regexes: [
      '^Weekly MCAP, SL',
      '^Ivan / Ka Wen',
      '^APP Bookings',
      '^Spicy Steel Sats',
      '^COG/MCAP weekly round up',
      '^Weekly COG and HF',
    ],
    labels: ['AM Briefing/Kawen'],
    priority: 50,
  },
  { title: 'AM Briefing: Aniq', description: 'Ivan’s recurring briefing with Aniq.', regexes: ['^Cool Beers'], labels: ['AM Briefing/Aniq'], priority: 50 },
  { title: 'AM Briefing: Swaralee', description: 'Ivan’s recurring briefing with Swaralee.', regexes: ['Paper, ?Nuts', 'Nuts and Yogurt'], labels: ['AM Briefing/Swaralee'], priority: 50 },
  {
    title: 'AM Briefing: SiQian',
    description: 'Ivan’s recurring briefings with SiQian, incl. the DKSH weekly review.',
    regexes: ['^Juggling the Customers', '^DKSH Weekly Review'],
    labels: ['AM Briefing/SiQian'],
    priority: 50,
  },
  { title: 'AM Briefing: Iman', description: 'Ivan’s recurring briefing with Iman.', regexes: ['^Last Drills Before Spills'], labels: ['AM Briefing/Iman'], priority: 50 },
  {
    title: 'CS Briefing: Ain/Aniq',
    description: 'Customer-support briefings — the Freshdesk weekly and status reviews, and Ain <> Ivan.',
    regexes: ['^CS-Freshdesk Weekly Review', '^Freshdesk Status Reviews', '^Ain <> Ivan'],
    labels: ['CS Briefing'],
    priority: 50,
  },
  {
    title: 'LP-Global Weekly Catch Up',
    description: 'The weekly catch-up with LP Global.',
    regexes: ['^LP-Global ?<> ?Trames Weekly'],
    labels: ['Customers/LP Global/Weekly catch-up'],
    priority: 100,
  },
  {
    title: 'MCAP Phase 2 Weekly',
    description: 'The weekly MCAP Phase 2 connection.',
    regexes: ['^MCAP x Trames', '^Weekly connection for Phase 2'],
    // Spec table: "Customers/MCAP, Kawen" — read as two default labels; the
    // dry run says whether "Kawen" exists or would be created top-level.
    labels: ['Customers/MCAP', 'Kawen'],
    priority: 100,
  },
];

// ---------------------------------------------------------------------------

const pad = (s: string | number, n: number) => String(s).padEnd(n);

async function main(): Promise<number> {
  console.log(`curated-series seed — ${APPLY ? 'APPLY' : 'dry run'} — schema ${SCHEMA}`);
  console.log('─────────────────────────────────────────────────────────────');

  // 1. Patterns, all of them, before anything else.
  const patterns = new Map<string, SeriesPattern[]>();
  for (const s of SEEDS) {
    const v = validatePatterns(s.regexes.map((regex) => ({ kind: 'title', regex })));
    if (!v.ok) {
      console.error(`refused: "${s.title}" — ${v.error}`);
      return 2;
    }
    patterns.set(s.title, v.patterns);
  }

  // 2. Migration 053.
  if (!(await curatedSeriesReady())) {
    console.error('refused: migration 053 is not applied (scripts/vm-apply-migration.sh 053 first)');
    return 2;
  }

  // 3. Auto-import enablers.
  const autoImport = new Map<string, SeriesAutoImportCfg>();
  for (const [title, carried] of Object.entries(AUTO_IMPORT)) {
    let byUserId = carried.cfg.byUserId;
    if (byUserId === 'lookup') {
      const found = await userIdForEmail(carried.cfg.byEmail);
      if (!found) {
        console.error(`refused: no user id for ${carried.cfg.byEmail} (auto-import of "${title}")`);
        return 2;
      }
      if (carried.expectPrefix && !found.startsWith(carried.expectPrefix)) {
        console.error(
          `refused: ${carried.cfg.byEmail} resolves to ${found}, not the backup's ${carried.expectPrefix}… — check before seeding`
        );
        return 2;
      }
      byUserId = found;
    }
    autoImport.set(title, { ...carried.cfg, byUserId });
    console.log(`auto-import  ${pad(title, 28)} ${carried.cfg.mode}/${carried.cfg.report} by ${carried.cfg.byEmail} (${byUserId}) since ${carried.cfg.since}`);
  }

  // 4. Labels.
  const allPaths = [...new Set(SEEDS.flatMap((s) => s.labels))];
  for (const p of allPaths) {
    const hit = await getLabelByPath(p);
    console.log(`label        ${pad(p, 40)} ${hit ? `exists (#${hit.id})` : 'WILL BE CREATED'}`);
  }

  // 5. What is there already.
  const existing = await listAllSeries();
  if (existing.length > 0) {
    console.log(`existing     ${existing.length} series: ${existing.map((s) => `#${s.id} ${s.title}`).join(', ')}`);
  } else {
    console.log('existing     none');
  }

  // 6. What each seed series would match today (same matcher, same rule).
  const rows = await sql<
    Array<{ id: number; title: string | null; ctx: Record<string, unknown> | null; at: string }>
  >`
    SELECT t.id, t.title, COALESCE(t.recorded_at, t.created_at)::text AS at,
           jsonb_build_object(
             'eventTitle', t.gmeet_context->>'eventTitle',
             'organizerEmail', t.gmeet_context->>'organizerEmail',
             'recurringEventId', t.gmeet_context->>'recurringEventId',
             'attendees', CASE WHEN jsonb_typeof(t.gmeet_context->'attendees') = 'array'
                               THEN t.gmeet_context->'attendees' END
           ) AS ctx
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE t.deleted_at IS NULL AND NOT t.scratch
    ORDER BY COALESCE(t.recorded_at, t.created_at) DESC
  `;
  const matchable = SEEDS.map((s, i) => ({ id: i + 1, priority: s.priority, patterns: patterns.get(s.title)! }));
  const hits = new Map<number, Array<{ title: string; at: string }>>();
  let unmatched = 0;
  for (const r of rows) {
    const facts = factsFromContext({ title: r.title, gmeet_context: r.ctx });
    const w = pickSeries(matchable, facts);
    if (!w) {
      unmatched++;
      continue;
    }
    hits.set(w.id, [...(hits.get(w.id) ?? []), { title: facts.title ?? '(untitled)', at: r.at.slice(0, 10) }]);
  }
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`would match (of ${rows.length} live meetings; ${unmatched} in no seed series):`);
  SEEDS.forEach((s, i) => {
    const h = hits.get(i + 1) ?? [];
    console.log(`  ${pad(String(h.length).padStart(4), 6)}${pad(s.title, 28)} p${s.priority}  labels: ${s.labels.join(', ')}`);
    for (const x of h.slice(0, 3)) console.log(`          ${x.at}  ${x.title}`);
  });

  if (!APPLY) {
    console.log('─────────────────────────────────────────────────────────────');
    console.log('dry run — nothing written. Re-run with --apply to seed.');
    return 0;
  }

  // ---- apply -----------------------------------------------------------------
  console.log('─────────────────────────────────────────────────────────────');
  let failed = 0;
  const ids = new Map<string, number>();
  for (const s of SEEDS) {
    try {
      const pats = patterns.get(s.title)!;
      const prior = await getSeriesByTitle(s.title);
      const id = prior
        ? (await updateSeries(prior.id, { description: s.description, patterns: pats, priority: s.priority }), prior.id)
        : (await createSeries({ userId: ACTOR.userId, title: s.title, description: s.description, patterns: pats, priority: s.priority })).id;
      ids.set(s.title, id);
      const labelIds = await resolveLabelPaths(s.labels, ACTOR);
      await setSeriesLabels(id, labelIds, ACTOR);
      const ai = autoImport.get(s.title);
      if (ai) await setSeriesAutoImport(id, ai);
      for (const f of FOLLOWERS) await followSeries(id, f, ACTOR);
      console.log(`${prior ? 'updated' : 'created'}  #${pad(id, 4)} ${pad(s.title, 28)} ${ai ? 'auto-import ON' : ''}`);
    } catch (err) {
      failed++;
      console.error(`FAILED   ${s.title}:`, err);
    }
  }

  const r = await rematchAll('seed');
  console.log(`rematch: +${r.joined} −${r.left} moved ${r.moved}`);

  const counts = await sql<Array<{ series_id: number; n: number; manual: number }>>`
    SELECT series_id, count(*)::int AS n, count(*) FILTER (WHERE how <> 'auto')::int AS manual
    FROM ${sql(SCHEMA)}.series_members
    GROUP BY series_id
  `;
  const byId = new Map(counts.map((c) => [c.series_id, c]));
  console.log('members per series:');
  for (const s of SEEDS) {
    const id = ids.get(s.title);
    const c = id ? byId.get(id) : undefined;
    console.log(`  ${String(c?.n ?? 0).padStart(4)}  #${pad(id ?? '?', 4)} ${s.title}${c?.manual ? ` (${c.manual} manual)` : ''}`);
  }
  return failed > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    console.log('─────────────────────────────────────────────────────────────');
    await sql.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[curated-series-seed] failed:', err);
    await sql.end().catch(() => {});
    process.exit(2);
  });
