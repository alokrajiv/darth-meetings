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
import { CornerDownRight, Loader2, Plus, Repeat, ScanSearch, Zap } from 'lucide-react';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';

/**
 * The series index: every series in one comparative table (the surface that
 * makes dupes and stubs visible). Row click opens the existing SeriesDialog —
 * deliberately NOT a /series/:id page; the dialog already does sweep, mass
 * import, and membership edits.
 */

interface DupSibling {
  id: number;
  title: string;
  member_count: number;
  reason: string;
}

interface SeriesIndexEntry {
  id: number;
  title: string;
  /** Imported meetings attached to this series. */
  member_count: number;
  last_recorded_at: string | null;
  cadence: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
  /** Another series shares evidence with this one — probable dupe, merge me. */
  dup: boolean;
  dup_with: DupSibling[];
  /** Auto-import is switched on for this series. */
  auto_enabled: boolean;
}

interface SeriesIndexResponse {
  series: SeriesIndexEntry[];
  totals: { memberships: number; unattached: number };
}

/** Per-series result of the occurrence sweep (calendar + Teams), fetched
 * after the list in small chunks so the Importable column fills in
 * progressively. 'error' = that sweep failed; undefined = not fetched yet. */
interface OccCounts {
  total: number;
  imported: number;
  importable: number;
  bare: number;
  upcoming: number;
  external: number;
  googleConnected: boolean;
}
type OccCell = OccCounts | 'error' | 'offline' | undefined;

const COUNTS_CHUNK = 4;

/**
 * Row order: newest series first, but probable duplicates are pulled
 * together — when the first member of a dup group is reached, the whole
 * group is emitted (largest first), siblings marked so the table reads
 * "this one, and these are the same meeting".
 */
function orderWithDupGroups(
  series: SeriesIndexEntry[]
): Array<{ s: SeriesIndexEntry; sibling: boolean }> {
  const byId = new Map(series.map((s) => [s.id, s]));
  const emitted = new Set<number>();
  const out: Array<{ s: SeriesIndexEntry; sibling: boolean }> = [];
  for (const s of series) {
    if (emitted.has(s.id)) continue;
    if (s.dup_with.length === 0) {
      emitted.add(s.id);
      out.push({ s, sibling: false });
      continue;
    }
    // Transitive closure: A~B, B~C → one group.
    const group: SeriesIndexEntry[] = [];
    const stack = [s.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (emitted.has(id)) continue;
      const entry = byId.get(id);
      if (!entry) continue;
      emitted.add(id);
      group.push(entry);
      for (const d of entry.dup_with) if (!emitted.has(d.id)) stack.push(d.id);
    }
    group.sort((a, b) => b.member_count - a.member_count);
    group.forEach((g, i) => out.push({ s: g, sibling: i > 0 }));
  }
  return out;
}

const dateLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

