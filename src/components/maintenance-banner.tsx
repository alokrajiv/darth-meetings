'use client';

import { useCallback, useEffect, useState } from 'react';
import { Megaphone, X } from 'lucide-react';
import { fetchNotice, noticeEtaText, type MaintenanceNotice } from '@/lib/maintenance-notice';

/**
 * The owner's deploy notice (src/lib/maintenance-notice.ts): shown while
 * `/__notice.json` exists, gone the moment deploy.sh removes it. Mounted once
 * in the root layout, same slot as <OfflineBanner> / <CompanionBanner>.
 *
 * Polls every 30 s and on focus / visibility. "Dismiss" hides THIS notice
 * (keyed by its `since`) for the tab's session; a new notice shows again.
 * Renders nothing when there is no notice — there is no automatic text.
 */
const POLL_MS = 30_000;
const DISMISS_KEY = 'mw.notice.dismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function MaintenanceBanner() {
  const [notice, setNotice] = useState<MaintenanceNotice | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    const n = await fetchNotice();
    setNotice(n);
    // Re-render for the "running late" flip even if the notice is unchanged.
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    setDismissed(readDismissed());
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  if (!notice || dismissed === notice.since) return null;

  const eta = noticeEtaText(notice);
  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, notice.since);
    } catch {
      /* private mode: dismiss for this render only */
    }
    setDismissed(notice.since);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-30 px-6" data-maintenance-banner>
      <div className="mx-auto max-w-[1400px]">
        <div
          role="status"
          className="pointer-events-auto mt-2 flex items-start gap-3 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2.5 text-sm text-violet-900 shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-violet-700/60 dark:bg-violet-950/80 dark:text-violet-200"
        >
          <Megaphone className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-line font-medium">{notice.message}</p>
            {eta ? <p className="text-xs opacity-80">Maintenance {eta}</p> : null}
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss notice"
            className="shrink-0 rounded p-0.5 opacity-70 hover:bg-violet-100 hover:opacity-100 dark:hover:bg-violet-900/50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
