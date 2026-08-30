'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { RefreshCw, X } from 'lucide-react';

/**
 * One-time "auto-sync is here" announcement (Alok, 2026-08-30) at the top of
 * the listing. Server-side dismissal (user_prefs.auto_sync_announce_
 * dismissed_at) so it is one-time per USER; turning the switch on anywhere
 * also counts. "Turn on" = the recommended configuration (every meeting,
 * recording, detailed report with video frames) in one click.
 */
interface Payload {
  autoSync: { scope: string };
  announceDismissed: boolean;
  googleConnected: boolean;
}

export function AutoSyncAnnounceBanner({ className = '' }: { className?: string }) {
  const pathname = usePathname();
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    fetch('/api/auto-sync')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData((d as Payload | null) ?? null))
      .catch(() => setData(null));
  }, []);

  if (pathname?.startsWith('/login')) return null;
  if (!data || hidden || data.announceDismissed) return null;

  const dismiss = async () => {
    setHidden(true);
    await fetch('/api/auto-sync', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissAnnounce: true }),
    }).catch(() => {});
  };

  const turnOn = async () => {
    if (!data.googleConnected) {
      window.location.href = `/api/google/connect?return=${encodeURIComponent('/settings#auto-sync')}`;
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all', mode: 'video', report: 'detailed-video', dismissAnnounce: true }),
      });
      if (res.ok) setDone('Auto-sync is on for every meeting you attend from now on. Change it any time in Settings.');
      else setDone(`Couldn’t turn it on (${res.status}) — try from Settings.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-autosync-announce
      role="status"
      className={`mb-4 flex flex-wrap items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm ${className}`}
    >
      <div className="shrink-0 pt-0.5 text-emerald-600 dark:text-emerald-400">
        <RefreshCw className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        {done ? (
          <p className="font-medium">{done}</p>
        ) : (
          <>
            <p className="font-medium">New: auto-sync — your meetings import themselves</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Once Google / Microsoft has the recording, the meeting lands here on its own with speakers
              identified and a detailed report with video frames. De-duplicated company-wide: if a
              colleague’s auto-sync already covers a meeting, you’re simply shared in — one import per
              meeting, ever. Only meetings that start after you switch it on.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Button size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => void turnOn()}>
                {data.googleConnected ? 'Turn on for every meeting I attend (recommended)' : 'Connect Google, then turn on'}
              </Button>
              <a href="/settings#auto-sync" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
                choose what to import
              </a>
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => void dismiss()}
              >
                no thanks
              </button>
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => void dismiss()}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
