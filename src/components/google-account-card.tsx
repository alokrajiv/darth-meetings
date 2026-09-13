'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Video, CheckCircle2, AlertTriangle } from 'lucide-react';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';

interface GoogleStatus {
  connected: boolean;
  googleEmail?: string;
  status?: 'ok' | 'revoked' | 'error';
  lastError?: string | null;
  connectedAt?: string;
  lastPollAt?: string | null;
}

/**
 * Settings card for the backend Google connection (refresh-token flow that
 * powers the background sync-and-remind poller and kills the GIS popup).
 */
export function GoogleAccountCard() {
  // 'unknown' = offline / network down: never show the not-connected copy
  // (and its Connect button) for a status we could not read.
  const [status, setStatus] = useState<GoogleStatus | 'unknown' | null>(null);
  const [busy, setBusy] = useState(false);
  // Post-callback banner: /settings?google=connected|error&reason=…
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const { blocked } = useOfflineGate();

  const load = () => {
    if (blocked) {
      setStatus('unknown');
      return;
    }
    fetch('/api/google/status')
      .then(async (r) => {
        if (!r.ok) throw await offlineAwareError(r, `status ${r.status}`);
        return r.json();
      })
      .then((data) => setStatus(data ?? { connected: false }))
      .catch((err) => {
        if (isNetworkFailure(err) || (err instanceof Error && err.message === OFFLINE_TITLE)) setStatus('unknown');
        else setStatus({ connected: false });
      });
  };

  // Re-runs when the connection comes back (blocked flips false).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('google');
    if (outcome === 'connected') {
      setBanner({ ok: true, text: 'Google account connected — background sync is on.' });
    } else if (outcome === 'error') {
      setBanner({ ok: false, text: `Google connect failed (${params.get('reason') ?? 'unknown'}). Try again.` });
    }
    if (outcome) {
      params.delete('google');
      params.delete('reason');
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
  }, []);

  const disconnect = async () => {
    if (!window.confirm('Disconnect Google? Background sync and reminders will stop.')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/google/status', { method: 'DELETE' });
      if (!res.ok) throw await offlineAwareError(res, `Disconnect failed (${res.status})`);
      setBanner(null);
      load();
    } catch (err) {
      setBanner({ ok: false, text: isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Disconnect failed' });
    } finally {
      setBusy(false);
    }
  };

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
          <>
            <p className="text-sm text-muted-foreground">{OFFLINE_TITLE}</p>
            <div className="flex gap-2">
              <Button size="sm" disabled title={OFFLINE_TITLE}>
                Connect Google
              </Button>
              <Button size="sm" variant="outline" disabled title={OFFLINE_TITLE}>
                Disconnect
              </Button>
            </div>
          </>
        ) : !status.connected ? (
          <>
            <p className="text-sm text-muted-foreground">
              Connect your Google account so the server can watch your calendar in the
              background: it reminds you about meetings with recordings you haven&apos;t
              imported, nudges you when auto-record is off for meetings you organize, and
              removes the Google popup from Meet imports. Read-only access; you can
              disconnect any time.
            </p>
            <Button
              disabled={blocked}
              title={blocked ? OFFLINE_TITLE : undefined}
              onClick={() => (window.location.href = '/api/google/connect')}
            >
              Connect Google
            </Button>
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
            <div className="flex gap-2">
              {needsReconnect && (
                <Button
                  size="sm"
                  disabled={blocked}
                  title={blocked ? OFFLINE_TITLE : undefined}
                  onClick={() => (window.location.href = '/api/google/connect')}
                >
                  Reconnect
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy || blocked} title={blocked ? OFFLINE_TITLE : undefined} onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
