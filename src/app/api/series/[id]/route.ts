import { NextResponse } from 'next/server';
import { normalizeReportPref, defaultReportPref } from '@/lib/report-pref';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getSeries,
  listMembers,
  setSeriesAutoImport,
  updateSeries,
  type SeriesAutoImportCfg,
} from '@/db-ops/series';
import { curatedSeriesReady, CURATED_SERIES_NOT_READY } from '@/db-ops/curated-series-schema';
import { validatePatterns } from '@/lib/series-patterns';
import {
  SERIES_DELETE_DENIED,
  SERIES_MATCHING_AUDITOR_ONLY,
} from '@/lib/series-permissions';
import { setSeriesLabels } from '@/lib/server/series-labels';
import {
  bustCuratedSeriesCache,
  deleteSeriesFully,
  onSeriesMatchingChanged,
} from '@/lib/server/curated-series';
import {
  decorateSeries,
  parseDescription,
  parsePriority,
  parseSeriesId,
  parseTitle,
  resolveLabelPaths,
  SeriesInputError,
} from '@/lib/server/series-api';

export const runtime = 'nodejs';
// A patterns/priority edit re-matches every meeting.
export const maxDuration = 120;

/**
 * GET /api/series/:id — the series (everyone sees every series), its default
 * labels, followers, what the caller may do, and its MEMBERS — only the
 * meetings the caller owns or holds a share on (spec §6). Members the caller
 * cannot open are not listed, not counted, not dated.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const ready = await curatedSeriesReady().catch(() => false);
  const [members, deco] = await Promise.all([
    listMembers(id, caller),
    ready ? decorateSeries([series], caller).then((m) => m.get(id) ?? null) : Promise.resolve(null),
  ]);
  return NextResponse.json({
    ready,
    series,
    labels: deco?.labels ?? [],
    followers: deco?.followers ?? [],
    permissions: deco?.permissions ?? null,
    // Who is asking — the dialog marks "you" among the followers.
    viewer: { email: user.email.trim().toLowerCase() },
    members,
    // Older darth-cli builds print these — the key bag, guesses and merge
    // prompts are gone with the key-based series.
    keys: [],
    suggestions: [],
    dupes: [],
  });
});

const AUTO_MODES = ['transcript', 'video', 'both'] as const;

/**
 * PATCH /api/series/:id — edit the definition:
 *   { title?, description?, notes?, patterns?, priority?, labels?: string[],
 *     autoImport?: { enabled, mode?, report? } }
 * Anyone may edit name, description, labels and auto-import. Patterns and
 * priority decide who belongs — and so, on a followed series, who the
 * followers get — so on a series WITH followers only an auditor may change
 * them (403). A patterns/priority change re-matches every meeting.
 */
