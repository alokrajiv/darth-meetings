'use client';

import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { Button } from '@/components/ui/button';
import { RecordingsSurface, useRecordingsPage } from '@/components/recordings-surface';

/**
 * Recordings — the caller's own recordings that belong to no meeting
 * (docs/recordings-meetings-series-design.md §3.1). A top-level surface next
 * to Meetings and Series (Q11), not a tab of the meetings listing: a
 * recording is not a kind of meeting row, and it is never shared.
 *
 * `/?tab=recordings` and `/?tab=scratch` (the old tabs) land here; the
 * latter opens on the Temporary section (`#temporary`).
 */
export default function RecordingsPage() {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const initialFilter = useMemo(
    () => (typeof window !== 'undefined' && window.location.hash === '#temporary' ? 'temporary' : 'all'),
    []
  );
  const data = useRecordingsPage({ enabled: true, tz, initialFilter });
  const { loading, refresh } = data;

  return (
    <div className="min-h-screen">
      <AppHeader>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </AppHeader>
      <main className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        <div className="mb-4">
          <h1 className="text-lg font-semibold tracking-tight">Recordings</h1>
          <p className="text-xs text-muted-foreground">
            Yours alone — recordings are never shared. Link one to a meeting, or make a meeting of
            it, and the meeting is what you share.
          </p>
        </div>
        <RecordingsSurface data={data} />
      </main>
    </div>
  );
}
