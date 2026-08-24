import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  deleteSeries,
  findDuplicateSeries,
  getSeries,
  listKeys,
  listMembers,
  listSuggestedMembers,
  setSeriesAutoImport,
  updateSeries,
  visibleSeriesIds,
  seriesVisibleToCaller,
  type SeriesAutoImportCfg,
} from '@/db-ops/series';

export const runtime = 'nodejs';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/series/:id — the series, its evidence keys, members (with
 * caller-visibility flags), suggested members awaiting confirmation, and
 * probable-duplicate sibling series (the one-click merge prompt).
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  // PRIVACY GATE (2026-08-24): a series the caller isn't in must not exist
  // for them — its title is a meeting title and its keys carry live Teams
  // join URLs (the exact input /api/teams/import accepts).
  const visible = await visibleSeriesIds(caller);
  if (!visible.has(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [keys, members, suggestions, dupMap] = await Promise.all([
    listKeys(id),
    listMembers(id, caller),
    listSuggestedMembers(id, caller),
    findDuplicateSeries(),
  ]);
  return NextResponse.json({
    series,
    keys,
    members,
    suggestions,
    dupes: (dupMap.get(id) ?? []).filter((d) => visible.has(d.id)),
  });
});

const AUTO_MODES = ['transcript', 'video', 'both'] as const;
const AUTO_REPORTS = ['summary', 'detailed-video', 'detailed-text', 'later'] as const;

/** PATCH /api/series/:id — rename / edit notes / configure auto-import. */
export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  if (!(await seriesVisibleToCaller(id, { userId: user.userId, email: user.email }))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: {
    title?: string;
    notes?: string | null;
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
  const title = body.title?.trim();
  if (body.title !== undefined && !title) {
    return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
  }
  if (body.title !== undefined || body.notes !== undefined) {
    await updateSeries(id, { title, notes: body.notes }, user.userId);
  }

  if (body.autoImport !== undefined) {
    const ai = body.autoImport;
    if (typeof ai?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'autoImport.enabled must be a boolean' }, { status: 400 });
    }
    const mode = ai.mode ?? series.auto_import?.mode ?? 'both';
    const report = ai.report ?? series.auto_import?.report ?? 'summary';
    if (!AUTO_MODES.includes(mode) || !AUTO_REPORTS.includes(report)) {
      return NextResponse.json({ error: 'Invalid autoImport mode/report' }, { status: 400 });
    }
    // Enabling (re)binds the sweep to the CALLER — their Google connection
    // does the imports and they own + get DMs for the resulting rows. The
    // watch window starts at first enablement and survives re-toggles (the
    // fire-once log prevents duplicates regardless).
    const cfg: SeriesAutoImportCfg = {
      enabled: ai.enabled,
      byUserId: ai.enabled ? user.userId : (series.auto_import?.byUserId ?? user.userId),
      byEmail: ai.enabled ? user.email : (series.auto_import?.byEmail ?? user.email),
      mode,
      report,
      since: series.auto_import?.since ?? new Date().toISOString(),
      lastSweepAt: series.auto_import?.lastSweepAt,
      lastError: null,
    };
    await setSeriesAutoImport(id, cfg);
    return NextResponse.json({ ok: true, autoImport: cfg });
  }
  return NextResponse.json({ ok: true });
});

/** DELETE /api/series/:id — remove the series (members detach, transcripts
 * are untouched). */
export const DELETE = withAuth(async ({ user }, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  if (!(await seriesVisibleToCaller(id, { userId: user.userId, email: user.email }))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await deleteSeries(id);
  return NextResponse.json({ ok: true });
});
