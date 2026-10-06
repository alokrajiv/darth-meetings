'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Repeat, Plus, X, Loader2 } from 'lucide-react';
import { isNetworkFailure, NETWORK_ERROR_MESSAGE } from '@/lib/fetch-errors';

/**
 * The series badge (curated series, docs/curated-series-spec.md; v2 §11).
 * One badge per series the meeting is in that the viewer may see (the
 * server never names any other) — the transcript page renders one per
 * membership plus one "Add to series" ghost.
 *
 * With a membership: a clickable chip (opens the series dialog via
 * onOpenSeries); on the transcript page (`variant='full'`) an owner or
 * editor also gets "Not this series" — an exclusion the patterns never
 * override. Without one: a hover-revealed ghost affordance that opens a
 * popover with a picker over the curated series ("add to series" — a manual
 * member) and create-new. There are no guesses any more: a pattern match IS
 * membership. The popover is position:fixed so it escapes the listing
 * table's overflow-hidden container.
 */

export interface SeriesMembershipRef {
  series_id: number;
  title: string;
}

interface SeriesListEntry {
  id: number;
  title: string;
  description: string | null;
  /** Server-decided (v2): only the owner/editors of a series add to it. */
  permissions?: { edit?: boolean } | null;
}

interface SeriesBadgeProps {
  assemblyaiId: string;
  membership: SeriesMembershipRef | null;
  /** Owner or editor of the meeting: may change its series (the server
   * enforces it; this only hides the "Not this series" control). */
  canEdit?: boolean;
  /** Default title for "new series" (usually the transcript title). */
  defaultTitle?: string | null;
  onOpenSeries: (seriesId: number) => void;
  onChanged: () => void;
  /** 'row' = ghost + reveal-on-row-hover (listing); 'full' = always visible. */
  variant?: 'row' | 'full';
}

export function SeriesBadge({
  assemblyaiId,
  membership,
  canEdit = false,
  defaultTitle,
  onOpenSeries,
  onChanged,
  variant = 'row',
}: SeriesBadgeProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [allSeries, setAllSeries] = useState<SeriesListEntry[] | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setShowPicker(false);
    setCreating(false);
    setFilter('');
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // Any scroll invalidates the fixed anchor — just close.
    const onScroll = () => close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const openPopover = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 288;
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
    setOpen(true);
    setError(null);
    setNewTitle(defaultTitle?.trim() ?? '');
  };

  const loadAllSeries = () => {
    setShowPicker(true);
    if (allSeries) return;
    void fetch('/api/series')
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load series (${r.status})`);
        return r.json();
      })
      // Only series the viewer owns or edits can take a meeting by hand.
      .then((d) =>
        setAllSeries(((d?.series ?? []) as SeriesListEntry[]).filter((s) => s.permissions?.edit))
      )
      .catch((err) => {
        setAllSeries([]);
        setError(isNetworkFailure(err) ? NETWORK_ERROR_MESSAGE : 'Could not update the series');
      });
  };

  /** The server's own words for a refusal (403: only the owner or an editor
   * can change a meeting's series). */
  const failure = async (res: Response, fallback: string) => {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    return new Error(j?.error ?? `${fallback} (${res.status})`);
  };

  const attach = async (seriesId: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/series/${seriesId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcriptId: assemblyaiId }),
      });
      if (!res.ok) throw await failure(res, 'Could not add it to the series');
      close();
      onChanged();
    } catch (err) {
      setError(isNetworkFailure(err) ? NETWORK_ERROR_MESSAGE : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** "Not this series": out of it, and an exclusion so its patterns never
   * pull the meeting back. */
  const exclude = async () => {
    if (!membership) return;
    if (
      !confirm(
        `Not part of “${membership.title}”? The meeting leaves the series (with its default labels and follow shares), and the series’ patterns won’t pull it back.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/series/${membership.series_id}/members?transcriptId=${encodeURIComponent(assemblyaiId)}&remember=1`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw await failure(res, 'Could not take it out of the series');
      onChanged();
    } catch (err) {
      setError(isNetworkFailure(err) ? NETWORK_ERROR_MESSAGE : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createSeries = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, fromTranscriptId: assemblyaiId }),
      });
      if (!res.ok) throw await failure(res, 'Could not create the series');
      close();
      onChanged();
    } catch (err) {
      setError(isNetworkFailure(err) ? NETWORK_ERROR_MESSAGE : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (membership) {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSeries(membership.series_id);
          }}
          title={`Series: ${membership.title} — click to see the whole series`}
          className="inline-flex max-w-44 shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Repeat className="h-3 w-3 shrink-0" />
          <span className="truncate">{membership.title}</span>
        </button>
        {variant === 'full' && canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void exclude();
            }}
            title="Not this series"
            className="rounded p-0.5 text-muted-foreground/60 hover:text-destructive disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          </button>
        )}
        {error && variant === 'full' && <span className="text-[11px] text-destructive">{error}</span>}
      </span>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={openPopover}
        title="Add to a series"
        className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-dashed border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-all hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 ${
          variant === 'row' ? 'opacity-0 group-hover:opacity-100' : ''
        }`}
      >
        <Repeat className="h-3 w-3" />
        <Plus className="h-2.5 w-2.5" />
        {variant === 'full' && <span className="ml-0.5">Add to series</span>}
      </button>
      {open && pos && (
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 288 }}
          className="z-50 rounded-lg border bg-popover p-2 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          {error && <p className="px-1 pb-1 text-xs text-destructive">{error}</p>}
          {!showPicker && !creating && (
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={loadAllSeries}
                className="block w-full rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
              >
                Add to a series…
              </button>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="block w-full rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
              >
                New series from this meeting
              </button>
            </div>
          )}

          {showPicker && (
            <div>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter series…"
                className="mb-1 h-7 w-full rounded border bg-transparent px-2 text-sm outline-none focus:border-primary/50"
              />
              <div className="max-h-48 overflow-y-auto">
                {allSeries === null ? (
                  <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                  </div>
                ) : (
                  allSeries
                    .filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()))
                    .map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        disabled={busy}
                        onClick={() => void attach(s.id)}
                        title={s.description ?? undefined}
                        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
                      >
                        <Repeat className="h-3 w-3 shrink-0 text-primary/70" />
                        <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      </button>
                    ))
                )}
              </div>
            </div>
          )}

          {creating && (
            <div className="space-y-1.5">
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createSeries();
                }}
                placeholder="Series name"
                className="h-7 w-full rounded border bg-transparent px-2 text-sm outline-none focus:border-primary/50"
              />
              <button
                type="button"
                disabled={busy || !newTitle.trim()}
                onClick={() => void createSeries()}
                className="w-full rounded bg-primary px-2 py-1 text-sm text-primary-foreground disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Create series'}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
