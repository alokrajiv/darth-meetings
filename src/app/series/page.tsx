'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/app-header';
import { SeriesDialog } from '@/components/series-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Plus, Repeat, ScanSearch } from 'lucide-react';

/**
 * The series index: every series in one comparative table (the surface that
 * makes dupes and stubs visible). Row click opens the existing SeriesDialog —
 * deliberately NOT a /series/:id page; the dialog already does sweep, mass
 * import, and membership edits.
 */

interface SeriesIndexEntry {
  id: number;
  title: string;
  member_count: number;
  last_recorded_at: string | null;
  cadence: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
  /** Another series normalizes to the same title — probable dupe, merge me. */
  dup: boolean;
}

interface SeriesIndexResponse {
  series: SeriesIndexEntry[];
  totals: { memberships: number; unattached: number };
}

const dateLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

export default function SeriesIndexPage() {
  const [data, setData] = useState<SeriesIndexResponse | null>(null);
  const [error, setError] = useState(false);
  const [openSeriesId, setOpenSeriesId] = useState<number | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/series');
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as SeriesIndexResponse);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runRetroAttach = async () => {
    setSweeping(true);
    setSweepResult(null);
    try {
      const res = await fetch('/api/series/retro-attach', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const r = (await res.json()) as { scanned: number; attached: number; suggestions: number };
      setSweepResult(
        r.attached === 0 && r.suggestions === 0
          ? `No stray meetings found (${r.scanned} checked)`
          : `Attached ${r.attached} meeting${r.attached === 1 ? '' : 's'}` +
              (r.suggestions > 0 ? ` · ${r.suggestions} new suggestion${r.suggestions === 1 ? '' : 's'}` : '')
      );
      void load();
    } catch {
      setSweepResult('Sweep failed — try again');
    } finally {
      setSweeping(false);
    }
  };

  const newSeries = async () => {
    const title = prompt('Series name')?.trim();
    if (!title) return;
    const res = await fetch('/api/series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (res.ok) {
      const j = (await res.json()) as { series: { id: number } };
      void load();
      setOpenSeriesId(j.series.id);
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader>
        <Button
          variant="outline"
          size="sm"
          disabled={sweeping}
          onClick={() => void runRetroAttach()}
          title="Re-match every meeting that belongs to no series against the existing series' evidence keys"
        >
          {sweeping ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
          Re-scan attachments
        </Button>
        <Button size="sm" onClick={() => void newSeries()}>
          <Plus className="h-4 w-4" />
          New series
        </Button>
      </AppHeader>

      <main className="mx-auto max-w-4xl px-6 py-4">
        {sweepResult && (
          <div className="mb-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
            {sweepResult}
          </div>
        )}

        {!data && !error ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-lg border py-10 text-center text-sm text-muted-foreground">
            Couldn’t load series.{' '}
            <button className="text-primary underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : data && data.series.length === 0 ? (
          <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">
            No series yet — recurring meetings create them automatically on import.
          </div>
        ) : (
          data && (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Series</TableHead>
                      <TableHead className="w-24 text-right">Members</TableHead>
                      <TableHead className="w-28">Cadence</TableHead>
                      <TableHead className="w-36">Last meeting</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.series.map((s) => (
                      <TableRow
                        key={s.id}
                        className="cursor-pointer"
                        onClick={() => setOpenSeriesId(s.id)}
                      >
                        <TableCell className="py-2.5 pl-4">
                          <div className="flex min-w-0 items-center gap-2">
                            <Repeat className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                            <span className="min-w-0 truncate text-sm font-medium">{s.title}</span>
                            {s.dup && (
                              <Badge
                                variant="outline"
                                className="shrink-0 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-500"
                                title="Another series has the same name — probably a duplicate. Open one and use Merge."
                              >
                                dup
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-sm tabular-nums">
                          {s.member_count}
                        </TableCell>
                        <TableCell className="py-2.5 text-xs text-muted-foreground">
                          {s.cadence ?? '—'}
                        </TableCell>
                        <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                          {dateLabel(s.last_recorded_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="mt-2.5 px-1 text-[11px] text-muted-foreground">
                {data.series.length} series · {data.totals.memberships} membership
                {data.totals.memberships === 1 ? '' : 's'} · {data.totals.unattached} meeting
                {data.totals.unattached === 1 ? '' : 's'} in no series
              </p>
            </>
          )
        )}
      </main>

      <SeriesDialog
        seriesId={openSeriesId}
        onClose={() => setOpenSeriesId(null)}
        onChanged={() => void load()}
        onMerged={(targetId) => {
          setOpenSeriesId(targetId);
          void load();
        }}
      />
    </div>
  );
}
