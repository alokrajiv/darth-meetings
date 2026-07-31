import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getSyncState, setLastSyncedAt } from '@/db-ops/gmeet-sync';

export const runtime = 'nodejs';

/**
 * GET /api/gmeet/sync-state
 * The caller's Meet sync state: last full-sync timestamp + never-sync mutes.
 */
export const GET = withAuth(async ({ user }) => {
  const state = await getSyncState(user.userId);
  return NextResponse.json(state);
});

/**
 * POST /api/gmeet/sync-state
 * Mark a sync pass as done. Body: { lastSyncedAt?: ISO string } (default now).
 */
export const POST = withAuth(async ({ user, request }) => {
  let atIso: string | undefined;
  try {
    const body = (await request.json()) as { lastSyncedAt?: string };
    if (body.lastSyncedAt) {
      const d = new Date(body.lastSyncedAt);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid lastSyncedAt' }, { status: 400 });
      }
      atIso = d.toISOString();
    }
  } catch {
    // empty body = "now"
  }
  await setLastSyncedAt(user.userId, atIso);
  const state = await getSyncState(user.userId);
  return NextResponse.json(state);
});
