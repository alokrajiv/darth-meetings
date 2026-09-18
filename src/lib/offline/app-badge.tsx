'use client';

import { useEffect } from 'react';
import { useOffline } from './offline-context';
import { badgingSupported, clearAppBadge, isStandalone, setAppBadge } from './installed-app';

/**
 * Keeps the installed app's icon badge equal to the number of the caller's
 * meetings waiting for speaker review (transcript ready, notes not yet
 * generated) — GET /api/offline/badge. Mounted once in the root layout;
 * renders nothing.
 *
 * Only runs where a badge can show (Badging API present AND the app was
 * launched standalone) and only while the server is reachable in online
 * mode; the badge is cleared whenever the count is zero and left alone
 * offline (a stale number beats a wrong zero). Refreshes every
 * BADGE_PERIOD_MS while visible and on every return to the window.
 */

export const BADGE_URL = '/api/offline/badge';
const BADGE_PERIOD_MS = 5 * 60_000;

export function AppBadge() {
  const { ready, online, mode } = useOffline();

  useEffect(() => {
    if (!ready || mode !== 'online' || !online) return;
    if (!badgingSupported() || !isStandalone()) return;
    let stopped = false;
    let inflight = false;

    const tick = async () => {
      if (stopped || inflight || document.visibilityState === 'hidden') return;
      inflight = true;
      try {
        const res = await fetch(BADGE_URL, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
        if (!res.ok) return; // 401/503: leave the badge as it is
        const body = (await res.json()) as { count?: unknown };
        const n = typeof body.count === 'number' && Number.isFinite(body.count) ? body.count : 0;
        if (!stopped) await (n > 0 ? setAppBadge(n) : clearAppBadge());
      } catch {
        /* offline blip — next tick */
      } finally {
        inflight = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), BADGE_PERIOD_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [ready, online, mode]);

  return null;
}
