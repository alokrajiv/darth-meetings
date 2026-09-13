import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getOfflinePrefs,
  setOfflinePrefs,
  DEFAULT_OFFLINE_PREFS,
  OFFLINE_PREFS_MAX,
} from '@/db-ops/user-prefs';

export const runtime = 'nodejs';

/**
 * GET /api/offline/prefs — the caller's offline auto-pin counts (per account).
 * PUT /api/offline/prefs { transcripts?, audio?, video? } — partial update.
 *
 * The counts decide how many of the newest meetings every device of this
 * user keeps offline; the pinned bytes themselves never touch the server.
 */
export const GET = withAuth(async ({ user }) => {
  const prefs = await getOfflinePrefs(user.userId);
  return NextResponse.json({ prefs, defaults: DEFAULT_OFFLINE_PREFS, max: OFFLINE_PREFS_MAX });
});

export const PUT = withAuth(async ({ user, request }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const patch: Record<string, number> = {};
  for (const k of ['transcripts', 'audio', 'video'] as const) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: `${k} must be a non-negative number` }, { status: 400 });
    }
    patch[k] = n;
  }
  const prefs = await setOfflinePrefs({ userId: user.userId, email: user.email }, patch);
  return NextResponse.json({ prefs, defaults: DEFAULT_OFFLINE_PREFS, max: OFFLINE_PREFS_MAX });
});
