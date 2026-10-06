import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { createSeries, listSeries, seriesTotals } from '@/db-ops/series';
import { curatedSeriesReady, CURATED_SERIES_NOT_READY } from '@/db-ops/curated-series-schema';
import { validatePatterns } from '@/lib/series-patterns';
import { isAuditorEmail } from '@/lib/auditor-policy';
import { SERIES_FOLLOWERS_AUDITOR_ONLY } from '@/lib/series-permissions';
import { setSeriesLabels } from '@/lib/server/series-labels';
import {
  attachManually,
  bustCuratedSeriesCache,
  followSeries,
  onSeriesMatchingChanged,
} from '@/lib/server/curated-series';
import {
  decorateSeries,
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
 * GET /api/series — every series (everyone sees every series, spec §6):
 * name, description, patterns, priority, default labels, followers,
 * auto-import status, and what the caller may do with each. Member counts,
 * last-meeting date and cadence are over the meetings the CALLER can open —
 * never the global numbers. Totals for the footer are the caller's too.
 */
export const GET = withAuth(async ({ user }) => {
  const caller = { userId: user.userId, email: user.email };
  const [series, totals] = await Promise.all([listSeries(caller), seriesTotals(caller)]);
  const ready = await curatedSeriesReady().catch(() => false);
  const deco = ready ? await decorateSeries(series, caller) : new Map();
  return NextResponse.json({
    ready,
    series: series.map((s) => {
      const d = deco.get(s.id);
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        patterns: s.patterns,
        priority: s.priority,
        created_by: s.created_by,
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
        labels: d?.labels ?? [],
        followers: d?.followers ?? [],
        permissions: d?.permissions ?? null,
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
 * POST /api/series — create a curated series:
 *   { title, description?, patterns?, priority?, labels?: string[] (paths),
 *     followers?: [{ email, name? }] (auditors only), fromTranscriptId? }
 * Anyone may create a series. Followers grant read access, so only an
 * auditor may name them (403 otherwise). `fromTranscriptId` attaches that
 * meeting by hand — the caller must own or edit it. Every meeting is then
 * re-matched against the new patterns.
 */
export const POST = withAuth(async ({ user, request }) => {
  if (!(await curatedSeriesReady())) {
    return NextResponse.json({ error: CURATED_SERIES_NOT_READY }, { status: 503 });
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
  if (followers.length > 0 && !isAuditorEmail(user.email)) {
    return NextResponse.json({ error: SERIES_FOLLOWERS_AUDITOR_ONLY }, { status: 403 });
  }
  const people: Array<{ email: string; name: string | null }> = [];
  for (const f of followers as Array<{ email?: unknown; name?: unknown }>) {
    const email = typeof f?.email === 'string' ? f.email.trim().toLowerCase() : '';
    if (!email.includes('@')) return NextResponse.json({ error: 'follower email is required' }, { status: 400 });
    people.push({ email, name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : null });
  }

  // The seed meeting is checked BEFORE anything is written.
  let seed: Awaited<ReturnType<typeof resolveAccess>> = null;
  if (typeof body.fromTranscriptId === 'string' && body.fromTranscriptId) {
    seed = await resolveAccess(user.userId, user.email, body.fromTranscriptId);
    if (!seed) return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
    if (seed.access !== 'owner' && seed.access !== 'edit') {
      return NextResponse.json(
        { error: 'Only the owner or an editor can put this meeting in a series' },
        { status: 403 }
      );
    }
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
