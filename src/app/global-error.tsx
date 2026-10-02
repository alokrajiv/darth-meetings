'use client';

import { useEffect, useState } from 'react';
import {
  fetchNotice,
  isChunkLoadError,
  noticeEtaText,
  type MaintenanceNotice,
} from '@/lib/maintenance-notice';

/**
 * Replaces Next's built-in "This page couldn't load" (Reload / Back) page —
 * the page users saw during the 2026-10-02 in-place deploy, when the running
 * server handed out chunks of a half-written build. The Electron shell shows
 * this page too: it is the app's, not the shell's.
 *
 * What it adds:
 *  - the owner's deploy notice (`/__notice.json`, deploy.sh --message) with
 *    its ETA, when there is one — never an automatic "deploying" text;
 *  - for a chunk-load error (a tab on another build than the server — version
 *    skew) or while a notice is up: polls /api/health every 5 s and reloads by
 *    itself once the server answers, at most RELOAD_BUDGET times per few
 *    minutes so a real render bug cannot become a reload loop.
 * Reload and Back stay.
 *
 * Renders its own <html>/<body> (it replaces the root layout), inline styles
 * only — the app's CSS may be exactly what failed to load.
 */
const RETRY_MS = 5000;
const RELOAD_BUDGET = 3;
const BUDGET_WINDOW_MS = 5 * 60 * 1000;
const BUDGET_KEY = 'mw.globalError.reloads';

function takeReloadBudget(): boolean {
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(BUDGET_KEY);
    const times: number[] = (raw ? (JSON.parse(raw) as number[]) : []).filter(
      (t) => typeof t === 'number' && now - t < BUDGET_WINDOW_MS
    );
    if (times.length >= RELOAD_BUDGET) return false;
    times.push(now);
    sessionStorage.setItem(BUDGET_KEY, JSON.stringify(times));
    return true;
  } catch {
    return false; // no storage → no way to bound a loop → no auto reload
  }
}

async function serverAnswers(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
    return res.status === 204 || res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const skew = isChunkLoadError(error);
  const [notice, setNotice] = useState<MaintenanceNotice | null>(null);
  const [checked, setChecked] = useState(false);
  const [autoRetry, setAutoRetry] = useState(skew);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cycle = async () => {
      const n = await fetchNotice();
      if (stopped) return;
      setNotice(n);
      setChecked(true);
      const retrying = skew || n !== null;
      setAutoRetry(retrying);
      if (!retrying) return;
      if (await serverAnswers()) {
        if (stopped) return;
        if (takeReloadBudget()) {
          window.location.reload();
          return;
        }
        setAutoRetry(false); // reloaded enough already: leave it to the buttons
        return;
      }
      if (!stopped) timer = setTimeout(() => void cycle(), RETRY_MS);
    };
    // The first check waits one beat: a server mid-switch answers a moment later.
    timer = setTimeout(() => void cycle(), skew ? 1500 : 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [skew]);

  const eta = notice ? noticeEtaText(notice) : null;
  const message = notice
    ? notice.message
    : skew
      ? 'Darth Meetings was just updated. Reconnecting to the new version…'
      : error?.digest
        ? 'A server error occurred. Reload to try again.'
        : 'Reload to try again, or go back.';

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          background: 'Canvas',
          color: 'CanvasText',
          colorScheme: 'light dark',
        }}
      >
        <main style={{ maxWidth: 440, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>
            {notice ? 'Darth Meetings is being updated' : 'This page couldn’t load'}
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, margin: '0 0 4px', whiteSpace: 'pre-line' }}>{message}</p>
          {eta ? <p style={{ fontSize: 13, opacity: 0.75, margin: '0 0 4px' }}>Maintenance {eta}</p> : null}
          {checked && autoRetry ? (
            <p style={{ fontSize: 12, opacity: 0.6, margin: '8px 0 0' }}>
              This page reloads by itself when the server is back.
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                font: 'inherit',
                fontSize: 14,
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid transparent',
                background: '#111',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.history.length > 1) window.history.back();
                else window.location.href = '/';
              }}
              style={{
                font: 'inherit',
                fontSize: 14,
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid rgb(127 127 127 / 0.4)',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              Back
            </button>
          </div>
          {error?.digest ? (
            <p style={{ fontSize: 11, opacity: 0.5, marginTop: 24, fontFamily: 'ui-monospace, monospace' }}>
              ERROR {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