export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: Record<string, unknown> & {
    autoImport?: {
      enabled: boolean;
      mode?: SeriesAutoImportCfg['mode'];
      report?: SeriesAutoImportCfg['report'];
    };
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const caller = { userId: user.userId, email: user.email };

  const touchesDefinition =
    body.description !== undefined ||
    body.patterns !== undefined ||
    body.priority !== undefined ||
    body.labels !== undefined;
  if (touchesDefinition && !(await curatedSeriesReady())) {
    return NextResponse.json({ error: CURATED_SERIES_NOT_READY }, { status: 503 });
  }

  // ---- validate everything before writing anything ----------------------
  const patch: Parameters<typeof updateSeries>[1] = {};
  let labelPaths: unknown = undefined;
  try {
    if (body.title !== undefined) patch.title = parseTitle(body.title);
    if (body.description !== undefined) patch.description = parseDescription(body.description);
    if (body.notes !== undefined) {
      if (body.notes !== null && typeof body.notes !== 'string') throw new SeriesInputError('notes must be text');
      patch.notes = (body.notes as string | null) ?? null;
    }
    if (body.priority !== undefined) patch.priority = parsePriority(body.priority);
    if (body.labels !== undefined) labelPaths = body.labels;
  } catch (err) {
    if (err instanceof SeriesInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  if (body.patterns !== undefined) {
    const v = validatePatterns(body.patterns);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    patch.patterns = v.patterns;
  }
  const changesMatching =
    (patch.patterns !== undefined && JSON.stringify(patch.patterns) !== JSON.stringify(series.patterns)) ||
    (patch.priority !== undefined && patch.priority !== series.priority);
  if (changesMatching) {
    // PRIVACY GATE (spec §6): widening a followed series' patterns would
    // pull more meetings to its followers.
    const deco = (await decorateSeries([series], caller)).get(id);
    if (!deco?.permissions.editMatching) {
      return NextResponse.json({ error: SERIES_MATCHING_AUDITOR_ONLY }, { status: 403 });
    }
  }

  let ai: SeriesAutoImportCfg | null = null;
  if (body.autoImport !== undefined) {
    const req = body.autoImport;
    if (typeof req?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'autoImport.enabled must be a boolean' }, { status: 400 });
    }
    const mode = req.mode ?? series.auto_import?.mode ?? 'both';
    // Legacy 'summary' (old darth-cli, a series configured before
    // 2026-09-21) reads as the detailed default — summary-only is gone.
    const report =
      normalizeReportPref(req.report ?? series.auto_import?.report) ?? defaultReportPref(true);
    if (!AUTO_MODES.includes(mode) || (req.report !== undefined && !normalizeReportPref(req.report))) {
      return NextResponse.json({ error: 'Invalid autoImport mode/report' }, { status: 400 });
    }
    // Enabling (re)binds the sweep to the CALLER — their Google connection
    // does the imports and they own + get DMs for the resulting rows. The
    // watch window starts at first enablement and survives re-toggles (the
    // fire-once log prevents duplicates regardless).
    ai = {
      enabled: req.enabled,
      byUserId: req.enabled ? user.userId : (series.auto_import?.byUserId ?? user.userId),
      byEmail: req.enabled ? user.email : (series.auto_import?.byEmail ?? user.email),
      mode,
      report,
      since: series.auto_import?.since ?? new Date().toISOString(),
      lastSweepAt: series.auto_import?.lastSweepAt,
      lastError: null,
    };
  }

  let labelIds: number[] | null = null;
  if (labelPaths !== undefined) {
    try {
      labelIds = await resolveLabelPaths(labelPaths, caller);
    } catch (err) {
      if (err instanceof SeriesInputError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  }

  // ---- write -------------------------------------------------------------
  if (Object.keys(patch).length > 0) {
    await updateSeries(id, patch);
    bustCuratedSeriesCache();
  }
  if (labelIds) await setSeriesLabels(id, labelIds, caller);
  if (ai) await setSeriesAutoImport(id, ai);
  if (changesMatching) await onSeriesMatchingChanged(id, 'patterns/priority edited');
  return NextResponse.json({ ok: true, ...(ai ? { autoImport: ai } : {}) });
});

/**
 * DELETE /api/series/:id — remove the series: its labels and follow shares
 * come off every member, the members are freed (and re-matched — another
 * series may now win them); the meetings themselves are untouched. Only the
 * series' creator or an auditor may delete it (403 otherwise).
 */
export const DELETE = withAuth(async ({ user }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await curatedSeriesReady())) {
    return NextResponse.json({ error: CURATED_SERIES_NOT_READY }, { status: 503 });
  }
  const deco = (await decorateSeries([series], caller)).get(id);
  if (!deco?.permissions.delete) {
    return NextResponse.json({ error: SERIES_DELETE_DENIED }, { status: 403 });
  }
  await deleteSeriesFully(id);
  console.log(`[series] deleted #${id} "${series.title}" by ${user.email}`);
  return NextResponse.json({ ok: true });
});
