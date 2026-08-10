'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Repeat, Plus, Check, X, Loader2 } from 'lucide-react';

/**
 * The "recurring call" badge.
 *
 * With a membership: a clickable chip (opens the series dialog via
 * onOpenSeries). Without one: a hover-revealed ghost affordance that opens a
 * popover with guessed candidate series ("is this also …?"), a picker over
 * existing series, and create-new. The popover is position:fixed so it
 * escapes the listing table's overflow-hidden container.
 */

export interface SeriesMembershipRef {
  series_id: number;
  title: string;
}

interface Candidate {
  series_id: number;
  title: string;
  matched_kinds: string[];
  strong: boolean;
}

interface SeriesListEntry {
  id: number;
  title: string;
  member_count: number;
}

interface SeriesBadgeProps {
  assemblyaiId: string;
  membership: SeriesMembershipRef | null;
  /** Weak-evidence guess for untagged rows — renders a dashed "title?" chip
   * that opens the confirm/deny popover instead of the bare + affordance. */
  suspected?: SeriesMembershipRef | null;
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
  suspected,
  defaultTitle,
  onOpenSeries,
  onChanged,
  variant = 'row',
}: SeriesBadgeProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
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
    setNewTitle(defaultTitle?.trim() ?? '');
    void fetch(`/api/transcripts/${assemblyaiId}/series`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCandidates(d?.candidates ?? []))
      .catch(() => setCandidates([]));
  };

  const loadAllSeries = () => {
    setShowPicker(true);
    if (allSeries) return;
    void fetch('/api/series')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAllSeries(d?.series ?? []))
      .catch(() => setAllSeries([]));
  };

  const attach = async (seriesId: number, how: 'confirmed' | 'manual') => {
    setBusy(true);
    try {
      await fetch(`/api/series/${seriesId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcriptId: assemblyaiId, how }),
      });
      close();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const rejectCandidate = async (seriesId: number) => {
    // Remembered exclusion — this guess never comes back.
    setCandidates((prev) => (prev ?? []).filter((c) => c.series_id !== seriesId));
    await fetch(
      `/api/series/${seriesId}/members?transcriptId=${encodeURIComponent(assemblyaiId)}&remember=1`,
      { method: 'DELETE' }
    ).catch(() => {});
  };

  const createSeries = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, fromTranscriptId: assemblyaiId }),
      });
      if (res.ok) {
        close();
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  if (membership) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenSeries(membership.series_id);
        }}
        title={`Recurring call: ${membership.title} — click to see the whole series`}
        className="inline-flex max-w-44 shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
      >
        <Repeat className="h-3 w-3 shrink-0" />
        <span className="truncate">{membership.title}</span>
      </button>
    );
  }

  return (
    <>
      {suspected ? (
        <button
          ref={btnRef}
          type="button"
          onClick={openPopover}
          title={`Looks like part of "${suspected.title}" — click to confirm or dismiss`}
          className="inline-flex max-w-44 shrink-0 items-center gap-1 rounded-full border border-dashed border-primary/35 px-2 py-0.5 text-[11px] text-primary/70 transition-colors hover:bg-primary/5 hover:text-primary"
        >
          <Repeat className="h-3 w-3 shrink-0" />
          <span className="truncate">{suspected.title}</span>
          <span className="shrink-0 font-semibold">?</span>
        </button>
      ) : (
        <button
          ref={btnRef}
          type="button"
          onClick={openPopover}
          title="Mark as a recurring call"
          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-dashed border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-all hover:border-primary/40 hover:text-primary ${
            variant === 'row' ? 'opacity-0 group-hover:opacity-100' : ''
          }`}
        >
          <Repeat className="h-3 w-3" />
          <Plus className="h-2.5 w-2.5" />
          {variant === 'full' && <span className="ml-0.5">Recurring call</span>}
        </button>
      )}
      {open && pos && (
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 288 }}
          className="z-50 rounded-lg border bg-popover p-2 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          {candidates === null ? (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking for matching series…
            </div>
          ) : (
            <>
              {candidates.length > 0 && (
                <div className="mb-1">
                  <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Is this part of…
                  </p>
                  {candidates.map((c) => (
                    <div
                      key={c.series_id}
                      className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-muted"
                    >
                      <Repeat className="h-3 w-3 shrink-0 text-primary/70" />
                      <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void attach(c.series_id, 'confirmed')}
                        title="Yes, add it"
                        className="rounded p-1 text-status-ok hover:bg-status-ok/10"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void rejectCandidate(c.series_id)}
                        title="No — don't suggest this again"
                        className="rounded p-1 text-muted-foreground hover:bg-muted-foreground/10"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {!showPicker && !creating && (
                <div className="space-y-0.5">
                  <button
                    type="button"
                    onClick={loadAllSeries}
                    className="block w-full rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
                  >
                    Choose an existing series…
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
                            onClick={() => void attach(s.id, 'manual')}
                            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
                          >
                            <Repeat className="h-3 w-3 shrink-0 text-primary/70" />
                            <span className="min-w-0 flex-1 truncate">{s.title}</span>
                            <span className="text-[10px] tabular-nums text-muted-foreground">
                              {s.member_count}
                            </span>
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
            </>
          )}
        </div>
      )}
    </>
  );
}
