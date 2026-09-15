'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowUpCircle, AudioLines, CircleDot, ExternalLink, ScreenShare, Settings } from 'lucide-react';
import { callKindLabel, getCompanion, shareLabel, useCompanion } from '@/lib/companion/companion-client';

/**
 * Header pill for the Mac helper (Darth Recorder). Mounted once in <AppHeader>.
 *  - never installed on this browser → nothing (header stays clean);
 *  - installed but not running → muted "Recorder off" with an Open action;
 *  - connected, idle → quiet "Recorder" with a green dot;
 *  - connected, call live → emerald "Call detected" with Record;
 *  - recording → red "Recording mm:ss" with Stop.
 * A screen-share glyph rides along while the tray sees one (0.2.0+), and an
 * amber dot appears when the tray has an update waiting.
 *
 * Every state is derived from the snapshot's strict `recording === true`: the
 * 0.1.5 tray overwrote that boolean with the saved-file object on
 * `recording_stopped`, which left the pill stuck on "Recording" after a stop.
 * The fix lives in companion-client; the chip must never re-truthy it.
 */
export function RecorderChip() {
  const c = useCompanion();
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
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

  useEffect(() => {
    if (!c.recording) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [c.recording]);

  if (!c.connected && !c.everSeen) return null;

  const call = c.calls[0];
  const share = shareLabel(c.share);
  // An update the tray has seen but not applied yet. Ignore it while recording:
  // the tray defers the swap until the recording ends anyway.
  const updateReady = c.connected && !!(c.updateStaged ?? c.updateAvailable);
  const pending = c.recordingsPendingUpload ?? 0;
  const since = c.recordingSince ? Date.parse(c.recordingSince) : Date.now();
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const clock = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  let pill: string;
  let cls: string;
  if (!c.connected) {
    pill = 'Recorder off';
    cls = 'border-transparent bg-muted text-muted-foreground hover:text-foreground';
  } else if (c.recording) {
    pill = `Recording ${clock}`;
    cls =
      'border-red-300 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-700/60 dark:bg-red-950/60 dark:text-red-200 dark:hover:bg-red-900/60';
  } else if (call) {
    pill = 'Call detected';
    cls =
      'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-700/60 dark:bg-emerald-950/60 dark:text-emerald-200 dark:hover:bg-emerald-900/60';
  } else {
    pill = 'Recorder';
    cls = 'border-transparent bg-muted text-muted-foreground hover:text-foreground';
  }

  return (
    <div className="relative" ref={ref} data-recorder-chip data-state={!c.connected ? 'off' : c.recording ? 'recording' : call ? 'call' : 'idle'}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title={c.connected ? `Darth Recorder v${c.version ?? ''} connected` : 'Darth Recorder is installed but not running'}
        className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${cls}`}
      >
        {c.recording ? <CircleDot className="h-3.5 w-3.5 animate-pulse" /> : <AudioLines className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{pill}</span>
        {share && <ScreenShare className="h-3.5 w-3.5 shrink-0 opacity-90" aria-label={share} data-recorder-share />}
        {c.connected && !c.recording && !updateReady && (
          <span className={`h-1.5 w-1.5 rounded-full ${call ? 'bg-emerald-500' : 'bg-emerald-500/80'}`} aria-label="connected" />
        )}
        {updateReady && (
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Recorder update available" data-recorder-update-dot />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.06)]"
        >
          <p className="text-sm font-medium">Darth Recorder{c.version ? ` v${c.version}` : ''}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {!c.connected
              ? 'Installed on this Mac but not running.'
              : c.recording
                ? `Recording ${c.recordingLabel ?? 'display'} · ${clock}`
                : call
                  ? `${callKindLabel(call.kind)} in progress${call.title ? ` — ${call.title}` : ` (${call.app})`}`
                  : c.screenPermission === false
                    ? 'Connected, but Screen Recording is not allowed yet (System Settings › Privacy & Security).'
                    : 'Connected. Watching for Teams, Meet and Zoom calls.'}
          </p>
          {share && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" data-recorder-share-line>
              <ScreenShare className="h-3 w-3 shrink-0" /> {share}
            </p>
          )}
          {c.connected && c.signedIn === false && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Not signed in — recordings stay on this Mac until you sign the recorder in.
            </p>
          )}
          {pending > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {pending} recording{pending === 1 ? '' : 's'} waiting to upload.
            </p>
          )}
          {updateReady && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-recorder-update-line>
              <ArrowUpCircle className="h-3 w-3 shrink-0" />
              Update {c.updateStaged ?? c.updateAvailable} ready — it installs itself once you are not recording.
            </p>
          )}
          <div className="mt-3 space-y-1.5">
            {!c.connected && (
              <Button size="sm" className="h-7 w-full px-2.5 text-xs" onClick={() => (window.location.href = 'darth-recorder://open')}>
                <ExternalLink className="h-3.5 w-3.5" /> Open Darth Recorder
              </Button>
            )}
            {c.connected && c.recording && (
              <Button size="sm" variant="destructive" className="h-7 w-full px-2.5 text-xs" onClick={() => getCompanion().send('stop')}>
                Stop recording
              </Button>
            )}
            {c.connected && !c.recording && (
              <Button
                size="sm"
                className="h-7 w-full px-2.5 text-xs"
                disabled={c.screenPermission === false}
                onClick={() => getCompanion().send('start', call ? { pid: call.pid } : {})}
              >
                {call ? 'Record this call' : 'Record screen now'}
              </Button>
            )}
            <Link
              href="/settings"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              <Settings className="h-3 w-3" /> Recorder settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
