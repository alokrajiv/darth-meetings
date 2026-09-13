'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { WifiOff, Wifi, Loader2 } from 'lucide-react';
import { useOffline } from '@/lib/offline/offline-context';

/**
 * The two connectivity call-outs, mounted once in the root layout:
 *
 *  - "You appear to be offline" — the probe failed while the app is still in
 *    online mode. Going offline is the USER's decision (a flaky tunnel must
 *    not flip the whole listing into the archive by itself), so the prompt
 *    offers it and "Not now" just hides it until the next online→offline
 *    flip.
 *  - "Connection is back" — offline mode is on and the probe succeeds again.
 *    "Back online" re-probes before switching; if that still fails we say
 *    so and stay put.
 *
 * Fixed under the sticky app header (h-14) so the layout can mount it
 * anywhere in the tree; nothing renders when neither applies.
 */
export function OfflineBanner() {
  const { promptVisible, backOnlineVisible, enterOffline, exitOffline, dismissPrompt } = useOffline();
  const [leaving, setLeaving] = useState(false);
  const [stillDown, setStillDown] = useState(false);

  if (!promptVisible && !backOnlineVisible) return null;

  const goOnline = async () => {
    setLeaving(true);
    setStillDown(false);
    try {
      const ok = await exitOffline();
      if (!ok) setStillDown(true);
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-30 px-6" data-offline-banner>
      <div className="mx-auto max-w-[1720px]">
        {promptVisible ? (
          <div
            role="status"
            className="pointer-events-auto mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-amber-700/60 dark:bg-amber-950/80 dark:text-amber-200"
          >
            <WifiOff className="h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">You appear to be offline</p>
              <p className="text-xs opacity-80">
                Switch to offline mode to browse the meetings saved on this device. Nothing changes
                until you choose.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="sm" className="h-7 px-2.5 text-xs" onClick={enterOffline} data-offline-enter>
                Go offline
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2.5 text-xs hover:bg-amber-100 dark:hover:bg-amber-900/50"
                onClick={dismissPrompt}
              >
                Not now
              </Button>
            </div>
          </div>
        ) : (
          <div
            role="status"
            className="pointer-events-auto mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-sky-300 bg-sky-50 px-4 py-2.5 text-sm text-sky-900 shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-sky-700/60 dark:bg-sky-950/80 dark:text-sky-200"
          >
            <Wifi className="h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Connection is back</p>
              <p className="text-xs opacity-80">
                {stillDown
                  ? 'The server still can’t be reached. Staying in offline mode for now.'
                  : 'You’re in offline mode. Go back online to see everything and pick up new meetings.'}
              </p>
            </div>
            <Button
              size="sm"
              className="h-7 shrink-0 px-2.5 text-xs"
              disabled={leaving}
              onClick={() => void goOnline()}
              data-offline-exit
            >
              {leaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Back online
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
