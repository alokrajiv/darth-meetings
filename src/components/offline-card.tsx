'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CheckCircle2, CircleAlert, CloudDownload, CloudOff, Loader2, RefreshCw, Trash2, Wifi, X } from 'lucide-react';
import { OFFLINE_TITLE, useOffline } from '@/lib/offline/offline-context';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';
import { clearAllOffline, pinMeeting, unpinMeeting } from '@/lib/offline/offline-pins';
import { OFFLINE_CHANGE_EVENT, type OfflinePrefs, type PinLevel, type PinRecord } from '@/lib/offline/offline-types';
import { formatBytes } from '@/lib/format';

/**
 * Settings card for offline support. Two halves:
 *  - "Defaults (this account)" — how many recent meetings every device of
 *    this user keeps automatically, per tier (server-side, /api/offline/prefs).
 *  - "This device" — what THIS browser actually holds: storage, last sync,
 *    the pin ledger with per-row level changes (any change here becomes a
 *    manual pin the auto policy leaves alone), plus the escape hatches
 *    (sync now, clear everything, enter offline mode by hand).
 *
 * Numbers are saved on blur / Enter, optimistically; a failed save reverts
 * to the server copy and shows the error inline.
 */

interface PrefsPayload {
  prefs: OfflinePrefs;
  defaults: OfflinePrefs;
  max: OfflinePrefs;
}

const TIERS: Array<{ key: keyof OfflinePrefs; label: string; hint: string }> = [
  { key: 'transcripts', label: 'Transcripts', hint: 'Newest meetings kept with their page, notes and report (~1 MB each).' },
  { key: 'audio', label: 'With audio', hint: 'Of those, the newest with a recording also get a compact audio copy (~30 MB per hour).' },
  { key: 'video', label: 'With video', hint: 'Of those, the newest with video also get the full recording (can be GBs).' },
];

const LEVEL_OPTIONS: Array<{ value: PinLevel; label: string }> = [
  { value: 'none', label: 'Not saved' },
  { value: 'transcript', label: 'Transcript' },
  { value: 'audio', label: 'Transcript + audio' },
  { value: 'video', label: 'Transcript + audio + video' },
];

/** Resolves on the first ledger event for `id` (the 'pending' write). */
function firstPinEvent(id: string): Promise<void> {
  return new Promise((resolve) => {
    const onChange = (ev: Event) => {
      const d = (ev as CustomEvent<{ kind?: string; id?: string }>).detail;
      if ((d?.kind === 'pin' || d?.kind === 'unpin') && d.id === id) {
        window.removeEventListener(OFFLINE_CHANGE_EVENT, onChange);
        resolve();
      }
    };
    window.addEventListener(OFFLINE_CHANGE_EVENT, onChange);
  });
}

