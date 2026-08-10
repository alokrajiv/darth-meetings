'use client';

import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  formatBytes,
  formatDuration,
  formatSmartDate,
  type TranscriptListRow,
} from '@/lib/format';
import { useLiveEvents } from '@/hooks/use-live-events';
import {
  Trash2,
  RefreshCw,
  CalendarCheck2,
  CalendarX2,
  FileAudio,
  FileText,
  Search,
  ChevronRight,
  Inbox,
  Columns3,
  GripVertical,
} from 'lucide-react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { SeriesBadge } from '@/components/series-badge';
import { SeriesDialog } from '@/components/series-dialog';

interface TranscriptTableProps {
  refreshTrigger?: number;
  /** Extra controls rendered in the toolbar row, left of the search box. */
  toolbarExtra?: React.ReactNode;
}

type TabKey = 'all' | 'mine' | 'shared';

const RESTING_SHADOW = 'shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]';

/**
 * Configurable middle columns (Title is locked first, actions locked last).
 * Users pick visibility + order via the toolbar chooser; persisted in
 * localStorage under COLS_STORAGE_KEY.
 */
type ColKey = 'owner' | 'date' | 'duration' | 'speakers' | 'language' | 'imported';

interface ColPrefs {
  order: ColKey[];
  hidden: ColKey[];
  /** Show the description/filename line under titles (default on). */
  showDesc: boolean;
  /** Section the list into day buckets with sticky-ish header rows (default on). */
  groupByDay: boolean;
}

/** Local-timezone day bucket key, e.g. "2026-08-10". */
function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Heading for a day bucket: "Today" / "Yesterday" / "Tuesday" (this week,
 * with the short date as a muted suffix) / "Tue, 4 Aug" (this year) /
 * "4 Aug 2025". */
function dayHeading(iso: string): { label: string; sub: string | null } {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000
  );
  const shortDate = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  if (dayDiff === 0) return { label: 'Today', sub: shortDate };
  if (dayDiff === 1) return { label: 'Yesterday', sub: shortDate };
  if (dayDiff > 1 && dayDiff < 7) {
    return { label: d.toLocaleDateString([], { weekday: 'long' }), sub: shortDate };
  }
  if (d.getFullYear() === now.getFullYear()) {
    return {
      label: d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
      sub: null,
    };
  }
  return {
    label: d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }),
    sub: null,
  };
}

/**
 * Descriptions are free-form (sometimes pasted markdown) — flatten to one
 * short plain-text line for the listing.
 */
function cleanDescription(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

const DEFAULT_COL_ORDER: ColKey[] = [
  'owner',
  'date',
  'duration',
  'speakers',
  'language',
  'imported',
];
const DEFAULT_HIDDEN: ColKey[] = ['language', 'imported'];
const COLS_STORAGE_KEY = 'mw:cols:v1';

const COL_LABELS: Record<ColKey, string> = {
  owner: 'Owner',
  date: 'Date',
  duration: 'Duration',
  speakers: 'Speakers',
  language: 'Language',
  imported: 'Imported',
};

/** Width + responsive visibility per column (applied to head & cells). */
const COL_HEAD_WIDTH: Record<ColKey, string> = {
  owner: 'w-[16%]',
  date: 'w-[14%]',
  duration: 'w-[11%]',
  speakers: 'w-[9%]',
  language: 'w-[9%]',
  imported: 'w-[12%]',
};
const COL_RESPONSIVE: Record<ColKey, string> = {
  owner: 'hidden lg:table-cell',
  date: 'hidden md:table-cell',
  duration: 'hidden sm:table-cell',
  speakers: 'hidden lg:table-cell',
  language: 'hidden lg:table-cell',
  imported: 'hidden lg:table-cell',
};

function loadColPrefs(): ColPrefs {
  const defaults: ColPrefs = {
    order: DEFAULT_COL_ORDER,
    hidden: DEFAULT_HIDDEN,
    showDesc: true,
    groupByDay: true,
  };
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ColPrefs>;
    const valid = new Set<ColKey>(DEFAULT_COL_ORDER);
    const order = (parsed.order ?? []).filter((k): k is ColKey => valid.has(k as ColKey));
    // Append any columns added after the prefs were saved.
    for (const k of DEFAULT_COL_ORDER) if (!order.includes(k)) order.push(k);
    const hidden = (parsed.hidden ?? []).filter((k): k is ColKey => valid.has(k as ColKey));
    return {
      order,
      hidden,
      showDesc: parsed.showDesc !== false,
      groupByDay: parsed.groupByDay !== false,
    };
  } catch {
    return defaults;
  }
}

