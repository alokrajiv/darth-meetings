'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RefreshCw, Loader2 } from 'lucide-react';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';

/**
 * Settings card for account-level auto-sync (T2): one switch that imports
 * every past meeting the user organised / attended, once artifacts exist.
 * Cross-user dedupe is server-side — if a colleague's auto-sync (or a hand
 * import) already covers a meeting, the user just gets shared in.
 */

type Scope = 'off' | 'mine' | 'all';
type Mode = 'transcript' | 'video' | 'both';
type Report = 'summary' | 'detailed-video' | 'detailed-text' | 'later';

interface Payload {
  autoSync: {
    scope: Scope;
    mode: Mode;
    report: Report;
    since: string | null;
    providers: { gmeet: boolean; teams: boolean };
  };
  googleConnected: boolean;
  overridingSeries?: Array<{
    id: number;
    title: string;
    enabled: boolean;
    byEmail: string;
    mine: boolean;
    mode: Mode;
    report: Report;
  }>;
  activity: Array<{
    occKey: string;
    title: string | null;
    occStart: string | null;
    outcome: string;
    importerEmail: string | null;
    mine: boolean;
    assemblyaiId: string | null;
    detail: string | null;
    updatedAt: string;
  }>;
}

const SCOPES: Array<{ value: Scope; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'Nothing imports by itself (series auto-import still works where you turned it on).' },
  { value: 'mine', label: 'Meetings I organise', hint: 'Past meetings where you are the organiser, once a recording / transcript exists.' },
  { value: 'all', label: 'Every meeting I attend — recommended', hint: 'Everything on your calendar that left artifacts — organised by you or not.' },
];
const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'video', label: 'Recording (re-transcribe, frames) — recommended' },
  { value: 'transcript', label: 'Transcript only (fast, cheap)' },
  { value: 'both', label: 'Both' },
];
const MODE_WORD: Record<Mode, string> = { video: 'recording', transcript: 'transcript only', both: 'both' };
const REPORT_WORD: Record<Report, string> = {
  summary: 'quick summary',
  'detailed-video': 'detailed report + frames',
  'detailed-text': 'detailed report',
  later: 'no notes',
};
const REPORTS: Array<{ value: Report; label: string }> = [
  { value: 'detailed-video', label: 'Detailed report with video frames — recommended' },
  { value: 'summary', label: 'Quick summary' },
  { value: 'detailed-text', label: 'Detailed report' },
  { value: 'later', label: 'Nothing — I’ll pick on the page' },
];

const OUTCOME_LABEL: Record<string, string> = {
  imported: 'imported',
  deferred: 'queued',
  already: 'already imported — shared',
  failed: 'failed',
  no_access: 'no account with access',
  nudged: 'asked the organiser',
};

