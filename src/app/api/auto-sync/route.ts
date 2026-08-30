import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getUserPrefs,
  autoSyncOf,
  setAutoSyncPrefs,
  listAutoSyncActivityFor,
  dismissAutoSyncAnnounce,
  AUTO_SYNC_SCOPES,
  AUTO_SYNC_MODES,
  AUTO_SYNC_REPORTS,
  type AutoSyncScope,
  type AutoSyncMode,
  type AutoSyncReport,
} from '@/db-ops/user-prefs';
import { getGoogleAccount } from '@/db-ops/google-accounts';

export const runtime = 'nodejs';

/**
 * GET /api/auto-sync — the caller's account-level auto-sync switch (T2) +
 * whether their Google connection can carry it + the recent ledger rows
 * they were the importer or a watcher on.
 */
export const GET = withAuth(async ({ user }) => {
  const [row, account, activity] = await Promise.all([
    getUserPrefs(user.userId),
    getGoogleAccount(user.userId),
    listAutoSyncActivityFor({ userId: user.userId, email: user.email }, 20),
  ]);
  return NextResponse.json({
    autoSync: autoSyncOf(row),
    announceDismissed: !!row?.auto_sync_announce_dismissed_at || (row?.auto_sync ?? 'off') !== 'off',
    googleConnected: !!account && account.status !== 'revoked',
    options: { scopes: AUTO_SYNC_SCOPES, modes: AUTO_SYNC_MODES, reports: AUTO_SYNC_REPORTS },
    activity: activity.map((a) => ({
      occKey: a.occ_key,
      title: a.title,
      occStart: a.occ_start,
      outcome: a.outcome,
      importerEmail: a.importer_email,
      mine: a.importer_user_id === user.userId,
      assemblyaiId: a.assemblyai_id,
      detail: a.detail,
      updatedAt: a.updated_at,
    })),
  });
});

/**
 * PUT /api/auto-sync — partial update:
 * { scope?: off|mine|all, mode?: transcript|video|both,
 *   report?: summary|detailed-video|detailed-text|later,
 *   providers?: { gmeet?: bool, teams?: bool } }
 * Turning it on stamps `since = now()` — history is never backfilled.
 */
export const PUT = withAuth(async ({ user, request }) => {
  let body: {
    scope?: unknown;
    mode?: unknown;
    report?: unknown;
    providers?: unknown;
    dismissAnnounce?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const patch: Parameters<typeof setAutoSyncPrefs>[1] = {};
  if (body.scope !== undefined) {
    if (!AUTO_SYNC_SCOPES.includes(body.scope as AutoSyncScope)) {
      return NextResponse.json({ error: `scope must be one of ${AUTO_SYNC_SCOPES.join('|')}` }, { status: 400 });
    }
    patch.scope = body.scope as AutoSyncScope;
  }
  if (body.mode !== undefined) {
    if (!AUTO_SYNC_MODES.includes(body.mode as AutoSyncMode)) {
      return NextResponse.json({ error: `mode must be one of ${AUTO_SYNC_MODES.join('|')}` }, { status: 400 });
    }
    patch.mode = body.mode as AutoSyncMode;
  }
  if (body.report !== undefined) {
    if (!AUTO_SYNC_REPORTS.includes(body.report as AutoSyncReport)) {
      return NextResponse.json({ error: `report must be one of ${AUTO_SYNC_REPORTS.join('|')}` }, { status: 400 });
    }
    patch.report = body.report as AutoSyncReport;
  }
  if (body.providers !== undefined) {
    const p = body.providers as { gmeet?: unknown; teams?: unknown } | null;
    if (!p || typeof p !== 'object') {
      return NextResponse.json({ error: 'providers must be an object' }, { status: 400 });
    }
    const providers: Partial<{ gmeet: boolean; teams: boolean }> = {};
    if (typeof p.gmeet === 'boolean') providers.gmeet = p.gmeet;
    if (typeof p.teams === 'boolean') providers.teams = p.teams;
    patch.providers = providers;
  }
  if (body.dismissAnnounce === true) {
    await dismissAutoSyncAnnounce({ userId: user.userId, email: user.email });
    if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true, announceDismissed: true });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to change' }, { status: 400 });
  }
  if (patch.scope && patch.scope !== 'off') {
    const account = await getGoogleAccount(user.userId);
    if (!account || account.status === 'revoked') {
      return NextResponse.json(
        { error: 'Connect Google first — auto-sync reads your calendar through your own connection.', connected: false },
        { status: 409 }
      );
    }
  }
  const autoSync = await setAutoSyncPrefs({ userId: user.userId, email: user.email }, patch);
  return NextResponse.json({ autoSync });
});
