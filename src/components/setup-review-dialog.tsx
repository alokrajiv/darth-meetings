'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CalendarDays, MessageSquare, RefreshCw, Bell, CheckCircle2, Loader2 } from 'lucide-react';
import {
  useMsLinkStatus,
  msLinkMissing,
  msConnectHref,
  googleConnectHref,
  type MsLinkStatus,
} from '@/components/connect-nudge-banner';

/**
 * Setup-review dialog (Alok, 2026-08-30) — ONE modal on any page load while
 * the account is missing something Darth Meetings needs, or the one-time
 * review of auto-sync + Slack notification settings hasn't happened:
 *
 *   1. Google link      — calendar sweep, Meet imports, auto-sync (required)
 *   2. Microsoft link   — Teams chat evidence (was the call held/recorded)
 *   3. Auto-sync        — recommended: every meeting, recording, video report
 *   4. Slack DMs        — which kinds to receive
 *
 * "Done" saves 3+4 and stamps user_prefs.setup_reviewed_at (server-side, so
 * the review is one-time per USER). Missing links keep the dialog coming
 * back until they're connected, at most once per 24h per browser
 * ("Remind me tomorrow" → localStorage snooze). Replaces the old connect-
 * nudge banner and the auto-sync announce banner.
 */

const SNOOZE_KEY = 'mw:setup:snooze-until';
const SNOOZE_MS = 24 * 60 * 60 * 1000;

interface GoogleStatus {
  connected: boolean;
  status?: 'ok' | 'revoked' | 'error';
}
interface AutoSyncPayload {
  autoSync: { scope: 'off' | 'mine' | 'all'; mode: string; report: string };
  setupReviewedAt: string | null;
  googleConnected: boolean;
}
interface NotifyPayload {
  prefs: Record<string, boolean>;
  kinds: string[];
  labels: Record<string, { label: string; hint: string }>;
}

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? '0') > Date.now();
  } catch {
    return false;
  }
}
function snooze(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    // storage blocked — comes back next load
  }
}

const SCOPES: Array<{ value: 'off' | 'mine' | 'all'; label: string; hint: string }> = [
  {
    value: 'all',
    label: 'Every meeting I attend — recommended',
    hint: 'Recording + detailed report with video frames, once Google / Microsoft has the artifacts. One import per meeting company-wide; you’re shared in when a colleague already covers it.',
  },
  { value: 'mine', label: 'Only meetings I organise', hint: 'Same, but only where you are the organiser.' },
  { value: 'off', label: 'Off', hint: 'Import by hand (or per series) as before.' },
];

