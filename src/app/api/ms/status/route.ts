import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { DARTH_AUTH_CONNECTIONS_URL } from '@/lib/darth-family';

export const runtime = 'nodejs';

/**
 * Microsoft (Teams chat) account link — SURFACED here, held by darth-auth.
 *
 * Since 2026-10-12 the per-user delegated Microsoft connection
 * (`darth-cli tasks teams-*`) is held by darth-auth: people connect,
 * reconnect and disconnect on auth's Connections page
 * (DARTH_AUTH_CONNECTIONS_URL), and Darth Tasks reads tokens from auth.
 * Meeting transcripts do NOT need it — those come through the tenant-wide
 * app-only "Darth Meetings" Entra registration. We only show the link's state
 * on our Settings page so users have one place to see all their connected
 * accounts; connect / manage go to Connections with `?return=` back here.
 *
 * The STATUS still comes from Darth Tasks' `/api/ms/status` (same JSON shape,
 * now answered from auth): the browser's `darth_session` cookie is scoped to
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

async function plagueis(path: string, cookie: string) {
  return fetch(`${TASKS_BASE}${path}`, {
    headers: { cookie, accept: 'application/json' },
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
      // Both the bare page: callers append `?return=<their page>`.
      manageUrl: DARTH_AUTH_CONNECTIONS_URL,
      connectUrl: DARTH_AUTH_CONNECTIONS_URL,
    });
  } catch (e) {
    console.error('[ms-status] plagueis unreachable:', e instanceof Error ? e.message : e);
    return NextResponse.json({ available: false, reason: 'tasks_unreachable' });
  }
});

/** Disconnect happens on darth-auth's Connections page now (Darth Tasks no
 * longer has a disconnect route). */
export const DELETE = withAuth(async ({ cliScope }) => {
  if (cliScope) {
    return NextResponse.json({ error: 'Requires a browser session' }, { status: 403 });
  }
  return NextResponse.json(
    { error: 'Disconnect Microsoft on the Connections page', manageUrl: DARTH_AUTH_CONNECTIONS_URL },
    { status: 410 }
  );
});
