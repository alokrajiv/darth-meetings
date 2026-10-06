import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { createSeries, listSeries, seriesTotals } from '@/db-ops/series';
import { seriesOwnershipReady, SERIES_OWNERSHIP_NOT_READY } from '@/db-ops/series-ownership-schema';
import { auditorEmails } from '@/db-ops/auditors';
import { validatePatterns } from '@/lib/series-patterns';
import { setSeriesLabels } from '@/lib/server/series-labels';
import {
  attachManually,
  bustCuratedSeriesCache,
  followSeries,
  onSeriesMatchingChanged,
} from '@/lib/server/curated-series';
import {
  decorateSeries,
  isInternalEmail,
  parseDescription,
  parsePriority,
  parseTitle,
  resolveLabelPaths,
  SeriesInputError,
} from '@/lib/server/series-api';

export const runtime = 'nodejs';
// A create re-matches every meeting against the new patterns.
export const maxDuration = 120;

export type SeriesCadence = 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;

/** Median inter-occurrence gap → a human cadence label (null = no pattern). */
function cadenceOf(medianGapSecs: number | null): SeriesCadence {
  if (medianGapSecs == null) return null;
  const days = medianGapSecs / 86_400;
  if (days <= 1.5) return 'daily';
  if (days <= 10) return 'weekly';
  if (days <= 20) return 'biweekly';
  if (days <= 45) return 'monthly';
  return null;
}

/**
 * GET /api/series — the series the CALLER may see (§11.6: owner, editor,
 * follower, auditor — nobody else learns a series exists): name,
 * description, patterns, priority, owner, editors, default labels,
 * followers, auto-import status, and what the caller may do with each.
 * Member counts, last-meeting date and cadence are over the meetings the
 * caller can open — never the global numbers. Totals for the footer are the
 * caller's too.
 */
export const GET = withAuth(async ({ user }) => {
  const caller = { userId: user.userId, email: user.email };
  const ready = await seriesOwnershipReady().catch(() => false);
  if (!ready) {
    return NextResponse.json({ ready: false, isAuditor: false, series: [], totals: { memberships: 0, unattached: 0 } });
  }
  const auditors = await auditorEmails();
  const callerIsAuditor = auditors.has(user.email.trim().toLowerCase());
  const [series, totals] = await Promise.all([
    listSeries(caller, callerIsAuditor),
    seriesTotals(caller, callerIsAuditor),
  ]);
  const deco = await decorateSeries(series, caller, auditors);
  return NextResponse.json({
    ready,
    isAuditor: callerIsAuditor,
    series: series
      .filter((s) => deco.get(s.id)?.permissions.see)
      .map((s) => {
        const d = deco.get(s.id)!;
        return {
          id: s.id,
          title: s.title,
          description: s.description,
          patterns: s.patterns,
          priority: s.priority,
          created_by: s.created_by,
          owner: d.owner,
          editors: d.editors,
          visible_member_count: s.visible_member_count,
          // Kept for older clients (CLI, badge picker) — the same caller-
          // visible count.
          member_count: s.visible_member_count,
          last_recorded_at: s.last_recorded_at,
          cadence: cadenceOf(s.median_gap_secs),
          auto_enabled: !!s.auto_import?.enabled,
          auto_import: s.auto_import
            ? { enabled: s.auto_import.enabled, byEmail: s.auto_import.byEmail, mode: s.auto_import.mode }
            : null,
          labels: d.labels,
          followers: d.followers,
          permissions: d.permissions,
          // Older darth-cli builds read these (merge prompt) — there are no
          // duplicates to fold any more.
          dup: false,
          dup_with: [],
        };
      }),
    totals,
  });
});

/**
 * POST /api/series — create a curated series; the caller is its OWNER:
 *   { title, description?, patterns?, priority?, labels?: string[] (paths),
 *     followers?: [{ email, name? }], fromTranscriptId? }
 * Anyone may create a series. It reaches only the meetings the caller can
 * open (an auditor's: every meeting — §11.2), and its followers only get
 * the meetings the caller owns or edits (§11.4). Followers must be company
 * addresses. `fromTranscriptId` attaches that meeting by hand — the caller
 * must be able to open it (it is in their reach). Every meeting is then
 * re-matched against the new patterns.
 */
export const POST = withAuth(async ({ user, request }) => {
  if (!(await seriesOwnershipReady())) {
    return NextResponse.json({ error: SERIES_OWNERSHIP_NOT_READY }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const actor = { userId: user.userId, email: user.email };

  let title: string;
  let description: string | null = null;
  let priority = 100;
  try {
    title = parseTitle(body.title);
    if (body.description !== undefined) description = parseDescription(body.description);
    if (body.priority !== undefined) priority = parsePriority(body.priority);
  } catch (err) {
    if (err instanceof SeriesInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  const v = validatePatterns(body.patterns ?? []);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const followers = Array.isArray(body.followers) ? body.followers : [];
  const people: Array<{ email: string; name: string | null }> = [];
  for (const f of followers as Array<{ email?: unknown; name?: unknown }>) {
    const email = typeof f?.email === 'string' ? f.email.trim().toLowerCase() : '';
    if (!isInternalEmail(email)) {
      return NextResponse.json({ error: `follower "${email}" must be a company address` }, { status: 400 });
    }
    people.push({ email, name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : null });
  }

  // The seed meeting is checked BEFORE anything is written: it must be in
  // the new owner's (= the caller's) reach — any access does.
  let seed: Awaited<ReturnType<typeof resolveAccess>> = null;
  if (typeof body.fromTranscriptId === 'string' && body.fromTranscriptId) {
    seed = await resolveAccess(user.userId, user.email, body.fromTranscriptId);
    if (!seed) return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
  }

  let labelIds: number[] = [];
  try {
    if (body.labels !== undefined) labelIds = await resolveLabelPaths(body.labels, actor);
  } catch (err) {
    if (err instanceof SeriesInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  const series = await createSeries({
    userId: user.userId,
    email: user.email,
    title,
    description,
    patterns: v.patterns,
    priority,
  });
  bustCuratedSeriesCache();
  if (labelIds.length > 0) await setSeriesLabels(series.id, labelIds, actor);
  for (const p of people) await followSeries(series.id, p, actor);
  if (seed) {
    await attachManually(
      series.id,
      { id: seed.row.id, user_id: seed.ownerUserId, assemblyai_id: seed.row.assemblyai_id },
      actor
    );
  }
  if (v.patterns.length > 0) await onSeriesMatchingChanged(series.id, 'created');
  console.log(`[series] created #${series.id} "${title}" by ${user.email} (${v.patterns.length} pattern(s))`);
  return NextResponse.json({ series });
});
