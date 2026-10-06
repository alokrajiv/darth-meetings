'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/app-header';
import { SeriesDialog } from '@/components/series-dialog';
import {
  LabelChipsStatic,
  SeriesDefinitionForm,
  type SeriesDefinitionValues,
} from '@/components/series-definition';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Plus, Repeat, UserCheck, Zap } from 'lucide-react';
import { isNetworkFailure, networkErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/fetch-errors';
import { describePattern, type SeriesPattern } from '@/lib/series-patterns';

/**
 * The series index (curated series, docs/curated-series-spec.md): every
 * series — everyone sees every series — with its description, patterns,
 * default labels, followers and the number of its meetings YOU can open.
 * Row click opens the SeriesDialog (definition edit, followers, auto-import,
 * occurrences); "New series" opens the definition form.
 */

interface SeriesIndexEntry {
  id: number;
  title: string;
  description: string | null;
  patterns: SeriesPattern[];
  priority: number;
  /** Members the caller can open — never the global count. */
  visible_member_count: number;
  last_recorded_at: string | null;
  cadence: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
  auto_enabled: boolean;
  labels: Array<{ id: number; path: string; color: string | null }>;
  followers: Array<{ email: string; name: string | null }>;
}

interface SeriesIndexResponse {
  /** false until migration 053 is applied — no creating/editing yet. */
  ready: boolean;
  series: SeriesIndexEntry[];
  totals: { memberships: number; unattached: number };
}

const EMPTY_DEFINITION: SeriesDefinitionValues = {
  title: '',
  description: '',
  patterns: [],
  priority: 100,
  labels: [],
};

const dateLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

export default function SeriesIndexPage() {
  const [data, setData] = useState<SeriesIndexResponse | null>(null);
  // null = fine; a string = why the index could not load.
  const [error, setError] = useState<string | null>(null);
  const [openSeriesId, setOpenSeriesId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/series');
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as SeriesIndexResponse);
      setError(null);
    } catch (err) {
      setError(isNetworkFailure(err) ? NETWORK_ERROR_MESSAGE : 'Couldn’t load series.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link: /series?series=<id> opens that series' dialog on load. Read
  // once from the URL — no Suspense dance.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('series');
    const id = raw ? Number(raw) : NaN;
    if (Number.isInteger(id) && id > 0) setOpenSeriesId(id);
  }, []);

  const create = async (v: SeriesDefinitionValues): Promise<string | null> => {
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: v.title,
          description: v.description,
          patterns: v.patterns,
          priority: v.priority,
          labels: v.labels,
        }),
      });
      const j = (await res.json().catch(() => null)) as { series?: { id: number }; error?: string } | null;
      if (!res.ok || !j?.series) return j?.error ?? `Could not create the series (${res.status})`;
      setCreating(false);
      void load();
      setOpenSeriesId(j.series.id);
      return null;
    } catch (err) {
      return networkErrorMessage(err, 'Could not create the series');
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          disabled={data !== null && !data.ready}
          title={data && !data.ready ? 'Curated series are not switched on yet (migration 053)' : undefined}
        >
          <Plus className="h-4 w-4" />
          New series
        </Button>
      </AppHeader>

      <main className="mx-auto max-w-5xl px-6 py-4">
        {!data && !error ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error && !data ? (
          <div className="rounded-lg border py-10 text-center text-sm text-muted-foreground">
            {error}{' '}
            <button className="text-primary underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : data && data.series.length === 0 ? (
          <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">
            No series yet — a series is a hand-made group of recurring meetings: name it, give it
            title patterns, and every matching meeting joins it.
          </div>
        ) : (
          data && (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Series</TableHead>
                      <TableHead className="w-64">Patterns</TableHead>
                      <TableHead className="w-48">Labels · followers</TableHead>
                      <TableHead
                        className="w-24 text-right"
                        title="Meetings in this series that you own or that are shared with you"
                      >
                        Yours
                      </TableHead>
                      <TableHead className="w-28">Last meeting</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.series.map((s) => (
                      <TableRow key={s.id} className="cursor-pointer align-top" onClick={() => setOpenSeriesId(s.id)}>
                        <TableCell className="py-2.5 pl-4">
                          <div className="flex min-w-0 items-center gap-2">
                            <Repeat className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                            <span className="min-w-0 truncate text-sm font-medium">{s.title}</span>
                            {s.auto_enabled && (
                              <span
                                title="Auto-import is on — new occurrences import themselves"
                                className="shrink-0"
                              >
                                <Zap className="h-3 w-3 text-blue-500" />
                              </span>
                            )}
                          </div>
                          {s.description && (
                            <p className="mt-0.5 line-clamp-2 pl-5.5 text-xs text-muted-foreground">
                              {s.description}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="py-2.5">
                          {s.patterns.length === 0 ? (
                            <span className="text-xs text-muted-foreground">manual only</span>
                          ) : (
                            <div className="space-y-0.5">
                              {s.patterns.slice(0, 3).map((p, i) => (
                                <p key={i} className="truncate font-mono text-[11px] text-foreground/80" title={describePattern(p)}>
                                  {describePattern(p)}
                                </p>
                              ))}
                              {s.patterns.length > 3 && (
                                <p className="text-[11px] text-muted-foreground">+{s.patterns.length - 3} more</p>
                              )}
                            </div>
                          )}
                          {s.priority !== 100 && (
                            <p className="text-[10px] text-muted-foreground">priority {s.priority}</p>
                          )}
                        </TableCell>
                        <TableCell className="space-y-1 py-2.5">
                          <LabelChipsStatic labels={s.labels} />
                          {s.followers.length > 0 && (
                            <p
                              className="flex items-center gap-1 text-[11px] text-muted-foreground"
                              title={s.followers.map((f) => f.email).join(', ')}
                            >
                              <UserCheck className="h-3 w-3" />
                              <span className="truncate">
                                {s.followers.map((f) => f.name || f.email.split('@')[0]).join(', ')}
                              </span>
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-sm tabular-nums">
                          {s.visible_member_count}
                          {s.cadence && (
                            <p className="text-[10px] text-muted-foreground">{s.cadence}</p>
                          )}
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
                {data.series.length} series · {data.totals.memberships} of your meeting
                {data.totals.memberships === 1 ? '' : 's'} in a series · {data.totals.unattached} in
                none
              </p>
            </>
          )
        )}
      </main>

      <Dialog open={creating} onOpenChange={(o) => (!o ? setCreating(false) : null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-xl sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat className="h-4 w-4 text-primary" /> New series
            </DialogTitle>
            <DialogDescription>
              Every meeting matching a pattern joins the series and gets its default labels.
              Followers are added by an auditor afterwards.
            </DialogDescription>
          </DialogHeader>
          {creating && (
            <SeriesDefinitionForm
              initial={EMPTY_DEFINITION}
              submitLabel="Create series"
              onSubmit={(v) => create(v)}
              onCancel={() => setCreating(false)}
            />
          )}
        </DialogContent>
      </Dialog>

      <SeriesDialog
        seriesId={openSeriesId}
        onClose={() => setOpenSeriesId(null)}
        onChanged={() => void load()}
      />
    </div>
  );
}