function rowBytes(r: PinRecord): number {
  return r.bytes.transcript + r.bytes.audio + r.bytes.video;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export function OfflineCard() {
  const { pins, sw, mode, online, syncing, syncState, syncNow, storage, enterOffline, exitOffline, refreshPins } = useOffline();
  // Offline mode / network down: the account defaults and per-row upgrades
  // need the server; the per-row remove (X) stays live as the downgrade path.
  const blocked = mode === 'offline' || !online;
  const OFFLINE_DEFAULTS_COPY = `${OFFLINE_TITLE} — the counts apply when you're back online`;

  // --- account defaults -------------------------------------------------
  const [data, setData] = useState<PrefsPayload | null>(null);
  const [draft, setDraft] = useState<Record<keyof OfflinePrefs, string>>({ transcripts: '', audio: '', video: '' });
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<keyof OfflinePrefs | null>(null);

  // Re-runs when the connection comes back (blocked flips false).
  useEffect(() => {
    if (blocked) {
      setPrefsError(OFFLINE_DEFAULTS_COPY);
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/offline/prefs');
        if (!res.ok) throw await offlineAwareError(res, String(res.status));
        const json = (await res.json()) as PrefsPayload;
        setData(json);
        setDraft({
          transcripts: String(json.prefs.transcripts),
          audio: String(json.prefs.audio),
          video: String(json.prefs.video),
        });
        setPrefsError(null);
      } catch (err) {
        setPrefsError(
          isNetworkFailure(err) || (err instanceof Error && err.message === OFFLINE_TITLE)
            ? OFFLINE_DEFAULTS_COPY
            : 'Couldn’t load offline defaults.'
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  const savePref = async (key: keyof OfflinePrefs) => {
    if (!data || savingKey) return;
    // An emptied field is "no change", not 0 — Number('') === 0 would
    // silently save 0 on blur and evict every auto pin.
    if (draft[key].trim() === '') {
      setDraft((d) => ({ ...d, [key]: String(data.prefs[key]) }));
      return;
    }
    const n = Number(draft[key]);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      setDraft((d) => ({ ...d, [key]: String(data.prefs[key]) }));
      setPrefsError('Enter a whole number, 0 or more.');
      return;
    }
    const clamped = Math.min(n, data.max[key]);
    if (clamped === data.prefs[key]) {
      setDraft((d) => ({ ...d, [key]: String(clamped) }));
      return;
    }
    const before = data.prefs;
    setData({ ...data, prefs: { ...data.prefs, [key]: clamped } });
    setDraft((d) => ({ ...d, [key]: String(clamped) }));
    setSavingKey(key);
    setPrefsError(null);
    try {
      const res = await fetch('/api/offline/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: clamped }),
      });
      const json = (await res.json().catch(() => null)) as (PrefsPayload & { error?: string }) | null;
      if (!res.ok || !json?.prefs) {
        setData((d) => (d ? { ...d, prefs: before } : d));
        setDraft((d) => ({ ...d, [key]: String(before[key]) }));
        setPrefsError(json?.error ?? `Save failed (${res.status})`);
        return;
      }
      setData(json);
      setDraft({ transcripts: String(json.prefs.transcripts), audio: String(json.prefs.audio), video: String(json.prefs.video) });
      // The next sync applies the new counts; kick it so the change is visible.
      void syncNow();
    } catch {
      setData((d) => (d ? { ...d, prefs: before } : d));
      setDraft((d) => ({ ...d, [key]: String(before[key]) }));
      setPrefsError('Save failed — check your connection.');
    } finally {
      setSavingKey(null);
    }
  };

  // --- this device ---------------------------------------------------------
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [stillDown, setStillDown] = useState(false);

  const supported = sw !== 'unsupported';
  const visiblePins = pins.filter((p) => p.level !== 'none' || p.manual);
  const pinnedTotal = storage ? storage.pinned.transcript + storage.pinned.audio + storage.pinned.video : 0;

  // The row is "busy" only until the ledger holds the new level (the
  // 'pending' write); the download itself can take minutes and the row's
  // own status column tracks it. Blocking every row that long would make
  // the table unusable.
  const changeLevel = async (r: PinRecord, level: PinLevel) => {
    if (busyId) return;
    setBusyId(r.id);
    setRowError(null);
    const run = pinMeeting(r.id, level, { manual: true });
    run.catch((err) => {
      const msg = err instanceof Error ? err.message : 'Could not change the level';
      // The sync engine reports the SW's offline 503 as '<url> → 503'.
      setRowError(blocked || isNetworkFailure(err) || /→ 503$/.test(msg) ? OFFLINE_TITLE : msg);
    });
    try {
      await Promise.race([run, firstPinEvent(r.id)]);
    } catch {
      /* reported above */
    } finally {
      setBusyId(null);
      void refreshPins();
    }
  };

  const remove = async (r: PinRecord) => {
    if (busyId) return;
    setBusyId(r.id);
    setRowError(null);
    try {
      await unpinMeeting(r.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not remove');
    } finally {
      setBusyId(null);
      void refreshPins();
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      await clearAllOffline();
    } finally {
      setClearing(false);
      setConfirmClear(false);
      void refreshPins();
    }
  };

  const goOnline = async () => {
    setLeaving(true);
    setStillDown(false);
    try {
      if (!(await exitOffline())) setStillDown(true);
    } finally {
      setLeaving(false);
    }
  };

  return (
    <Card id="offline">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudDownload className="h-4 w-4" />
          Offline
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Keep recent meetings on this device so they open on a plane or a bad hotel connection.
          Saved copies live only in this browser; the counts below apply to every device you sign in on.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {!supported && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            This browser can’t keep pages offline (no service worker or cache storage). The account
            defaults still apply to your other devices.
          </p>
        )}

        {/* ---- Defaults (this account) ---------------------------------- */}
        <section>
          <h3 className="mb-1 text-sm font-medium">Defaults (this account)</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            A ladder: audio always includes the transcript, video always includes both. Meetings you
            pick by hand (below, or from a meeting page) are never touched by these counts.
          </p>
          {prefsError && (
            <p className={`mb-2 text-xs ${prefsError === OFFLINE_DEFAULTS_COPY ? 'text-muted-foreground' : 'text-destructive'}`}>
              {prefsError}
            </p>
          )}
          {!data && !prefsError ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : data ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {TIERS.map((t) => (
                <label key={t.key} className="text-xs text-muted-foreground">
                  <span className="flex items-center justify-between">
                    {t.label}
                    {savingKey === t.key && <Loader2 className="h-3 w-3 animate-spin" />}
                  </span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={data.max[t.key]}
                    step={1}
                    className="mt-1 h-8 tabular-nums"
                    value={draft[t.key]}
                    disabled={savingKey !== null || blocked}
                    title={blocked ? OFFLINE_TITLE : undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, [t.key]: e.target.value }))}
                    onBlur={() => void savePref(t.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    aria-label={`${t.label} to keep offline`}
                  />
                  <span className="mt-1 block text-[11px]">
                    {t.hint} Max {data.max[t.key]}, default {data.defaults[t.key]}.
                  </span>
                </label>
              ))}
            </div>
          ) : null}
        </section>

        {/* ---- This device ---------------------------------------------- */}
        <section>
          <h3 className="mb-1 text-sm font-medium">This device</h3>
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Storage used</dt>
            <dd className="tabular-nums">
              {formatBytes(pinnedTotal)} pinned
              {storage?.usage != null ? ` · ${formatBytes(storage.usage)} used by this app` : ''}
              {storage?.quota ? ` · ${formatBytes(storage.quota)} available` : ''}
            </dd>
            <dt className="text-muted-foreground">Last sync</dt>
            <dd>
              {syncing ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {syncState.total > 0 ? `${syncState.done} of ${syncState.total}` : 'starting…'}
                  {syncState.current ? <span className="truncate text-muted-foreground">· {syncState.current}</span> : null}
                </span>
              ) : syncState.lastSync ? (
                <span title={new Date(syncState.lastSync).toLocaleString()}>
                  {formatDistanceToNow(new Date(syncState.lastSync), { addSuffix: true })}
                </span>
              ) : (
                'never'
              )}
              {syncState.error && !syncing && (
                <span className="ml-2 text-destructive" title={syncState.error}>
                  last sync failed: {syncState.error}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Mode</dt>
            <dd>
              {mode === 'offline' ? 'Offline mode' : online ? 'Online' : 'Online mode, but the server is unreachable'}
            </dd>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!supported || syncing || mode === 'offline' || !online}
              onClick={() => void syncNow()}
              title="Apply the defaults now and refresh saved copies"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              Sync now
            </Button>
            {mode === 'offline' ? (
              <Button size="sm" variant="outline" className="h-8" disabled={leaving} onClick={() => void goOnline()}>
                {leaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                Exit offline mode
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!supported}
                onClick={enterOffline}
                title="Browse only what is saved here — handy before a flight, or to check what you'd have"
              >
                <CloudOff className="h-3.5 w-3.5" />
                Enter offline mode
              </Button>
            )}
            {confirmClear ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
                Remove everything saved on this device?
                <Button size="sm" variant="destructive" className="h-6 px-2 text-xs" disabled={clearing} onClick={() => void clearAll()}>
                  {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Clear
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={clearing} onClick={() => setConfirmClear(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-muted-foreground hover:text-destructive"
                disabled={!supported || clearing}
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear offline data
              </Button>
            )}
          </div>
          {stillDown && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Still can’t reach the server — staying in offline mode.
            </p>
          )}

          {rowError && <p className="mt-3 text-xs text-destructive">{rowError}</p>}

          {visiblePins.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8 bg-muted/50 pl-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Meeting</TableHead>
                    <TableHead className="h-8 w-[100px] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Date</TableHead>
                    <TableHead className="h-8 w-[200px] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Level</TableHead>
                    <TableHead className="h-8 w-[80px] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Size</TableHead>
                    <TableHead className="h-8 w-[90px] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</TableHead>
                    <TableHead className="h-8 w-[40px] bg-muted/50">&nbsp;</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visiblePins.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-0 pl-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <Link
                            href={`/transcript/${encodeURIComponent(r.id)}`}
                            className="min-w-0 truncate text-sm hover:underline underline-offset-2"
                          >
                            {r.title || 'Untitled meeting'}
                          </Link>
                          <Badge variant="outline" className="shrink-0 text-[10px]" title={r.manual ? 'You chose this level; the defaults leave it alone' : 'Kept by the account defaults'}>
                            {r.manual ? 'manual' : 'auto'}
                          </Badge>
                        </span>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">{fmtDate(r.recordedAt)}</TableCell>
                      <TableCell>
                        <select
                          className="block w-full rounded-md border bg-background px-2 py-1 text-xs text-foreground"
                          value={r.level}
                          disabled={busyId === r.id || !supported || blocked}
                          title={blocked ? OFFLINE_TITLE : undefined}
                          onChange={(e) => void changeLevel(r, e.target.value as PinLevel)}
                          aria-label="Offline level"
                        >
                          {LEVEL_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {r.level === 'none' ? '—' : formatBytes(rowBytes(r))}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.level === 'none' ? (
                          <span className="text-muted-foreground" title="Excluded from the automatic defaults">excluded</span>
                        ) : busyId === r.id || r.status === 'pending' ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            saving
                          </span>
                        ) : r.status === 'error' ? (
                          <span className="inline-flex items-center gap-1 text-destructive" title={r.error}>
                            <CircleAlert className="h-3 w-3" />
                            failed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" />
                            ready
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="pr-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          disabled={busyId === r.id}
                          title="Remove from this device (the defaults may save it again)"
                          onClick={() => void remove(r)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <p className="mt-3 text-[11px] text-muted-foreground">
            Safari deletes saved data after 7 days without a visit; add Darth Meetings to the Dock
            (File › Add to Dock) to keep it. Signing out clears everything saved here.
          </p>
        </section>
      </CardContent>
    </Card>
  );
}