export default function SeriesIndexPage() {
  const [data, setData] = useState<SeriesIndexResponse | null>(null);
  // null = fine; a string = why the index could not load (OFFLINE_TITLE offline).
  const [error, setError] = useState<string | null>(null);
  const [openSeriesId, setOpenSeriesId] = useState<number | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);
  const [newSeriesError, setNewSeriesError] = useState<string | null>(null);
  const [occ, setOcc] = useState<Record<number, OccCell>>({});
  const [occLoading, setOccLoading] = useState(false);
  // Offline mode / network down: the index, the sweep and every action need
  // the server — one "Not available offline" panel stands in for the table.
  const { blocked } = useOfflineGate();

  const load = useCallback(async () => {
    if (blocked) {
      setError(OFFLINE_TITLE);
      return;
    }
    try {
      const res = await fetch('/api/series');
      if (!res.ok) throw await offlineAwareError(res, String(res.status));
      setData((await res.json()) as SeriesIndexResponse);
      setError(null);
    } catch (err) {
      setError(
        isNetworkFailure(err) || (err instanceof Error && err.message === OFFLINE_TITLE)
          ? OFFLINE_TITLE
          : 'Couldn’t load series.'
      );
    }
  }, [blocked]);

  // Re-runs when the connection comes back (blocked flips false → new load).
  useEffect(() => {
    void load();
  }, [load]);

  // Deep link: /series?series=<id> opens that series' dialog on load (the
  // dup banner's "View it" link and anything else that wants to point at a
  // series from another tab). Read once from the URL — no Suspense dance.
  // Not honoured while blocked (the dialog could not load anything).
  useEffect(() => {
    if (blocked) return;
    const raw = new URLSearchParams(window.location.search).get('series');
    const id = raw ? Number(raw) : NaN;
    if (Number.isInteger(id) && id > 0) setOpenSeriesId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Importable column: sweep every series' occurrences in small chunks
  // (server caches the external part per user for 6h, so re-visits are
  // instant). Re-runs when the series set changes (new series / merge).
  const seriesIds = data?.series.map((s) => s.id).join(',') ?? '';
  useEffect(() => {
    if (!seriesIds || blocked) return;
    let cancelled = false;
    const ids = seriesIds.split(',').map(Number);
    (async () => {
      setOccLoading(true);
      for (let i = 0; i < ids.length; i += COUNTS_CHUNK) {
        const chunk = ids.slice(i, i + COUNTS_CHUNK);
        try {
          const res = await fetch(`/api/series/occurrence-counts?ids=${chunk.join(',')}`);
          if (cancelled) return;
          if (!res.ok) throw await offlineAwareError(res, String(res.status));
          const j = (await res.json()) as { counts: Record<number, OccCounts | 'error' | null> };
          setOcc((prev) => {
            const next = { ...prev };
            for (const id of chunk) next[id] = j.counts[id] ?? 'error';
            return next;
          });
        } catch (err) {
          if (cancelled) return;
          const cell: OccCell =
            isNetworkFailure(err) || (err instanceof Error && err.message === OFFLINE_TITLE) ? 'offline' : 'error';
          setOcc((prev) => {
            const next = { ...prev };
            for (const id of chunk) next[id] = cell;
            return next;
          });
        }
      }
      if (!cancelled) setOccLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [seriesIds, blocked]);

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
    } catch (err) {
      setSweepResult(isNetworkFailure(err) ? OFFLINE_TITLE : 'Sweep failed — try again');
    } finally {
      setSweeping(false);
    }
  };

  const newSeries = async () => {
    const title = prompt('Series name')?.trim();
    if (!title) return;
    setNewSeriesError(null);
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw await offlineAwareError(res, `Could not create the series (${res.status})`);
      const j = (await res.json()) as { series: { id: number } };
      void load();
      setOpenSeriesId(j.series.id);
    } catch (err) {
      setNewSeriesError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Could not create the series');
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader>
        <Button
          variant="outline"
          size="sm"
          disabled={sweeping || blocked}
          onClick={() => void runRetroAttach()}
          title={blocked ? OFFLINE_TITLE : "Re-match every meeting that belongs to no series against the existing series' evidence keys"}
        >
          {sweeping ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
          Re-scan attachments
        </Button>
        <Button size="sm" onClick={() => void newSeries()} disabled={blocked} title={blocked ? OFFLINE_TITLE : undefined}>
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
        {newSeriesError && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {newSeriesError}
          </div>
        )}

        {blocked ? (
          <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground" data-series-offline>
            {OFFLINE_TITLE}
          </div>
        ) : !data && !error ? (
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
                      <TableHead
                        className="w-24 text-right"
                        title="Meetings already imported into this app and attached to the series"
                      >
                        Imported
                      </TableHead>
                      <TableHead
                        className="w-28 text-right"
                        title="Occurrences on your calendar / Teams that have a recording or transcript but aren’t imported yet. Swept from YOUR Google Calendar, so a meeting you weren’t invited to shows “—”."
                      >
                        Importable
                      </TableHead>
                      <TableHead className="w-24">Cadence</TableHead>
                      <TableHead className="w-32">Last meeting</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orderWithDupGroups(data.series).map(({ s, sibling }) => {
                      const c = occ[s.id];
                      const dupReason = s.dup_with[0]?.reason ?? null;
                      const dupTitle =
                        s.dup_with.length > 0
                          ? `Probably the same meeting as ${s.dup_with
                              .map((d) => `“${d.title}” (${d.member_count})`)
                              .join(', ')} — ${dupReason}. Open one and use Merge.`
                          : undefined;
                      return (
                        <TableRow
                          key={s.id}
                          className={`${blocked ? '' : 'cursor-pointer'} ${sibling ? 'bg-amber-500/[0.04]' : ''}`}
                          onClick={blocked ? undefined : () => setOpenSeriesId(s.id)}
                          aria-disabled={blocked || undefined}
                          title={blocked ? OFFLINE_TITLE : undefined}
                        >
                          <TableCell className={`py-2.5 ${sibling ? 'pl-7' : 'pl-4'}`}>
                            <div className="flex min-w-0 items-center gap-2">
                              {sibling ? (
                                <CornerDownRight
                                  className="h-3.5 w-3.5 shrink-0 text-amber-600/70 dark:text-amber-500/70"
                                  aria-label="duplicate of the series above"
                                />
                              ) : (
                                <Repeat className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                              )}
                              <span className="min-w-0 truncate text-sm font-medium">{s.title}</span>
                              {s.auto_enabled && (
                                <span
                                  title="Auto-import is on — new occurrences import themselves"
                                  className="shrink-0"
                                >
                                  <Zap className="h-3 w-3 text-blue-500" />
                                </span>
                              )}
                              {s.dup_with.length > 0 && (
                                <Badge
                                  variant="outline"
                                  className="shrink-0 border-amber-500/50 text-[10px] font-normal text-amber-600 dark:text-amber-500"
                                  title={dupTitle}
                                >
                                  dup · {dupReason}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="py-2.5 text-right text-sm tabular-nums">
                            {s.member_count}
                          </TableCell>
                          <TableCell className="py-2.5 text-right text-sm tabular-nums">
                            {c === undefined ? (
                              occLoading ? (
                                <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground/50" />
                              ) : (
                                <span className="text-muted-foreground/50">—</span>
                              )
                            ) : c === 'error' || c === 'offline' ? (
                              <span className="text-xs text-muted-foreground/60" title={c === 'offline' ? OFFLINE_TITLE : 'Sweep failed'}>
                                ?
                              </span>
                            ) : !c.googleConnected ? (
                              <span
                                className="text-muted-foreground/50"
                                title="Connect Google (Import meeting → Connect) to see importable occurrences"
                              >
                                —
                              </span>
                            ) : c.external === 0 ? (
                              <span
                                className="text-muted-foreground/50"
                                title="Not on your calendar — occurrences are swept from your own Google Calendar / Teams"
                              >
                                —
                              </span>
                            ) : (
                              <span
                                className={
                                  c.importable > 0
                                    ? 'font-medium text-amber-600 dark:text-amber-500'
                                    : 'text-muted-foreground'
                                }
                                title={
                                  `${c.external} occurrence${c.external === 1 ? '' : 's'} on your calendar in the last 12 months: ` +
                                  `${c.imported} imported · ${c.importable} importable · ${c.bare} without artifacts` +
                                  (c.upcoming > 0 ? ` · ${c.upcoming} upcoming` : '')
                                }
                              >
                                {c.importable}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="py-2.5 text-xs text-muted-foreground">
                            {s.cadence ?? '—'}
                          </TableCell>
                          <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                            {dateLabel(s.last_recorded_at)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <p className="mt-2.5 px-1 text-[11px] text-muted-foreground">
                {data.series.length} series · {data.totals.memberships} imported meeting
                {data.totals.memberships === 1 ? '' : 's'} in series · {data.totals.unattached} meeting
                {data.totals.unattached === 1 ? '' : 's'} in no series

                {Object.values(occ).some((c) => c && c !== 'error' && c !== 'offline' && c.googleConnected && c.external === 0) && (
                  <>
                    {' '}
                    · Importable “—” = not on your calendar (occurrences are swept from your own
                    Google Calendar / Teams)
                  </>
                )}
                {(() => {
                  const groups = orderWithDupGroups(data.series).filter((r) => r.sibling).length;
                  return groups > 0 ? (
                    <>
                      {' '}
                      · <span className="text-amber-600 dark:text-amber-500">{groups} probable duplicate{groups === 1 ? '' : 's'}</span> — open
                      one and Merge
                    </>
                  ) : null;
                })()}
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
