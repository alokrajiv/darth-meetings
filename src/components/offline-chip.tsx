'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { CloudDownload, CloudOff, Loader2, Settings, Wifi } from 'lucide-react';
import { useOffline } from '@/lib/offline/offline-context';
import { levelIncludes } from '@/lib/offline/offline-urls';
import { formatBytes } from '@/lib/format';

/**
 * Header element for offline support. Three states:
 *  - offline mode on → "Offline mode" pill with a "Go online" action;
 *  - online and a sync is running → a quiet spinner pill "Saving for offline… n/total";
 *  - online, idle, offline support available → an icon-only muted button
 *    (the header stays clean); its popover carries "Go offline" so the
 *    archive is one click away without a trip to Settings (tech-debt B2).
 *  - no service worker / cache storage → nothing.
 *
 * The pill itself opens a tiny popover with what this device holds
 * (meetings / audio / video, storage) and a link to the settings section.
 * Mount once inside <AppHeader> so every page gets it.
 */
export function OfflineChip() {
  const { mode, online, sw, syncing, syncState, pins, storage, exitOffline, enterOffline } = useOffline();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [stillDown, setStillDown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const offline = mode === 'offline';
  // Online and idle: only worth a button where offline support exists.
  const idle = !offline && !syncing;
  if (idle && sw !== 'ready') return null;

  const ready = pins.filter((p) => p.level !== 'none' && p.status !== 'error');
  const counts = {
    meetings: ready.filter((p) => levelIncludes(p.level, 'transcript')).length,
    audio: ready.filter((p) => levelIncludes(p.level, 'audio')).length,
    video: ready.filter((p) => levelIncludes(p.level, 'video')).length,
  };
  const pinnedBytes = storage ? storage.pinned.transcript + storage.pinned.audio + storage.pinned.video : 0;

  const goOnline = async () => {
    setLeaving(true);
    setStillDown(false);
    try {
      const ok = await exitOffline();
      if (!ok) setStillDown(true);
      else setOpen(false);
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="relative" ref={ref} data-offline-chip>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title={
          offline
            ? 'Offline mode — browsing what is saved on this device'
            : idle
              ? `Saved for offline — ${counts.meetings} meeting${counts.meetings === 1 ? '' : 's'} on this device`
              : 'Saving meetings for offline use'
        }
        className={`inline-flex h-7 items-center gap-1.5 rounded-full border text-xs font-medium transition-colors ${
          offline
            ? 'border-amber-300 bg-amber-50 px-2.5 text-amber-900 hover:bg-amber-100 dark:border-amber-700/60 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-900/60'
            : idle
              ? 'w-7 justify-center border-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
              : 'border-transparent bg-muted px-2.5 text-muted-foreground hover:text-foreground'
        }`}
      >
        {offline ? (
          <>
            <CloudOff className="h-3.5 w-3.5" />
            Offline mode
          </>
        ) : idle ? (
          <>
            <CloudDownload className="h-3.5 w-3.5" />
            <span className="sr-only">Saved for offline</span>
          </>
        ) : (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="hidden sm:inline">Saving for offline…</span>
            <span className="tabular-nums">
              {syncState.done}/{syncState.total}
            </span>
          </>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.06)]"
        >
          <p className="text-sm font-medium">
            {offline ? 'Offline mode' : idle ? 'Saved for offline' : 'Saving for offline'}
          </p>
          {!offline && !idle && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={syncState.current ?? undefined}>
              {syncState.total > 0 ? `${syncState.done} of ${syncState.total}` : 'Preparing…'}
              {syncState.current ? ` · ${syncState.current}` : ''}
            </p>
          )}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Meetings</dt>
            <dd className="tabular-nums">{counts.meetings}</dd>
            <dt className="text-muted-foreground">With audio</dt>
            <dd className="tabular-nums">{counts.audio}</dd>
            <dt className="text-muted-foreground">With video</dt>
            <dd className="tabular-nums">{counts.video}</dd>
            <dt className="text-muted-foreground">Storage</dt>
            <dd className="tabular-nums">
              {formatBytes(pinnedBytes)}
              {storage?.quota ? ` of ${formatBytes(storage.quota)}` : ''}
            </dd>
          </dl>
          {offline && (
            <div className="mt-3 space-y-1.5">
              <Button
                size="sm"
                className="h-7 w-full px-2.5 text-xs"
                disabled={leaving}
                onClick={() => void goOnline()}
                title={online ? 'Leave offline mode' : 'Re-check the connection and leave offline mode'}
              >
                {leaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                Go online
              </Button>
              {stillDown && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  Still can’t reach the server. Try again when you have a connection.
                </p>
              )}
            </div>
          )}
          {idle && (
            <div className="mt-3 space-y-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full px-2.5 text-xs"
                onClick={() => {
                  enterOffline();
                  setOpen(false);
                }}
                title="Browse only what is saved on this device — handy before a flight"
                data-offline-chip-go-offline
              >
                <CloudOff className="h-3.5 w-3.5" />
                Go offline
              </Button>
              {counts.meetings === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Nothing is saved yet — open a meeting and choose “Save offline”, or set the defaults in Settings.
                </p>
              )}
            </div>
          )}
          <Link
            href="/settings#offline"
            className="mt-2.5 flex items-center gap-1.5 text-xs text-primary hover:underline"
            onClick={() => setOpen(false)}
          >
            <Settings className="h-3.5 w-3.5" />
            Offline settings
          </Link>
        </div>
      )}
    </div>
  );
}
