'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MessageSquare, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { DARTH_TASKS_MS_PAGE } from '@/lib/darth-family';

interface MsStatus {
  available: boolean;
  reason?: string;
  configured?: boolean;
  connected?: boolean;
  status?: string | null;
  statusDetail?: string | null;
  msUpn?: string | null;
  msName?: string | null;
  connectedAt?: string | null;
  lastUsedAt?: string | null;
  manageUrl?: string;
  connectUrl?: string;
}

/**
 * Settings card for the Microsoft (Teams chat) account link.
 *
 * This link is OWNED by Darth Tasks (darth-plagueis) — it powers
 * `darth-cli tasks teams-*` chat reads — and is only SURFACED here so all of
 * a user's connected accounts show in one place. Meeting transcripts do not
 * need it (they use the tenant-wide app-only "Darth Meetings" registration).
 * Connect/Reconnect round-trip through Darth Tasks and land back here via
 * `?return=`; the banner reads `?ms=connected|error`.
 */
export function MicrosoftAccountCard() {
  const [status, setStatus] = useState<MsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    fetch('/api/ms/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setStatus(data ?? { available: false, reason: 'load_failed' }))
      .catch(() => setStatus({ available: false, reason: 'load_failed' }));
  };

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('ms');
    if (outcome === 'connected') {
      setBanner({ ok: true, text: 'Microsoft account connected — Teams chat reads via darth-cli are on.' });
    } else if (outcome === 'error') {
      setBanner({ ok: false, text: `Microsoft connect failed: ${params.get('reason') ?? 'unknown'}. Try again.` });
    }
    if (outcome) {
      params.delete('ms');
      params.delete('reason');
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    }
  }, []);

  const connect = () => {
    const ret = new URL(window.location.href);
    ret.searchParams.delete('ms');
    ret.searchParams.delete('reason');
    ret.hash = 'microsoft';
    const base = status?.connectUrl ?? `${DARTH_TASKS_MS_PAGE.replace(/\/ms$/, '')}/api/ms/connect`;
    window.location.href = `${base}?return=${encodeURIComponent(ret.toString())}`;
  };

  const disconnect = async () => {
    if (
      !window.confirm(
        'Disconnect Microsoft? Teams chat reads via darth-cli will stop until you reconnect. Meeting transcript imports are not affected.'
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch('/api/ms/status', { method: 'DELETE' });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setBanner({ ok: false, text: d?.error ?? `Disconnect failed (${res.status})` });
      } else {
        setBanner(null);
      }
      load();
    } finally {
      setBusy(false);
    }
  };

  const manageUrl = status?.manageUrl ?? DARTH_TASKS_MS_PAGE;
  const needsReconnect = status?.available && !status.connected && status.status === 'revoked';

  return (
    <Card id="microsoft">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          Microsoft account
          <span className="text-xs font-normal text-muted-foreground">· Teams chat, via Darth Tasks</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {banner && (
          <div
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              banner.ok ? 'border-emerald-300/50 bg-emerald-500/10' : 'border-red-300/50 bg-red-500/10'
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

        <p className="text-xs text-muted-foreground">
          Not needed for meeting transcripts or recordings — those import through the tenant-wide Darth Meetings
          app with no per-user step. This link lets <code className="rounded bg-muted px-1">darth-cli tasks teams-chats</code>{' '}
          read <span className="font-medium">your own</span> Teams chats as you. It is held by Darth Tasks and shown
          here so all your connected accounts are in one place.
        </p>

        {status !== null && status.available && status.configured !== false && (
          <p className="text-xs" data-teams-chat-evidence={status.connected ? 'on' : 'off'}>
            <span className="font-medium">Teams chat evidence:</span>{' '}
            {status.connected ? (
              <span className="text-emerald-600">on (linked)</span>
            ) : (
              <span className="text-muted-foreground">off</span>
            )}
            <span className="text-muted-foreground">
              {' '}
              — with your link, meetings can read each Teams meeting chat to tell whether a call was held and
              recorded (even when another company hosted it).
            </span>
          </p>
        )}

        {status === null ? (
          <p className="text-sm text-muted-foreground">Checking connection…</p>
        ) : !status.available ? (
          <p className="text-sm text-muted-foreground">
            {status.reason === 'no_tasks_access'
              ? 'Your account has no access to Darth Tasks, which holds this link — ask an admin there.'
              : 'Darth Tasks is unreachable right now — status unavailable.'}{' '}
            <a href={manageUrl} target="_blank" rel="noreferrer" className="underline">
              Open Darth Tasks
            </a>
          </p>
        ) : !status.configured ? (
          <p className="text-sm text-muted-foreground">
            The Microsoft integration isn&apos;t configured on Darth Tasks yet.
          </p>
        ) : !status.connected ? (
          <>
            {needsReconnect && (
              <p className="text-sm text-amber-600">
                Previous connection expired or was revoked{status.statusDetail ? ` (${status.statusDetail})` : ''} —
                reconnect below.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={connect}>{needsReconnect ? 'Reconnect Microsoft' : 'Connect Microsoft'}</Button>
              <a
                href={manageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"
              >
                Manage on Darth Tasks <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span className="font-medium">{status.msName || status.msUpn}</span>
                {status.msName && status.msUpn && (
                  <span className="text-muted-foreground">({status.msUpn})</span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {status.connectedAt ? `Connected ${new Date(status.connectedAt).toLocaleString()}` : 'Connected'}
                {status.lastUsedAt
                  ? ` · last used ${new Date(status.lastUsedAt).toLocaleString()}`
                  : ' · not used yet'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={disconnect}>
                Disconnect
              </Button>
              <a
                href={manageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"
              >
                Manage on Darth Tasks <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
