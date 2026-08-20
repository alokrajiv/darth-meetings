'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bell, Loader2 } from 'lucide-react';

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
  const [error, setError] = useState(false);
  const [savingKind, setSavingKind] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/notify-prefs');
        if (!res.ok) throw new Error(String(res.status));
        setData((await res.json()) as PrefsPayload);
      } catch {
        setError(true);
      }
    })();
  }, []);

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
      if (res.ok) {
        const { prefs } = (await res.json()) as { prefs: Record<string, boolean> };
        setData({ ...data, prefs });
      }
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
        {error ? (
          <p className="text-sm text-muted-foreground">Couldn’t load notification settings.</p>
        ) : !data ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-2.5">
            {data.kinds.map((kind) => (
              <label key={kind} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={data.prefs[kind] !== false}
                  disabled={savingKind === kind}
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
