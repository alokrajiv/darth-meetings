import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { sweepSeriesOccurrences, type SeriesOccurrence } from '@/lib/server/series-occurrences';
import { getSeries } from '@/db-ops/series';
import { listAutoSyncUsers } from '@/db-ops/user-prefs';
import { interestedAutoSyncUsers } from '@/lib/server/auto-import-plan';
import { seriesForCaller } from '@/lib/server/series-api';
import { strongestReport, type ReportPref } from '@/lib/auto-marker';

export const runtime = 'nodejs';
// Sweeping calendar pages + Graph artifact lists can take a moment.
export const maxDuration = 120;

/**
 * GET /api/series/:id/occurrences — every occurrence of this series on the
 * caller's own calendar (Meet + Graph enriched), with artifact presence and
 * already-imported cross-references. The external sweep is cached ~6h per
 * user; `?refresh=1` forces a fresh one. Imported state is always fresh.
 */
export const GET = withAuth(async ({ user, request }, { params }) => {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  }
  // PRIVACY (curated series v2, spec §11.6): a series the caller cannot see
  // (not its owner, an editor, a follower or an auditor) does not exist for
  // them — 404. The sweep itself is caller-scoped: occurrences come only
  // from the CALLER's own calendar rows (Meet records and Graph artifacts
  // only for the codes / join URLs on those rows), and a member meeting is
  // named only when the caller can open it (lib/server/series-occurrences).
  if (!(await seriesForCaller(id, { userId: user.userId, email: user.email }))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
  const result = await sweepSeriesOccurrences(
    id,
    { userId: user.userId, email: user.email },
    { forceRefresh }
  );
  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ...result, autoSyncAudience: await audienceOf(id, result.occurrences) });
});

/**
 * Who a series auto-import setting would speak for: every account-auto-sync
 * user in the series' recent occurrences (attendee/organiser union of the
 * last few past ones), with their own report ask, plus the effective report
 * the plan resolver would pick. The series card renders this so the enabler
 * SEES whom the setting overrides and whether it downgrades anyone —
 * exactly what nobody could see before 2026-09-08.
 */
async function audienceOf(
  seriesId: number,
  occurrences: SeriesOccurrence[]
): Promise<{
  interested: Array<{ email: string; report: ReportPref; organiser: boolean }>;
  effectiveReport: ReportPref | null;
  downgrades: string[];
}> {
  const past = occurrences
    .filter((o) => !o.upcoming)
    .sort((a, b) => Date.parse(b.startIso) - Date.parse(a.startIso))
    .slice(0, 6);
  if (past.length === 0) return { interested: [], effectiveReport: null, downgrades: [] };
  const [users, series] = await Promise.all([listAutoSyncUsers().catch(() => []), getSeries(seriesId)]);
  const cfg = series?.auto_import ?? null;
  const provider = past.some((o) => o.teams) ? 'teams' : 'gmeet';
  const byEmail = new Map<string, { email: string; report: ReportPref; organiser: boolean }>();
  for (const o of past) {
    const hit = interestedAutoSyncUsers(
      {
        startIso: o.startIso,
        provider,
        organizerEmail: o.organizerEmail,
        attendees: o.attendees.map((a) => a.email).filter((e): e is string => !!e),
      },
      users
    );
    for (const u of hit) {
      if (!byEmail.has(u.email.toLowerCase())) {
        byEmail.set(u.email.toLowerCase(), {
          email: u.email,
          report: u.prefs.report,
          organiser: (o.organizerEmail ?? '').toLowerCase() === u.email.toLowerCase(),
        });
      }
    }
  }
  const interested = [...byEmail.values()];
  const effectiveReport = strongestReport([cfg?.enabled ? cfg.report : null, ...interested.map((i) => i.report)]);
  // Who'd get LESS than they asked for if the series pref were applied alone
  // (informational — the resolver already raises it; the card says so).
  const downgrades = cfg?.enabled
    ? interested
        .filter((i) => strongestReport([cfg.report, i.report]) !== cfg.report)
        .map((i) => i.email)
    : [];
  return { interested, effectiveReport: interested.length || cfg?.enabled ? effectiveReport : null, downgrades };
}