export function TranscriptTable({ refreshTrigger, toolbarExtra }: TranscriptTableProps) {
  const router = useRouter();
  const [transcripts, setTranscripts] = useState<TranscriptListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [openSeriesId, setOpenSeriesId] = useState<number | null>(null);

  // Column prefs (visibility + order) — loaded client-side to avoid SSR
  // localStorage access; saved on every change.
  const [colPrefs, setColPrefs] = useState<ColPrefs>({
    order: DEFAULT_COL_ORDER,
    hidden: DEFAULT_HIDDEN,
    showDesc: true,
    groupByDay: true,
  });
  const [colsOpen, setColsOpen] = useState(false);
  const colsMenuRef = useRef<HTMLDivElement | null>(null);
  const dragKeyRef = useRef<ColKey | null>(null);
  useEffect(() => {
    setColPrefs(loadColPrefs());
  }, []);
  const saveColPrefs = useCallback((next: ColPrefs) => {
    setColPrefs(next);
    try {
      localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage full/blocked — prefs just won't persist
    }
  }, []);
  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (colsMenuRef.current && !colsMenuRef.current.contains(e.target as Node)) {
        setColsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colsOpen]);

  const visibleCols = useMemo(
    () => colPrefs.order.filter((k) => !colPrefs.hidden.includes(k)),
    [colPrefs]
  );

  const loadTranscripts = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true);
      setError(null);
      const res = await fetch('/api/transcripts', { credentials: 'include' });
      if (!res.ok) {
        throw new Error(`Failed to load transcripts (${res.status})`);
      }
      const { transcripts } = (await res.json()) as { transcripts: TranscriptListRow[] };
      setTranscripts(transcripts);
    } catch (err) {
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : 'Failed to load transcripts');
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTranscripts();
  }, [loadTranscripts, refreshTrigger]);

  // Live updates: someone (including another tab or a colleague) changed a
  // transcript — silently refresh the list. Debounced so bursts (bulk
  // imports) coalesce into one reload.
  const liveReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveEvents((e) => {
    if (!['created', 'deleted', 'meta', 'status', 'notes', 'shares'].includes(e.kind)) return;
    if (liveReloadTimer.current) clearTimeout(liveReloadTimer.current);
    liveReloadTimer.current = setTimeout(() => void loadTranscripts({ silent: true }), 800);
  });

  // Global `/` focuses the search input when no other field has focus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const counts = useMemo(() => {
    return {
      all: transcripts.length,
      mine: transcripts.filter((t) => t.access === 'owner').length,
      shared: transcripts.filter((t) => t.access !== 'owner').length,
    };
  }, [transcripts]);

  // Deep search: debounced server-side pass over summaries + full transcript
  // text (the client filter below only sees listing fields). Results merge
  // into `filtered`, with a snippet shown under the title.
  const [deepHits, setDeepHits] = useState<
    Map<string, { matched_in: string; snippet: string | null }>
  >(new Map());
  const [deepSearching, setDeepSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setDeepHits(new Map());
      setDeepSearching(false);
      return;
    }
    setDeepSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/transcripts/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const { hits } = (await res.json()) as {
          hits: Array<{ assemblyai_id: string; matched_in: string; snippet: string | null }>;
        };
        setDeepHits(
          new Map(hits.map((h) => [h.assemblyai_id, { matched_in: h.matched_in, snippet: h.snippet }]))
        );
      } catch {
        // deep search is additive — client filter still works
      } finally {
        setDeepSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  const filtered = useMemo(() => {
    let rows = transcripts;
    if (tab === 'mine') rows = rows.filter((t) => t.access === 'owner');
    else if (tab === 'shared') rows = rows.filter((t) => t.access !== 'owner');
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (t) =>
          [t.title, t.original_filename, t.description, t.owner_name, t.owner_email].some(
            (v) => v?.toLowerCase().includes(q)
          ) || deepHits.has(t.assemblyai_id)
      );
    }
    return rows;
  }, [transcripts, tab, query, deepHits]);

  // Day sections for the grouped view: bucket by local day of the meeting
  // time (recorded_at, falling back to upload time), newest day first,
  // newest meeting first within a day.
  const dayGroups = useMemo(() => {
    if (!colPrefs.groupByDay) return null;
    const when = (t: TranscriptListRow) => t.recorded_at ?? t.created_at;
    const sorted = [...filtered].sort(
      (a, b) => new Date(when(b)).getTime() - new Date(when(a)).getTime()
    );
    const groups: Array<{
      key: string;
      heading: string;
      sub: string | null;
      rows: TranscriptListRow[];
      totalSecs: number;
    }> = [];
    for (const t of sorted) {
      const key = dayKeyOf(when(t));
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        const { label, sub } = dayHeading(when(t));
        g = { key, heading: label, sub, rows: [], totalSecs: 0 };
        groups.push(g);
      }
      g.rows.push(t);
      g.totalSecs += t.duration ?? 0;
    }
    return groups;
  }, [filtered, colPrefs.groupByDay]);

  const handleDeleteTranscript = async (e: React.MouseEvent, assemblyaiId: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this transcript?')) return;

    try {
      const res = await fetch(`/api/transcripts/${assemblyaiId}`, { method: 'DELETE' });
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(detail || `Delete failed (${res.status})`);
      }
      setTranscripts((prev) => prev.filter((t) => t.assemblyai_id !== assemblyaiId));
    } catch (err) {
      alert('Failed to delete transcript: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const statusDot = (status: string) => {
    const base = 'inline-flex h-2 w-2 shrink-0 rounded-full';
    switch (status) {
      case 'completed':
        return <span className={`${base} bg-status-ok`} aria-label="Completed" />;
      case 'processing':
        return <span className={`${base} bg-status-busy animate-pulse`} aria-label="Processing" />;
      case 'uploading':
        return <span className={`${base} bg-primary animate-pulse`} aria-label="Uploading" />;
      case 'queued':
        return <span className={`${base} bg-muted-foreground/40`} aria-label="Queued" />;
      case 'error':
        return <span className={`${base} bg-status-err`} aria-label="Error" />;
      default:
        return <span className={`${base} bg-muted-foreground/40`} aria-label={status} />;
    }
  };

  const sourceIcon = (t: TranscriptListRow) => {
    if (t.provider === 'teams') {
      return (
        <span title="Microsoft Teams meeting" className="shrink-0">
          <TeamsLogo className="h-3.5 w-3.5" />
        </span>
      );
    }
    if (t.provider === 'gmeet' || t.assemblyai_id.startsWith('gmeet-')) {
      return (
        <span title="Google Meet meeting" className="shrink-0">
          <MeetLogo className="h-3.5 w-3.5" />
        </span>
      );
    }
    if (t.source === 'uploaded') {
      return (
        <span title="Uploaded audio" className="shrink-0">
          <FileAudio className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      );
    }
    return (
      <span title="Imported transcript" className="shrink-0">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    );
  };

  /** Calendar linkage at a glance: linked rows get share suggestions +
   * auto-share; unlinked ones can be fixed via "Link calendar event". */
  const calendarIcon = (t: TranscriptListRow) =>
    t.has_event ? (
      <span title="Linked to a calendar event" className="shrink-0">
        <CalendarCheck2 className="h-3.5 w-3.5 text-status-ok/70" />
      </span>
    ) : (
      <span title="No calendar event linked" className="shrink-0">
        <CalendarX2 className="h-3.5 w-3.5 text-muted-foreground/40" />
      </span>
    );

  const ownerCell = (t: TranscriptListRow) => {
    if (t.access === 'owner') {
      return <span className="text-xs text-muted-foreground">You</span>;
    }
    const first = t.owner_name?.trim().split(/\s+/)[0] || t.owner_email || '—';
    return (
      <span className="flex items-center gap-1.5">
        <span className="truncate text-xs text-muted-foreground">{first}</span>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {t.access === 'edit' ? 'Editor' : 'Read'}
        </Badge>
      </span>
    );
  };

  /** Live progress line for rows mid-upload: server-persisted byte counts,
   * refreshed by the SSE 'status' events the upload route publishes. */
  const uploadProgressLine = (t: TranscriptListRow): string => {
    const received = Number(t.upload_bytes_received ?? 0);
    const total = Number(t.upload_bytes_total ?? 0);
    if (total > 0 && received >= total) {
      return 'upload received — handing off to transcription…';
    }
    if (total > 0) {
      const pct = Math.min(99, Math.floor((received / total) * 100));
      return `uploading — ${pct}% · ${formatBytes(received)} of ${formatBytes(total)}`;
    }
    return received > 0 ? `uploading — ${formatBytes(received)} so far` : 'uploading…';
  };

  const titleOf = (
    t: TranscriptListRow
  ): { primary: string; secondary: string | null; untitled: boolean } => {
    // Secondary line: a human-written description beats the raw filename —
    // flattened + truncated, and toggleable from the column chooser.
    const desc =
      colPrefs.showDesc && t.description?.trim()
        ? cleanDescription(t.description) || null
        : null;
    if (t.title && t.title.trim().length > 0) {
      return {
        primary: t.title,
        secondary: desc ?? (colPrefs.showDesc ? t.original_filename || null : null),
        untitled: false,
      };
    }
    if (t.original_filename) {
      return { primary: t.original_filename, secondary: desc, untitled: false };
    }
    return { primary: 'Untitled meeting', secondary: desc, untitled: true };
  };

  const renderColCell = (key: ColKey, t: TranscriptListRow) => {
    switch (key) {
      case 'owner':
        return ownerCell(t);
      case 'date': {
        const when = t.recorded_at ?? t.created_at;
        // Grouped view already names the day in the section header — the
        // column narrows down to time-of-day.
        const label = colPrefs.groupByDay
          ? new Date(when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : formatSmartDate(when);
        return (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            title={new Date(when).toLocaleString()}
          >
            {label || 'Unknown'}
          </span>
        );
      }
      case 'duration':
        return (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {t.duration ? formatDuration(t.duration) : '—'}
          </span>
        );
      case 'speakers':
        return (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t.speaker_count ?? '—'}
          </span>
        );
      case 'language':
        return (
          <span className="text-xs uppercase text-muted-foreground">
            {t.language_code ?? '—'}
          </span>
        );
      case 'imported':
        return (
          <span
            className="text-xs text-muted-foreground"
            title={new Date(t.created_at).toLocaleString()}
          >
            {formatSmartDate(t.created_at) || '—'}
          </span>
        );
    }
  };

  const moveCol = (from: ColKey, to: ColKey) => {
    if (from === to) return;
    const order = [...colPrefs.order];
    const fi = order.indexOf(from);
    const ti = order.indexOf(to);
    if (fi < 0 || ti < 0) return;
    order.splice(fi, 1);
    order.splice(ti, 0, from);
    saveColPrefs({ ...colPrefs, order });
  };

  const columnChooser = (
    <div className="relative" ref={colsMenuRef}>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        title="Choose columns"
        onClick={() => setColsOpen((v) => !v)}
      >
        <Columns3 className="h-4 w-4" />
        <span className="sr-only">Choose columns</span>
      </Button>
      {colsOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-md border bg-popover p-1 shadow-md">
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Columns — drag to reorder
          </p>
          {colPrefs.order.map((key) => {
            const hidden = colPrefs.hidden.includes(key);
            return (
              <div
                key={key}
                draggable
                onDragStart={() => {
                  dragKeyRef.current = key;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragKeyRef.current) moveCol(dragKeyRef.current, key);
                  dragKeyRef.current = null;
                }}
                className="flex cursor-grab items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted active:cursor-grabbing"
              >
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <label className="flex flex-1 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() =>
                      saveColPrefs({
                        ...colPrefs,
                        hidden: hidden
                          ? colPrefs.hidden.filter((k) => k !== key)
                          : [...colPrefs.hidden, key],
                      })
                    }
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {COL_LABELS[key]}
                </label>
              </div>
            );
          })}
          <div className="mt-1 space-y-0.5 border-t px-2 py-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={colPrefs.showDesc}
                onChange={() =>
                  saveColPrefs({ ...colPrefs, showDesc: !colPrefs.showDesc })
                }
                className="h-3.5 w-3.5 accent-primary"
              />
              Description line
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={colPrefs.groupByDay}
                onChange={() =>
                  saveColPrefs({ ...colPrefs, groupByDay: !colPrefs.groupByDay })
                }
                className="h-3.5 w-3.5 accent-primary"
              />
              Group by day
            </label>
          </div>
          <button
            type="button"
            onClick={() =>
              saveColPrefs({
                order: DEFAULT_COL_ORDER,
                hidden: DEFAULT_HIDDEN,
                showDesc: true,
                groupByDay: true,
              })
            }
            className="block w-full rounded border-t px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );

  const tabButton = (key: TabKey, label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setTab(key)}
      className={`relative px-2.5 pb-2.5 pt-1 text-sm transition-colors ${
        tab === key
          ? 'font-medium text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
        {count}
      </span>
    </button>
  );

  const toolbar = (
    <div className="mb-3 flex items-center gap-3 border-b">
      <div className="flex items-center">
        {tabButton('all', 'All', counts.all)}
        {tabButton('mine', 'Mine', counts.mine)}
        {tabButton('shared', 'Shared', counts.shared)}
      </div>
      <div className="ml-auto flex items-center gap-1.5 pb-2">
        {toolbarExtra}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings…"
            className="h-8 w-64 pl-8 pr-8"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            /
          </kbd>
        </div>
        {columnChooser}
        <Button
          onClick={() => void loadTranscripts()}
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>
    </div>
  );

  const emptyState = (
    icon: React.ReactNode,
    headline: string,
    sub: string | null
  ) => (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted">{icon}</div>
      <p className="mt-3 text-sm font-medium">{headline}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );

  const container = (children: React.ReactNode) => (
    <div className={`overflow-hidden rounded-lg border bg-card ${RESTING_SHADOW}`}>
      {children}
    </div>
  );

  if (loading) {
    return (
      <div>
        {toolbar}
        {container(
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {toolbar}
        {container(
          <div className="flex flex-col items-center py-16 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load transcripts</p>
            <p className="mt-1 text-xs text-destructive">{error}</p>
            <Button onClick={() => void loadTranscripts()} variant="outline" size="sm" className="mt-4">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  const searchEmpty = filtered.length === 0 && query.trim().length > 0;

  /** One listing row — shared by the flat list and the day-grouped view. */
  const renderRow = (t: TranscriptListRow) => {
    const { primary, secondary, untitled } = titleOf(t);
    const processing = t.status === 'processing' || t.status === 'queued';
    // Placeholder rows have a synthetic `up-…` id — there is no detail page
    // to open until the upload finishes and the row is promoted to its real
    // AAI id.
    const uploading = t.status === 'uploading';
    return (
      <TableRow
        key={t.id}
        onClick={() => {
          if (!uploading) router.push(`/transcript/${t.assemblyai_id}`);
        }}
        className={`group transition-colors hover:bg-accent/40 ${
          uploading ? 'cursor-default' : 'cursor-pointer'
        }`}
      >
        <TableCell className="py-2 pl-4">
          <div className="flex min-w-0 items-center gap-2">
            {statusDot(t.status)}
            {sourceIcon(t)}
            {calendarIcon(t)}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div
                  className={`min-w-0 truncate text-sm font-medium ${
                    untitled ? 'italic text-muted-foreground' : ''
                  } ${processing || uploading ? 'text-shimmer' : ''}`}
                >
                  {primary}
                </div>
                {!uploading && (
                  <SeriesBadge
                    assemblyaiId={t.assemblyai_id}
                    membership={
                      t.series_id && t.series_title
                        ? { series_id: t.series_id, title: t.series_title }
                        : null
                    }
                    defaultTitle={t.title}
                    onOpenSeries={setOpenSeriesId}
                    onChanged={() => void loadTranscripts({ silent: true })}
                  />
                )}
              </div>
              {uploading ? (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {uploadProgressLine(t)}
                </div>
              ) : processing ? (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  transcribing… — open it to share or link the calendar event
                </div>
              ) : (() => {
                const hit = query.trim() ? deepHits.get(t.assemblyai_id) : undefined;
                if (hit?.snippet && (hit.matched_in === 'notes' || hit.matched_in === 'content')) {
                  return (
                    <div className="truncate text-xs text-muted-foreground">
                      <span className="italic">…{hit.snippet.trim()}…</span>{' '}
                      <span className="text-[10px] uppercase tracking-wide">
                        in {hit.matched_in === 'notes' ? 'summary' : 'transcript'}
                      </span>
                    </div>
                  );
                }
                return secondary ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {secondary}
                  </div>
                ) : null;
              })()}
            </div>
            {t.status === 'error' && (
              <Badge
                variant="outline"
                className="shrink-0 border-destructive/40 text-[10px] text-destructive"
              >
                Failed
              </Badge>
            )}
          </div>
        </TableCell>
        {visibleCols.map((key) => (
          <TableCell key={key} className={`py-1.5 ${COL_RESPONSIVE[key]}`}>
            {renderColCell(key, t)}
          </TableCell>
        ))}
        <TableCell className="py-1.5 pr-3">
          <div className="flex items-center justify-end gap-0.5">
            {t.access === 'owner' && !uploading && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                onClick={(e) => handleDeleteTranscript(e, t.assemblyai_id)}
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            <span className="grid h-7 w-7 place-items-center">
              <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </span>
          </div>
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div>
      {toolbar}
      {container(
        filtered.length === 0 ? (
          searchEmpty ? (
            emptyState(
              <Search className="h-5 w-5 text-muted-foreground" />,
              deepSearching ? 'Searching transcripts…' : `No matches for "${query.trim()}"`,
              deepSearching
                ? null
                : 'Searched titles, filenames, descriptions, summaries, and full transcript text.'
            )
          ) : tab === 'shared' ? (
            emptyState(
              <Inbox className="h-5 w-5 text-muted-foreground" />,
              'Nothing shared with you yet',
              'Transcripts colleagues share will show up here.'
            )
          ) : tab === 'mine' ? (
            emptyState(
              <FileAudio className="h-5 w-5 text-muted-foreground" />,
              'You haven’t uploaded or imported anything yet',
              'Drag a file anywhere on this page, or use Upload audio in the header.'
            )
          ) : (
            emptyState(
              <FileAudio className="h-5 w-5 text-muted-foreground" />,
              'No transcripts yet',
              'Drag a file anywhere on this page, or use Upload audio in the header.'
            )
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Title
                </TableHead>
                {visibleCols.map((key) => (
                  <TableHead
                    key={key}
                    className={`h-9 ${COL_HEAD_WIDTH[key]} bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${COL_RESPONSIVE[key]}`}
                  >
                    {COL_LABELS[key]}
                  </TableHead>
                ))}
                <TableHead className="h-9 w-[72px] bg-muted/50">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dayGroups
                ? dayGroups.map((g) => (
                    <Fragment key={g.key}>
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={visibleCols.length + 2}
                          className="bg-muted/40 py-1.5 pl-4"
                        >
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                            {g.heading}
                          </span>
                          {g.sub && (
                            <span className="ml-1.5 text-[11px] text-muted-foreground/70">
                              {g.sub}
                            </span>
                          )}
                          <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
                            {g.rows.length} meeting{g.rows.length === 1 ? '' : 's'}
                            {g.totalSecs > 0 ? ` · ${formatDuration(g.totalSecs)}` : ''}
                          </span>
                        </TableCell>
                      </TableRow>
                      {g.rows.map(renderRow)}
                    </Fragment>
                  ))
                : filtered.map(renderRow)}
            </TableBody>
          </Table>
        )
      )}
      <SeriesDialog
        seriesId={openSeriesId}
        onClose={() => setOpenSeriesId(null)}
        onChanged={() => void loadTranscripts({ silent: true })}
      />
    </div>
  );
}
