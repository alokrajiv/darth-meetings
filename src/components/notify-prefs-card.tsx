'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bell, Loader2 } from 'lucide-react';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';

/**
 * Slack DM notification switches (settings page). Self-contained like
 * GoogleAccountCard: fetches /api/notify-prefs on mount, each toggle saves
 * immediately. The kind list + copy come from the server so client and
 * server never disagree on what exists.
 */

interface PrefsPayload {
  prefs: Record<string, boolean>;
  kinds: string[];
  labels: Record<string, { label: string; hint: string }>;
}

export function NotifyPrefsCard() {
  const [data, setData] = useState<PrefsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKind, setSavingKind] = useState<string | null>(null);
  // Offline mode / network down: no load, checkboxes inert.
  const { blocked } = useOfflineGate();

  // Re-runs when the connection comes back (blocked flips false).
  useEffect(() => {
    if (blocked) {
      setError(OFFLINE_TITLE);
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/notify-prefs');
        if (!res.ok) throw await offlineAwareError(res, String(res.status));
        setData((await res.json()) as PrefsPayload);
        setError(null);
      } catch (err) {
        setError(
          isNetworkFailure(err) || (err instanceof Error && err.message === OFFLINE_TITLE)
            ? OFFLINE_TITLE
            : 'Couldn’t load notification settings.'
        );
      }
    })();
  }, [blocked]);

  const toggle = async (kind: string) => {
    if (!data || savingKind) return;
    const next = !data.prefs[kind];
    setSavingKind(kind);
    try {
      const res = await fetch('/api/notify-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: { [kind]: next } }),
      });
      if (!res.ok) throw await offlineAwareError(res, `Save failed (${res.status})`);
      const { prefs } = (await res.json()) as { prefs: Record<string, boolean> };
      setData({ ...data, prefs });
      setError(null);
    } catch (err) {
      setError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Could not save — try again');
    } finally {
      setSavingKind(null);
    }
  };

  return (
    <Card id="notifications">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="h-4 w-4" />
          Slack notifications
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Direct messages from Darth Meetings (delivered via darth). Everything is on by
          default — switch off what you don’t want.
        </p>
      </CardHeader>
      <CardContent>
        {error && !data ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : !data ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-2.5">
            {error && <p className="text-xs text-destructive">{error}</p>}
            {data.kinds.map((kind) => (
              <label key={kind} className="flex cursor-pointer items-start gap-2.5" title={blocked ? OFFLINE_TITLE : undefined}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={data.prefs[kind] !== false}
                  disabled={blocked || savingKind !== null}
                  title={blocked ? OFFLINE_TITLE : undefined}
                  onChange={() => void toggle(kind)}
                />
                <span className="min-w-0">
                  <span className="block text-sm">{data.labels[kind]?.label ?? kind}</span>
                  <span className="block text-xs text-muted-foreground">
                    {data.labels[kind]?.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
