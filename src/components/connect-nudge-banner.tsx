'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { CalendarDays, MessageSquare, X } from 'lucide-react';
import { DARTH_TASKS_URL } from '@/lib/darth-family';

/**
 * Connect nudge — "Darth tools work best with access to your calendar and
 * Teams chats" — shown at the top of the listing when the caller lacks the
 * Google link (calendar sweep, Meet imports) OR the Microsoft link (Teams
 * chat evidence: was the call held, was it recorded — read through the
 * Darth Tasks-owned per-user link).
 *
 *  - Hidden while either status is still loading, and never on /login.
 *  - Dismiss is per service: localStorage `mw:nudge:<service>:until` (7d),
 *    plus `mw:nudge:<service>:state` so a link that later turns *revoked*
 *    re-surfaces the nudge even inside the snooze window.
 *  - Google → the existing /api/google/connect flow (returns to this page);
 *    Microsoft → Darth Tasks /api/ms/connect?return=<this page> — the same
 *    round-trip the Settings card uses (microsoft-account-card.tsx).
 *
 * This file also hosts the page-wide Microsoft link-status cache
 * (`useMsLinkStatus`) so calendar rows / the import dialog can say "Connect
 * Microsoft to see whether it was held" without each fetching /api/ms/status.
 */

export interface MsLinkStatus {
  available: boolean;
  reason?: string;
  configured?: boolean;
  connected?: boolean;
  status?: string | null;
  statusDetail?: string | null;
  msUpn?: string | null;
  connectUrl?: string;
  manageUrl?: string;
}

interface GoogleLinkStatus {
  connected: boolean;
  status?: 'ok' | 'revoked' | 'error';
}

// ---- shared Microsoft status cache (one fetch per page load) -------------

let msCached: MsLinkStatus | null = null;
let msInflight: Promise<MsLinkStatus> | null = null;
const msListeners = new Set<(s: MsLinkStatus) => void>();

async function loadMsStatus(): Promise<MsLinkStatus> {
  try {
    const r = await fetch('/api/ms/status');
    const d = r.ok ? ((await r.json()) as MsLinkStatus) : null;
    return d ?? { available: false, reason: 'load_failed' };
  } catch {
    return { available: false, reason: 'load_failed' };
  }
}

/** (Re)fetch the Microsoft link status and fan it out to every subscriber. */
export function refreshMsLinkStatus(): Promise<MsLinkStatus> {
  if (!msInflight) {
    msInflight = loadMsStatus().then((s) => {
      msCached = s;
      msInflight = null;
      msListeners.forEach((fn) => fn(s));
      return s;
    });
  }
  return msInflight;
}

/**
 * Microsoft (Teams chat) link status, cached page-wide. `null` while
 * loading. Pass `enabled=false` to subscribe without triggering the fetch
 * (rows that may never need it).
 */
export function useMsLinkStatus(enabled = true): MsLinkStatus | null {
  const [status, setStatus] = useState<MsLinkStatus | null>(msCached);
  useEffect(() => {
    msListeners.add(setStatus);
    if (msCached) setStatus(msCached);
    else if (enabled) void refreshMsLinkStatus();
    return () => {
      msListeners.delete(setStatus);
    };
  }, [enabled]);
  return status;
}

/** The Microsoft link is known-missing (Darth Tasks reachable, integration
 * configured, caller not connected). Unreachable/unconfigured → false: there
 * is nothing the user can do from here. */
export function msLinkMissing(s: MsLinkStatus | null): s is MsLinkStatus {
  return !!s && s.available && s.configured !== false && !s.connected;
}

/** Where "Connect Microsoft" goes: Darth Tasks' connect flow, returning to
 * the current page (`?ms=connected|error` bounce, cleaned up on landing). */
export function msConnectHref(status: MsLinkStatus | null, returnTo?: string): string {
  const ret = new URL(returnTo ?? window.location.href);
  ret.searchParams.delete('ms');
  ret.searchParams.delete('reason');
  const base = status?.connectUrl ?? `${DARTH_TASKS_URL}/api/ms/connect`;
  return `${base}?return=${encodeURIComponent(ret.toString())}`;
}

/** Where "Connect Google" goes: our own auth-code flow, returning here. */
export function googleConnectHref(): string {
  const ret = `${window.location.pathname}${window.location.search}`;
  return `/api/google/connect?return=${encodeURIComponent(ret)}`;
}

// ---- dismiss / snooze --------------------------------------------------

type Service = 'google' | 'microsoft';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const untilKey = (s: Service) => `mw:nudge:${s}:until`;
const stateKey = (s: Service) => `mw:nudge:${s}:state`;

