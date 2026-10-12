'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Video, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { isNetworkFailure, NETWORK_ERROR_MESSAGE } from '@/lib/fetch-errors';
import { connectionsHref, DARTH_AUTH_CONNECTIONS_URL } from '@/lib/darth-family';

interface GoogleStatus {
  connected: boolean;
  googleEmail?: string;
  status?: 'ok' | 'revoked' | 'error';
  lastError?: string | null;
  connectedAt?: string;
  lastPollAt?: string | null;
  /** darth-auth's Connections page (bare) — where the link is managed. */
  manageUrl?: string;
  /** Connections with `?return=` /settings (we build our own return). */
  connectUrl?: string;
}

/** Query params the connect round-trip leaves on this page. */
const BOUNCE_PARAMS = ['google', 'reason', 'connected'];

/** auth's Connections page with `?return=` the current page (bounce params
 * stripped), using the page URL the status payload named when it has one. */
function connectHref(status: GoogleStatus | null | 'unknown'): string {
  const ret = new URL(window.location.href);
  for (const k of BOUNCE_PARAMS) ret.searchParams.delete(k);
  const page = status && status !== 'unknown' && status.manageUrl ? status.manageUrl : DARTH_AUTH_CONNECTIONS_URL;
  return connectionsHref(ret.toString(), window.location.origin, page);
}

/**
 * Settings card for the Google account link that powers the background
 * sync-and-remind poller and every server-side Google read. Since 2026-10-12
 * the link is HELD by darth-auth: Connect / Reconnect / Manage all go to
 * auth's Connections page with `?return=` back here; this card only shows
 * the state (GET /api/google/status re-mirrors it from auth first).
 */
export function GoogleAccountCard() {
  // 'unknown' = network down: never show the not-connected copy
  // (and its Connect button) for a status we could not read.
  const [status, setStatus] = useState<GoogleStatus | 'unknown' | null>(null);
  // Post-connect banner: /settings?connected=google (auth's Connections
  // round-trip) or the legacy ?google=connected|error&reason=…
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    fetch('/api/google/status')
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((data) => setStatus(data ?? { connected: false }))
      .catch((err) => {
        if (isNetworkFailure(err)) setStatus('unknown');
        else setStatus({ connected: false });
      });
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('connected') === 'google' ? 'connected' : params.get('google');
    if (outcome === 'connected') {
      setBanner({ ok: true, text: 'Google account connected — background sync is on.' });
    } else if (outcome === 'error') {
      setBanner({ ok: false, text: `Google connect failed (${params.get('reason') ?? 'unknown'}). Try again.` });
    }
    if (outcome) {
      for (const k of BOUNCE_PARAMS) params.delete(k);
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    }
  }, []);

  const goConnect = () => {
    window.location.href = connectHref(status);
  };
  const manageUrl =
    status && status !== 'unknown' && status.manageUrl ? status.manageUrl : DARTH_AUTH_CONNECTIONS_URL;

  const needsReconnect = status !== null && status !== 'unknown' && status.connected && status.status === 'revoked';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="h-4 w-4 text-primary" />
          Google account
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {banner && (
          <div
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              banner.ok
                ? 'border-emerald-300/50 bg-emerald-500/10'
                : 'border-red-300/50 bg-red-500/10'
            }`}
          >
            {banner.ok ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
            )}
            {banner.text}
          </div>
        )}

        {status === null ? (
          <p className="text-sm text-muted-foreground">Checking connection…</p>
        ) : status === 'unknown' ? (
          <p className="text-sm text-muted-foreground">{NETWORK_ERROR_MESSAGE}</p>
        ) : !status.connected ? (
          <>
            <p className="text-sm text-muted-foreground">
              Connect your Google account so the server can watch your calendar in the
              background: it reminds you about meetings with recordings you haven&apos;t
              imported, nudges you when auto-record is off for meetings you organize, and
              removes the Google popup from Meet imports. Read-only access; the link is
              held by Darth Auth (one Connections page for every Darth tool) and you can
              disconnect it there any time.
            </p>
            <Button onClick={goConnect}>Connect Google</Button>
          </>
        ) : (
          <>
            <div className="text-sm">
              <div className="flex items-center gap-2">
                {needsReconnect ? (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                )}
                <span className="font-medium">{status.googleEmail}</span>
                {needsReconnect && (
                  <span className="text-amber-600">— access revoked, reconnect needed</span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {status.lastPollAt
                  ? `Last background sync ${new Date(status.lastPollAt).toLocaleString()}`
                  : 'Background sync runs every 30 minutes.'}
                {status.status === 'error' && status.lastError ? ` · last error: ${status.lastError}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {needsReconnect && (
                <Button size="sm" onClick={goConnect}>
                  Reconnect
                </Button>
              )}
              {/* Disconnect / change account happen on Connections; same tab,
                  `?return=` brings the person back here. */}
              <a
                href={manageUrl}
                onClick={(e) => {
                  e.preventDefault();
                  goConnect();
                }}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"
              >
                Manage on Connections <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