export function AutoSyncCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Offline mode / network down: nothing here can load or save.
  const { blocked } = useOfflineGate();

  const load = async () => {
    if (blocked) {
      setError(OFFLINE_TITLE);
      return;
    }
    try {
      const res = await fetch('/api/auto-sync');
      if (!res.ok) throw await offlineAwareError(res, String(res.status));
      setData((await res.json()) as Payload);
      setError(null);
    } catch (err) {
      setError(isNetworkFailure(err) || (err instanceof Error && err.message === OFFLINE_TITLE) ? OFFLINE_TITLE : 'Couldn’t load auto-sync settings.');
    }
  };
  // Re-runs when the connection comes back (blocked flips false).
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  const save = async (patch: Record<string, unknown>) => {
    if (!data || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/auto-sync', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = (await res.json().catch(() => null)) as { autoSync?: Payload['autoSync']; error?: string } | null;
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status})`);
        return;
      }
      if (json?.autoSync) setData({ ...data, autoSync: json.autoSync });
      setError(null);
    } catch (err) {
      setError(isNetworkFailure(err) ? OFFLINE_TITLE : 'Could not save — try again');
    } finally {
      setSaving(false);
    }
  };

  const on = data && data.autoSync.scope !== 'off';

  return (
    <Card id="auto-sync">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-4 w-4" />
          Auto-sync my meetings
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Import past meetings by themselves once Google / Microsoft has the recording or transcript.
          De-duplicated across the company: if a colleague’s auto-sync (or a hand import) already
          covers a meeting, you’re shared in instead of importing it again — one import per meeting,
          ever. Only meetings that start after you switch it on.
        </p>
      </CardHeader>
      <CardContent>
        {!data && !error ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {error ? (
          <p className={`mb-3 text-sm ${error === OFFLINE_TITLE ? 'text-muted-foreground' : 'text-destructive'}`}>{error}</p>
        ) : null}
        {data ? (
          <fieldset disabled={blocked} className="contents" title={blocked ? OFFLINE_TITLE : undefined}>
          <div className="space-y-4">
            {!data.googleConnected && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                Connect Google above first — auto-sync reads your calendar through your own connection.
              </p>
            )}
            <fieldset className="space-y-2" disabled={saving}>
              {SCOPES.map((s) => (
                <label key={s.value} className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="radio"
                    name="auto-sync-scope"
                    className="mt-0.5 h-4 w-4 accent-primary"
                    checked={data.autoSync.scope === s.value}
                    onChange={() => void save({ scope: s.value })}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">{s.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {on && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-muted-foreground">
                  What to import
                  <select
                    className="mt-1 block w-full rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
                    value={data.autoSync.mode}
                    disabled={saving}
                    onChange={(e) => void save({ mode: e.target.value })}
                  >
                    {MODES.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted-foreground">
                  After speakers are identified, generate
                  <select
                    className="mt-1 block w-full rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
                    value={data.autoSync.report}
                    disabled={saving}
                    onChange={(e) => void save({ report: e.target.value })}
                  >
                    {REPORTS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-4 text-sm sm:col-span-2">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={data.autoSync.providers.gmeet}
                      disabled={saving}
                      onChange={(e) => void save({ providers: { gmeet: e.target.checked } })}
                    />
                    Google Meet
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={data.autoSync.providers.teams}
                      disabled={saving}
                      onChange={(e) => void save({ providers: { teams: e.target.checked } })}
                    />
                    Microsoft Teams
                  </label>
                  {data.autoSync.since && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      on since {new Date(data.autoSync.since).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            )}

            {(data.overridingSeries?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Series settings that override this switch for you
                </p>
                <p className="mb-1.5 text-[11px] text-muted-foreground">
                  A recurring call with its own auto-import setting is owned by that setting: on →
                  that person’s connection imports it in their mode (you’re shared in and DMed; the
                  report is the strongest ask among everyone in it), off → nobody imports it.
                </p>
                <ul className="space-y-1 text-xs">
                  {data.overridingSeries!.map((s) => (
                    <li key={s.id} className="flex min-w-0 items-center gap-2">
                      <a className="min-w-0 flex-1 truncate hover:underline" href={`/series?series=${s.id}`}>
                        {s.title}
                      </a>
                      <span className="shrink-0 text-muted-foreground">
                        {s.enabled
                          ? `on · ${s.mine ? 'you' : s.byEmail} · ${MODE_WORD[s.mode]} · ${REPORT_WORD[s.report]}`
                          : `off (opt-out by ${s.mine ? 'you' : s.byEmail})`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.activity.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Recent auto-sync activity</p>
                <ul className="space-y-1 text-xs">
                  {data.activity.slice(0, 8).map((a) => (
                    <li key={a.occKey} className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {a.assemblyaiId ? (
                          <a className="hover:underline" href={`/transcript/${a.assemblyaiId}`}>
                            {a.title ?? a.occKey}
                          </a>
                        ) : (
                          a.title ?? a.occKey
                        )}
                        {a.occStart && (
                          <span className="ml-1 text-muted-foreground">
                            {new Date(a.occStart).toLocaleDateString()}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-muted-foreground" title={a.detail ?? undefined}>
                        {OUTCOME_LABEL[a.outcome] ?? a.outcome}
                        {a.importerEmail && !a.mine ? ` via ${a.importerEmail}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          </fieldset>
        ) : null}
      </CardContent>
    </Card>
  );
}