function snoozed(service: Service, state: string): boolean {
  try {
    const until = Number(localStorage.getItem(untilKey(service)) ?? '0');
    if (!until || until < Date.now()) return false;
    // A different state than the one dismissed (unlinked → revoked) shows again.
    return (localStorage.getItem(stateKey(service)) ?? 'missing') === state;
  } catch {
    return false;
  }
}

function snooze(service: Service, state: string): void {
  try {
    localStorage.setItem(untilKey(service), String(Date.now() + SNOOZE_MS));
    localStorage.setItem(stateKey(service), state);
  } catch {
    // storage blocked — the nudge just comes back next load
  }
}

// ---- the banner ----------------------------------------------------------

export function ConnectNudgeBanner({ className = '' }: { className?: string }) {
  const pathname = usePathname();
  const ms = useMsLinkStatus(true);
  const [google, setGoogle] = useState<GoogleLinkStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [msError, setMsError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/google/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setGoogle((d as GoogleLinkStatus | null) ?? { connected: false }))
      .catch(() => setGoogle({ connected: false }));
  }, []);

  // Post-connect bounce from Darth Tasks: /?ms=connected|error&reason=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('ms');
    if (!outcome) return;
    if (outcome === 'error') {
      setMsError(params.get('reason') ?? 'unknown');
    } else if (outcome === 'connected') {
      void refreshMsLinkStatus();
    }
    params.delete('ms');
    params.delete('reason');
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    );
  }, []);

  const dismiss = useCallback((service: Service, state: string) => {
    snooze(service, state);
    setMsError(null);
    setTick((t) => t + 1);
  }, []);

  if (pathname?.startsWith('/login')) return null;
  if (ms === null || google === null) return null;

  const googleState = !google.connected ? 'missing' : google.status === 'revoked' ? 'revoked' : null;
  const msState = msLinkMissing(ms) ? (ms.status === 'revoked' ? 'revoked' : 'missing') : null;
  void tick; // re-evaluates the snooze reads below after a dismiss

  const showGoogle = googleState !== null && !snoozed('google', googleState);
  const showMs = (msState !== null && !snoozed('microsoft', msState)) || !!msError;
  if (!showGoogle && !showMs) return null;

  const both = showGoogle && showMs;
  const lead = both
    ? 'Darth tools work best with access to your calendar and Teams chats'
    : showGoogle
      ? googleState === 'revoked'
        ? 'Your Google link expired — reconnect so Darth can keep watching your calendar'
        : 'Darth tools work best with access to your calendar'
      : msState === 'revoked'
        ? 'Your Microsoft link expired — reconnect so Darth can read your Teams meeting chats'
        : 'Darth tools work best with access to your Teams chats';
  const detail = both
    ? 'Google finds your meetings and their recordings; Microsoft tells us whether a Teams call was held and recorded — even when another company hosted it.'
    : showGoogle
      ? 'Google finds your meetings and their recordings and powers reminders and background imports.'
      : 'Microsoft tells us whether a Teams call was held, for how long, and whether it was recorded — even when another company hosted it.';

  return (
    <div
      data-connect-nudge
      role="status"
      className={`mb-4 flex flex-wrap items-start gap-3 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm ${className}`}
    >
      <div className="flex shrink-0 items-center gap-1 pt-0.5 text-primary">
        {showGoogle && <CalendarDays className="h-4 w-4" />}
        {showMs && <MessageSquare className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{lead}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        {msError && (
          <p className="mt-1 text-xs text-destructive">
            Microsoft connect failed ({msError}) — try again.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {showGoogle && (
            <span className="inline-flex items-center gap-1.5">
              <Button
                size="sm"
                className="h-7 px-2.5 text-xs"
                data-connect-google
                onClick={() => {
                  window.location.href = googleConnectHref();
                }}
              >
                {googleState === 'revoked' ? 'Reconnect Google' : 'Connect Google'}
              </Button>
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                title="Hide this for 7 days"
                onClick={() => dismiss('google', googleState!)}
              >
                not now
              </button>
            </span>
          )}
          {showGoogle && showMs && <span className="text-muted-foreground">·</span>}
          {showMs && (
            <span className="inline-flex items-center gap-1.5">
              <Button
                size="sm"
                variant={showGoogle ? 'outline' : 'default'}
                className="h-7 px-2.5 text-xs"
                data-connect-microsoft
                onClick={() => {
                  window.location.href = msConnectHref(ms);
                }}
              >
                {msState === 'revoked' ? 'Reconnect Microsoft' : 'Connect Microsoft'}
              </Button>
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                title="Hide this for 7 days"
                onClick={() => dismiss('microsoft', msState ?? 'missing')}
              >
                not now
              </button>
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Dismiss for 7 days"
        aria-label="Dismiss"
        data-connect-nudge-dismiss
        onClick={() => {
          if (googleState) snooze('google', googleState);
          if (msState) snooze('microsoft', msState);
          setMsError(null);
          setTick((t) => t + 1);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
