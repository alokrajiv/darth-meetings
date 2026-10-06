import { NextResponse } from 'next/server';
import { normalizeReportPref, defaultReportPref } from '@/lib/report-pref';
import { withAuth } from '@/lib/auth/with-auth';
import { listMembers, setSeriesAutoImport, updateSeries, type SeriesAutoImportCfg } from '@/db-ops/series';
import { validatePatterns } from '@/lib/series-patterns';
import { SERIES_DELETE_DENIED, SERIES_EDIT_DENIED } from '@/lib/series-permissions';
import { setSeriesLabels } from '@/lib/server/series-labels';
import {
  bustCuratedSeriesCache,
  deleteSeriesFully,
  onSeriesMatchingChanged,
  reconcileSeriesMembers,
} from '@/lib/server/curated-series';
import {
  parseDescription,
  parsePriority,
  parseSeriesId,
  parseTitle,
  resolveLabelPaths,
  seriesForCaller,
  SeriesInputError,
} from '@/lib/server/series-api';

export const runtime = 'nodejs';
// A patterns edit re-matches every meeting.
export const maxDuration = 120;

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

/**
 * GET /api/series/:id — 404 unless the caller owns, edits, follows or
 * audits the series (§11.6). Then: the series, its owner, editors, default
 * labels, followers, what the caller may do, a reach note, and its MEMBERS —
 * only the meetings the caller owns or holds a share on. Members the caller
 * cannot open are not listed, not counted, not dated.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NOT_FOUND();
  const members = await listMembers(id, caller);
  return NextResponse.json({
    ready: true,
    series: ctx.series,
    owner: ctx.deco.owner,
    editors: ctx.deco.editors,
    labels: ctx.deco.labels,
    followers: ctx.deco.followers,
    permissions: ctx.deco.permissions,
    // §11.11 reach note: what the series may match.
    reach: ctx.facts.ownerIsAuditor ? 'all' : 'owner',
    // Who is asking — the dialog marks "you" among the followers.
    viewer: { email: user.email.trim().toLowerCase(), isAuditor: ctx.callerIsAuditor },
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
 * Owner and editors only (§11.1) — 404 for a caller who cannot see the
 * series, 403 for a follower/auditor who can see but not edit it. The reach
 * rule is the safety: whatever the patterns, the series only matches what
 * its owner can open. Auto-import binds to the CALLER (§11.7). A patterns
 * change re-matches every meeting; a labels change re-runs the members.
 */
export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NOT_FOUND();
  if (!ctx.deco.permissions.edit) {
    return NextResponse.json({ error: SERIES_EDIT_DENIED }, { status: 403 });
  }
  const series = ctx.series;

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
  // Priority is display order only since v2 (§11.2) — it never changes who
  // belongs, so only a patterns change re-matches.
  const changesMatching =
    patch.patterns !== undefined && JSON.stringify(patch.patterns) !== JSON.stringify(series.patterns);

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
  if (ai) await setSeriesAutoImport(id, ai);
  if (labelIds) {
    await setSeriesLabels(id, labelIds, caller);
    if (!changesMatching) await reconcileSeriesMembers(id, caller);
  }
  if (changesMatching) await onSeriesMatchingChanged(id, 'patterns edited');
  return NextResponse.json({ ok: true, ...(ai ? { autoImport: ai } : {}) });
});

/**
 * DELETE /api/series/:id — remove the series: its labels and follow shares
 * come off every member (unless another series still gives them); the
 * meetings themselves are untouched. The OWNER only (§11.1) — 404 for a
 * caller who cannot see it, 403 for anyone else who can. No ledger rows:
 * it is the owner's call, not a person's removal of one meeting (§11.4).
 */
export const DELETE = withAuth(async ({ user }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NOT_FOUND();
  if (!ctx.deco.permissions.delete) {
    return NextResponse.json({ error: SERIES_DELETE_DENIED }, { status: 403 });
  }
  await deleteSeriesFully(id);
  console.log(`[series] deleted #${id} "${ctx.series.title}" by ${user.email}`);
  return NextResponse.json({ ok: true });
});