export function SetupReviewDialog() {
  const pathname = usePathname();
  const ms = useMsLinkStatus(true);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [sync, setSync] = useState<AutoSyncPayload | null>(null);
  const [notify, setNotify] = useState<NotifyPayload | null>(null);
  const [scope, setScope] = useState<'off' | 'mine' | 'all'>('all');
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    fetch('/api/google/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setGoogle((d as GoogleStatus | null) ?? { connected: false }))
      .catch(() => setGoogle({ connected: false }));
    fetch('/api/auto-sync')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const p = d as AutoSyncPayload | null;
        setSync(p);
        if (p && p.autoSync.scope !== 'off') setScope(p.autoSync.scope);
      })
      .catch(() => setSync(null));
    fetch('/api/notify-prefs')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const p = d as NotifyPayload | null;
        setNotify(p);
        if (p) setPrefs(p.prefs);
      })
      .catch(() => setNotify(null));
  }, []);

  const googleMissing = google !== null && (!google.connected || google.status === 'revoked');
  const msMissing = msLinkMissing(ms);
  const reviewNeeded = sync !== null && !sync.setupReviewedAt;

  // Decide ONCE per page load, after every status has loaded.
  useEffect(() => {
    if (decided) return;
    if (google === null || ms === null || sync === null || notify === null) return;
    setDecided(true);
    if (pathname?.startsWith('/login')) return;
    if (snoozed()) return;
    if (googleMissing || msMissing || reviewNeeded) setOpen(true);
  }, [decided, google, ms, sync, notify, pathname, googleMissing, msMissing, reviewNeeded]);

  const items = useMemo(
    () => [
      { key: 'google', done: !googleMissing },
      { key: 'microsoft', done: !msMissing },
      { key: 'review', done: !reviewNeeded },
    ],
    [googleMissing, msMissing, reviewNeeded]
  );
  const remaining = items.filter((i) => !i.done).length;

  const later = () => {
    snooze();
    setOpen(false);
  };

  const done = async () => {
    setSaving(true);
    try {
      // Notification switches: only what changed.
      if (notify) {
        const changed: Record<string, boolean> = {};
        for (const k of notify.kinds) if (prefs[k] !== notify.prefs[k]) changed[k] = prefs[k] !== false;
        if (Object.keys(changed).length > 0) {
          await fetch('/api/notify-prefs', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefs: changed }),
          });
        }
      }
      // Auto-sync: the chosen scope (recommended defaults for mode/report on
      // first enable), and the review stamp. Without Google the switch can't
      // be turned on — save 'off' + the stamp; the dialog keeps asking about
      // the Google link (daily) but not about the review.
      const body: Record<string, unknown> = { setupReviewed: true };
      const canEnable = !googleMissing;
      const wanted = canEnable ? scope : 'off';
      if (sync && wanted !== sync.autoSync.scope) body.scope = wanted;
      await fetch('/api/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSync((s) => (s ? { ...s, setupReviewedAt: new Date().toISOString(), autoSync: { ...s.autoSync, scope: wanted } } : s));
      // Still missing a link? Come back tomorrow, not on the next click.
      if (googleMissing || msMissing) snooze();
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : later())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {reviewNeeded ? 'Set up Darth Meetings' : 'Finish setting up Darth Meetings'}
          </DialogTitle>
          <DialogDescription>
            {remaining === 1 ? 'One thing left' : `${remaining} things`} to get meetings importing themselves,
            with the right notifications. Two minutes, once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* 1. Google */}
          <section className="flex items-start gap-3 rounded-md border px-3 py-2.5">
            <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Google — calendar &amp; Meet recordings</p>
              <p className="text-xs text-muted-foreground">
                Finds your meetings and their recordings/transcripts. Required for reminders, imports and auto-sync.
              </p>
            </div>
            {googleMissing ? (
              <Button size="sm" className="h-7 shrink-0 px-2.5 text-xs" onClick={() => { window.location.href = googleConnectHref(); }}>
                {google?.status === 'revoked' ? 'Reconnect' : 'Connect'}
              </Button>
            ) : (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Connected" />
            )}
          </section>

          {/* 2. Microsoft */}
          <section className="flex items-start gap-3 rounded-md border px-3 py-2.5">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Microsoft — Teams meeting chats</p>
              <p className="text-xs text-muted-foreground">
                Tells us whether a Teams call was held, for how long and whether it was recorded — even when another company hosted it.
              </p>
            </div>
            {msMissing ? (
              <Button size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-xs" onClick={() => { window.location.href = msConnectHref(ms); }}>
                {ms?.status === 'revoked' ? 'Reconnect' : 'Connect'}
              </Button>
            ) : (ms as MsLinkStatus | null)?.available === false ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">unavailable</span>
            ) : (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Connected" />
            )}
          </section>

          {/* 3. Auto-sync */}
          <section className="rounded-md border px-3 py-2.5">
            <div className="flex items-start gap-3">
              <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Auto-sync my meetings</p>
                <p className="text-xs text-muted-foreground">
                  Meetings import themselves once the recording exists — speakers identified, report written. Only meetings that start after you turn it on.
                  {googleMissing && ' Needs Google connected first.'}
                </p>
              </div>
            </div>
            <fieldset className="mt-2 space-y-1.5 pl-7" disabled={saving}>
              {SCOPES.map((s) => (
                <label key={s.value} className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="setup-auto-sync"
                    className="mt-0.5 h-3.5 w-3.5 accent-primary"
                    checked={scope === s.value}
                    onChange={() => setScope(s.value)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm leading-tight">{s.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{s.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </section>

          {/* 4. Slack DMs */}
          <section className="rounded-md border px-3 py-2.5">
            <div className="flex items-start gap-3">
              <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Slack DMs from Darth Meetings</p>
                <p className="text-xs text-muted-foreground">Everything on by default — untick what you don’t want.</p>
              </div>
            </div>
            {notify ? (
              <div className="mt-2 grid gap-x-4 gap-y-1 pl-7 sm:grid-cols-2">
                {notify.kinds.map((k) => (
                  <label key={k} className="flex cursor-pointer items-start gap-2" title={notify.labels[k]?.hint}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-primary"
                      checked={prefs[k] !== false}
                      disabled={saving}
                      onChange={(e) => setPrefs((p) => ({ ...p, [k]: e.target.checked }))}
                    />
                    <span className="text-sm leading-tight">{notify.labels[k]?.label ?? k}</span>
                  </label>
                ))}
              </div>
            ) : (
              <Loader2 className="mt-2 ml-7 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </section>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={later}
          >
            Remind me tomorrow
          </button>
          <Button onClick={() => void done()} disabled={saving || sync === null}>
            {saving ? 'Saving…' : googleMissing && scope !== 'off' ? 'Save (auto-sync waits for Google)' : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
