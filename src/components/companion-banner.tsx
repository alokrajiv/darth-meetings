'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Video, CircleDot, CheckCircle2 } from 'lucide-react';
import { callKindLabel, getCompanion, useCompanion } from '@/lib/companion/companion-client';

/**
 * Call-outs driven by the local Darth Recorder tray (see companion-client.ts).
 * Mounted once in the root layout, same slot as <OfflineBanner>; renders
 * nothing unless a tray is connected AND there is something to say:
 *
 *  - "Teams call detected" (+ window title) with Record / Not now while a
 *    call is live and nothing is recording. "Not now" hides that one call.
 *  - "Recording · mm:ss" with Stop while the tray records.
 *  - "Recording saved" for ~12 s after a stop (shown ahead of a still-live call).
 *
 * Record/Stop are commands to the tray; the tray does the capture and the
 * upload, this page is only a remote control. Ordinary users with no tray
 * installed never see any of this.
 */
export function CompanionBanner() {
  const c = useCompanion();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [, setTick] = useState(0);

  // 1 Hz re-render while recording (for the timer) or while the saved toast is showing.
  const savedVisible = c.lastEvent?.type === 'recording_stopped' && Date.now() - c.lastEvent.at < 12_000;
  useEffect(() => {
    if (!c.recording && !savedVisible) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [c.recording, savedVisible]);

  if (!c.connected) return null;

  const call = c.calls.find((k) => !dismissed.has(k.id)) ?? null;
  const shell =
    'pointer-events-auto mt-2 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]';

  let body: React.ReactNode = null;
  if (c.recording) {
    const since = c.recordingSince ? Date.parse(c.recordingSince) : Date.now();
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    body = (
      <div
        role="status"
        data-companion-recording
        className={`${shell} border-red-300 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-950/80 dark:text-red-200`}
      >
        <CircleDot className="h-4 w-4 shrink-0 animate-pulse" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Recording {c.recordingLabel ?? 'display'} · {mm}:{ss}
          </p>
          <p className="truncate text-xs opacity-80">{c.recordingPath ?? 'Darth Recorder on this Mac'}</p>
        </div>
        <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs hover:bg-red-100 dark:hover:bg-red-900/50" onClick={() => getCompanion().send('stop')}>
          Stop
        </Button>
      </div>
    );
  } else if (savedVisible && c.lastEvent?.type === 'recording_stopped') {
    const r = c.lastEvent.recording;
    body = (
      <div
        role="status"
        data-companion-saved
        className={`${shell} border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700/60 dark:bg-sky-950/80 dark:text-sky-200`}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Recording saved{r ? ` (${Math.floor(r.seconds / 60)}m ${r.seconds % 60}s)` : ''}</p>
          <p className="truncate text-xs opacity-80">{r?.path ?? ''}</p>
        </div>
      </div>
    );
  } else if (call) {
    body = (
      <div
        role="status"
        data-companion-call
        className={`${shell} border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/80 dark:text-emerald-200`}
      >
        <Video className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{callKindLabel(call.kind)} detected</p>
          <p className="truncate text-xs opacity-80">{call.title || `${call.app} is using the microphone`}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            className="h-7 px-2.5 text-xs"
            data-companion-record
            disabled={c.screenPermission === false}
            title={c.screenPermission === false ? 'Allow Screen Recording for Darth Recorder in System Settings first' : undefined}
            onClick={() => getCompanion().send('start', { pid: call.pid })}
          >
            Record
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-xs hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
            onClick={() => setDismissed((d) => new Set(d).add(call.id))}
          >
            Not now
          </Button>
        </div>
      </div>
    );
  }

  if (!body) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-30 px-6" data-companion-banner>
      <div className="mx-auto max-w-[1720px]">{body}</div>
    </div>
  );
}
