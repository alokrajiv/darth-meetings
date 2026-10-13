'use client';

import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { AppWindow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DARTH_DESKTOP_DOWNLOAD_URL,
  OPEN_IN_APP_TIMEOUT_MS,
  OPEN_IN_DARTH_LABELS,
  OPEN_IN_DARTH_TESTID,
  appOpenVerdict,
  decideOpenInDarth,
} from '@/lib/open-in-darth';

/**
 * "Open in Darth" (README "Darth desktop shell" → Open in Darth; family
 * contract C1). A ghost button in AppHeader's right cluster, so it sits in
 * the same spot on the listing, a meeting page (`/m/<uuid>` lands on
 * `/transcript/<id>`), Settings and every other page.
 *
 * Nothing renders during SSR or the hydrating render: the UA, webdriver and
 * touch points are client facts, so "am I in a browser yet" is an external
 * store (server snapshot false) — no hydration mismatch, no effect-setState.
 *
 * Click → `location.href = darth://meetings<path><query><hash>` read LIVE at
 * click time (the listing rewrites `?label=` in place), then chat's probe:
 * after OPEN_IN_APP_TIMEOUT_MS, still visible and never left → the shell is
 * not installed → the button becomes "Darth didn't open — install it". The
 * probe runs once per page load (module state survives client-side
 * navigation, which remounts the header); after an "opened" verdict the
 * button stays and a further click just re-sends the deep link.
 */

type AttemptState = 'idle' | 'trying' | 'opened' | 'missing';

let attempt: AttemptState = 'idle';
const listeners = new Set<() => void>();
function setAttempt(next: AttemptState) {
  attempt = next;
  for (const cb of listeners) cb();
}
function subscribeAttempt(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const attemptSnapshot = () => attempt;
const attemptServerSnapshot = (): AttemptState => 'idle';

const subscribeNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

function liveDecision() {
  return decideOpenInDarth({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver === true,
    maxTouchPoints: navigator.maxTouchPoints,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
}

function openInDarth() {
  const d = liveDecision();
  if (d.kind !== 'show') return;
  if (attempt === 'idle') {
    setAttempt('trying');
    let left = false;
    const leave = () => {
      left = true;
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') left = true;
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', onVisibility);
    window.setTimeout(() => {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', onVisibility);
      setAttempt(appOpenVerdict({ visibility: document.visibilityState, leftPage: left }) === 'opened' ? 'opened' : 'missing');
    }, OPEN_IN_APP_TIMEOUT_MS);
  } else if (attempt !== 'opened') {
    return;
  }
  try {
    window.location.href = d.href;
  } catch {
    // A blocked scheme navigation goes nowhere — exactly what the armed timer concludes on its own.
  }
}

export function OpenInDarth() {
  // Re-render on client-side navigation; the href itself is read at click time.
  usePathname();
  const client = useSyncExternalStore(subscribeNothing, onClient, onServer);
  const state = useSyncExternalStore(subscribeAttempt, attemptSnapshot, attemptServerSnapshot);
  if (!client || liveDecision().kind !== 'show') return null;

  if (state === 'missing') {
    return (
      <span
        data-testid={OPEN_IN_DARTH_TESTID.missing}
        className="hidden whitespace-nowrap text-xs text-muted-foreground md:inline"
        role="status"
      >
        {OPEN_IN_DARTH_LABELS.notOpened} —{' '}
        <a
          href={DARTH_DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          {OPEN_IN_DARTH_LABELS.install}
        </a>
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={OPEN_IN_DARTH_TESTID.button}
      className="hidden md:inline-flex"
      title={OPEN_IN_DARTH_LABELS.buttonTitle}
      disabled={state === 'trying'}
      onClick={openInDarth}
    >
      <AppWindow className="h-4 w-4" />
      {OPEN_IN_DARTH_LABELS.button}
    </Button>
  );
}
