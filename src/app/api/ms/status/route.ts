import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';

export const runtime = 'nodejs';

/**
 * Microsoft (Teams chat) account link — SURFACED here, OWNED by Darth Tasks.
 *
 * The per-user delegated Microsoft connection (`darth-cli tasks teams-*`)
 * lives in darth-plagueis (`ms_accounts`, /ms page). Meeting transcripts do
 * NOT need it — those come through the tenant-wide app-only "Darth Meetings"
 * Entra registration. We only show the link's state on our Settings page so
 * users have one place to see all their connected accounts; connect /
 * reconnect deep-link into Darth Tasks with `?return=` back here.
 *
 * Auth model: the browser's `darth_session` cookie is scoped to
 * `.darth-internal.trames.io`, so we forward the caller's Cookie header
 * verbatim to plagueis and it resolves the same darth-auth session (requiring
 * its own `tasks` module). No shared secret, no token material ever touches
 * this app. A user without Darth Tasks access gets 401/403 from plagueis → we
 * report `available:false` (card explains).
 */

const TASKS_BASE = process.env.DARTH_TASKS_URL || 'https://tasks.darth-internal.trames.io';

type PlagueisStatus = {
  configured: boolean;
  connected: boolean;
  email?: string;
  status?: string;
  status_detail?: string | null;
  ms_upn?: string | null;
  ms_name?: string | null;
  connected_at?: string;
  last_used_at?: string | null;
};

async function plagueis(path: string, cookie: string, init?: RequestInit) {
  return fetch(`${TASKS_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie, accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(6000),
  });
}

export const GET = withAuth(async ({ request, cliScope }) => {
  if (cliScope) {
    // darth-cli has its own verb for this: `darth-cli tasks teams-status`.
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  const cookie = request.headers.get('cookie') ?? '';
  try {
    const res = await plagueis('/api/ms/status', cookie);
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ available: false, reason: 'no_tasks_access' });
    }
    if (!res.ok) {
      return NextResponse.json({ available: false, reason: `tasks_${res.status}` });
    }
    const d = (await res.json()) as PlagueisStatus;
    return NextResponse.json({
      available: true,
      configured: d.configured,
      connected: d.connected,
      status: d.status ?? null,
      statusDetail: d.status_detail ?? null,
      msUpn: d.ms_upn ?? null,
      msName: d.ms_name ?? null,
      connectedAt: d.connected_at ?? null,
      lastUsedAt: d.last_used_at ?? null,
      manageUrl: `${TASKS_BASE}/ms`,
      connectUrl: `${TASKS_BASE}/api/ms/connect`,
    });
  } catch (e) {
    console.error('[ms-status] plagueis unreachable:', e instanceof Error ? e.message : e);
    return NextResponse.json({ available: false, reason: 'tasks_unreachable' });
  }
});

/** Disconnect — proxied to plagueis under the same forwarded session. */
export const DELETE = withAuth(async ({ request, cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  const cookie = request.headers.get('cookie') ?? '';
  try {
    const res = await plagueis('/api/ms/disconnect', cookie, { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return NextResponse.json(
        { error: body?.error ?? `Darth Tasks returned ${res.status}` },
        { status: res.status === 401 || res.status === 403 ? 403 : 502 }
      );
    }
    return NextResponse.json({ connected: false });
  } catch (e) {
    console.error('[ms-status] disconnect failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Darth Tasks unreachable' }, { status: 502 });
  }
});
