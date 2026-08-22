import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import { sweepNewAccount } from '@/lib/server/gmeet-poller';

export const runtime = 'nodejs';

/**
 * POST /api/calendar/sync — run one poller sweep for the CALLER, now.
 *
 * The background poller visits every account on a 30-minute tick, so the
 * calendar layers lag reality by up to ~45 minutes (tick + the 15-minute
 * post-meeting grace). This is the "Sync now" escape hatch: same code path
 * as the sweep (`sweepUser` via `sweepNewAccount`), same own-token rule,
 * same cache writes — just on demand for one account.
 *
 * Concurrent calls for the same user coalesce onto the in-flight sweep.
 * Guard state lives on globalThis: Next bundles this module separately per
 * route graph, so a module-scope Map would silently duplicate.
 */
const g = globalThis as unknown as {
  __mwManualCalSync?: Map<string, Promise<void>>;
};
const inflight = (g.__mwManualCalSync ??= new Map<string, Promise<void>>());

export const POST = withAuth(async ({ user }) => {
  const account = await getGoogleAccount(user.userId);
  if (!account) {
    return NextResponse.json(
      { error: 'Google account not connected' },
      { status: 409 }
    );
  }

  let sweep = inflight.get(user.userId);
  if (!sweep) {
    // sweepNewAccount never throws (logs and swallows) — the finally is for
    // safety if that contract ever changes.
    sweep = sweepNewAccount(user.userId).finally(() => {
      inflight.delete(user.userId);
    });
    inflight.set(user.userId, sweep);
  }
  await sweep;

  const after = await getGoogleAccount(user.userId);
  return NextResponse.json({ ok: true, lastPollAt: after?.last_poll_at ?? null });
});
