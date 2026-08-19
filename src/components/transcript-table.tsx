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
  type TranscriptDayGroup,
  type TranscriptListV2Response,
} from '@/lib/format';
import { useLiveEvents } from '@/hooks/use-live-events';
import {
  RotateCcw,
  Trash2,
  RefreshCw,
  CalendarCheck2,
  CalendarX2,
  ChevronLeft,
  FileAudio,
  FileText,
  Search,
  ChevronRight,
  Inbox,
  Columns3,
  GripVertical,
  Video,
} from 'lucide-react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { SeriesBadge } from '@/components/series-badge';
import { SeriesDialog } from '@/components/series-dialog';
import {
  CalendarMeetingsTable,
  type CalendarDayGroup,
  type CalendarHeadedGroup,
  type CalendarMeetingsResponse,
} from '@/components/calendar-meeting-rows';

interface TranscriptTableProps {
  refreshTrigger?: number;
  /** Extra controls rendered in the toolbar row, left of the search box. */
  toolbarExtra?: React.ReactNode;
  /** Calendar-view rows' Import action — page.tsx wires this to the
   * existing gmeetFocus mechanism (focus + open GmeetImportDialog). */
  onImportMeeting?: (m: { meetingCode: string; eventStart: string }) => void;
}

type TabKey = 'all' | 'mine' | 'shared' | 'trash';

/** Which listing the table shows: transcript archive vs calendar views. */
type SourceView = 'archive' | 'unimported' | 'norec';

type RangePreset = 'all' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'month';

/** Listing v2 rows carry optional server-search matches. */
type ListRow = TranscriptListRow & {
  matched_in?: string | null;
  snippet?: string | null;
};

const RESTING_SHADOW = 'shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]';

/** Page-size knobs sent to the server (server caps: days 60, minRows 200). */
const PAGE_DAYS = 14;
const PAGE_MIN_ROWS = 40;

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

/** Local YYYY-MM-DD for a Date (the server interprets from/to in `tz`). */
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Server day keys are YYYY-MM-DD in the requested timezone — parse as a
 * local calendar date (never via the Date ISO parser, which assumes UTC). */
function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Inclusive from/to for a range preset, as local YYYY-MM-DD (weeks start
 * Monday). null = unbounded ("All time"). */
function computeRange(
  preset: RangePreset,
  picked: { y: number; m: number } | null
): { from: string | null; to: string | null } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOf = (d: Date) => {
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return mon;
  };
  switch (preset) {
    case 'all':
      return { from: null, to: null };
    case 'thisWeek': {
      const mon = mondayOf(today);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return { from: ymdLocal(mon), to: ymdLocal(sun) };
    }
    case 'lastWeek': {
      const mon = mondayOf(today);
      mon.setDate(mon.getDate() - 7);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return { from: ymdLocal(mon), to: ymdLocal(sun) };
    }
    case 'thisMonth':
      return {
        from: ymdLocal(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: ymdLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      };
    case 'lastMonth':
      return {
        from: ymdLocal(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: ymdLocal(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case 'month': {
      const y = picked?.y ?? now.getFullYear();
      const m = picked?.m ?? now.getMonth();
      return {
        from: ymdLocal(new Date(y, m, 1)),
        to: ymdLocal(new Date(y, m + 1, 0)),
      };
    }
  }
}

/** Heading for a day bucket: "Today" / "Yesterday" / "Tuesday" (this week,
 * with the short date as a muted suffix) / "Tue, 4 Aug" (this year) /
 * "4 Aug 2025". */
function dayHeading(d: Date): { label: string; sub: string | null } {
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

export function TranscriptTable({
  refreshTrigger,
  toolbarExtra,
  onImportMeeting,
}: TranscriptTableProps) {
  const router = useRouter();
  const [sourceView, setSourceView] = useState<SourceView>('archive');
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [openSeriesId, setOpenSeriesId] = useState<number | null>(null);

  // Date-range filter — shared by the archive and both calendar views.
  const [rangePreset, setRangePreset] = useState<RangePreset>('all');
  const [pickedMonth, setPickedMonth] = useState<{ y: number; m: number } | null>(null);
  const { from, to } = useMemo(
    () => computeRange(rangePreset, pickedMonth),
    [rangePreset, pickedMonth]
  );
  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    []
  );

  // ---- Archive (listing v2) state: server day groups + cursor + counts ----
  const [days, setDays] = useState<TranscriptDayGroup[]>([]);
  const [counts, setCounts] = useState<TranscriptListV2Response['counts'] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archiveGenRef = useRef(0);
  const daysRef = useRef<TranscriptDayGroup[]>([]);
  daysRef.current = days;
  const nextCursorRef = useRef<string | null>(null);
  nextCursorRef.current = nextCursor;

  // ---- Calendar views state (/api/calendar-meetings) ----
  const [calDays, setCalDays] = useState<CalendarDayGroup[]>([]);
  const [calCounts, setCalCounts] = useState<{ unimported: number; norec: number } | null>(
    null
  );
  const [calConnected, setCalConnected] = useState(true);
  const [calCursor, setCalCursor] = useState<string | null>(null);
  const [calHasMore, setCalHasMore] = useState(false);
  const [calLoading, setCalLoading] = useState(false);
  const [calLoadingMore, setCalLoadingMore] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  const calGenRef = useRef(0);
  const calDaysRef = useRef<CalendarDayGroup[]>([]);
  calDaysRef.current = calDays;
  const calCursorRef = useRef<string | null>(null);
  calCursorRef.current = calCursor;

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

  // Search debounce: server-side search kicks in at 2+ chars, 350ms.
  useEffect(() => {
    const q = query.trim();
    const effective = q.length >= 2 ? q : '';
    const timer = setTimeout(() => setDebouncedQ(effective), 350);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * Archive fetch. Modes:
   *  - reset:  filters changed / first load — replaces everything, shows the
   *    loading skeleton.
   *  - more:   infinite-scroll page — appends day groups after nextCursor.
   *  - silent: refetch the already-loaded window in ONE request (days =
   *    loaded groups, minRows = loaded rows, no cursor) and replace it,
   *    keeping scroll position; used by SSE / refresh / mutations.
   */
  const fetchArchive = useCallback(
    async (mode: 'reset' | 'more' | 'silent') => {
      const gen = mode === 'reset' ? ++archiveGenRef.current : archiveGenRef.current;
      const params = new URLSearchParams({ v: '2', tab, tz });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (debouncedQ) params.set('q', debouncedQ);
      if (mode === 'more') {
        if (!nextCursorRef.current) return;
        params.set('days', String(PAGE_DAYS));
        params.set('minRows', String(PAGE_MIN_ROWS));
        params.set('cursor', nextCursorRef.current);
      } else if (mode === 'silent') {
        const loadedDays = daysRef.current.length;
        const loadedRows = daysRef.current.reduce((n, g) => n + g.rows.length, 0);
        params.set('days', String(Math.min(loadedDays || PAGE_DAYS, 60)));
        params.set('minRows', String(Math.min(loadedRows || PAGE_MIN_ROWS, 200)));
      } else {
        params.set('days', String(PAGE_DAYS));
        params.set('minRows', String(PAGE_MIN_ROWS));
      }
      try {
        if (mode === 'reset') {
          setLoading(true);
          setError(null);
        }
        if (mode === 'more') setLoadingMore(true);
        const res = await fetch(`/api/transcripts?${params.toString()}`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`Failed to load transcripts (${res.status})`);
        const data = (await res.json()) as TranscriptListV2Response;
        if (gen !== archiveGenRef.current) return; // superseded by a newer reset
        setError(null);
        setCounts(data.counts);
        setNextCursor(data.nextCursor);
        setHasMore(data.hasMore);
        setDays((prev) => {
          if (mode !== 'more') return data.days;
          // Dedupe on append: a silent refetch racing a page load could
          // otherwise land the same day twice. Keep the previous reference
          // when nothing new arrived so downstream effects don't re-fire.
          const fresh = data.days.filter((d) => !prev.some((p) => p.key === d.key));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      } catch (err) {
        if (gen !== archiveGenRef.current) return;
        if (mode === 'reset') {
          setError(err instanceof Error ? err.message : 'Failed to load transcripts');
        }
        // more/silent failures are quiet — the loaded window stays usable
      } finally {
        if (gen === archiveGenRef.current && mode === 'reset') setLoading(false);
        if (mode === 'more') setLoadingMore(false);
      }
    },
    [tab, debouncedQ, from, to, tz]
  );

  /**
   * Calendar-meetings fetch. Modes as fetchArchive, plus:
   *  - counts: minimal request (days=1) just to keep the source-radio badge
   *    and `connected` fresh while the archive view is active.
   */
  const fetchCalendar = useCallback(
    async (mode: 'reset' | 'more' | 'silent' | 'counts') => {
      const gen = mode === 'reset' ? ++calGenRef.current : calGenRef.current;
      const view = sourceView === 'norec' ? 'norec' : 'unimported';
      const params = new URLSearchParams({ view, tz });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (mode === 'counts') {
        params.set('days', '1');
        params.set('minRows', '1');
      } else if (mode === 'more') {
        if (!calCursorRef.current) return;
        params.set('days', String(PAGE_DAYS));
        params.set('minRows', String(PAGE_MIN_ROWS));
        params.set('cursor', calCursorRef.current);
      } else if (mode === 'silent') {
        const loadedDays = calDaysRef.current.length;
        const loadedRows = calDaysRef.current.reduce((n, g) => n + g.rows.length, 0);
        params.set('days', String(Math.min(loadedDays || PAGE_DAYS, 60)));
        params.set('minRows', String(Math.min(loadedRows || PAGE_MIN_ROWS, 200)));
      } else {
        params.set('days', String(PAGE_DAYS));
        params.set('minRows', String(PAGE_MIN_ROWS));
      }
      try {
        if (mode === 'reset') {
          setCalLoading(true);
          setCalError(null);
        }
        if (mode === 'more') setCalLoadingMore(true);
        const res = await fetch(`/api/calendar-meetings?${params.toString()}`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`Failed to load calendar meetings (${res.status})`);
        const data = (await res.json()) as CalendarMeetingsResponse;
        if (gen !== calGenRef.current) return;
        setCalError(null);
        setCalCounts(data.counts);
        setCalConnected(data.connected);
        if (mode !== 'counts') {
          setCalCursor(data.nextCursor);
          setCalHasMore(data.hasMore);
          setCalDays((prev) => {
            if (mode !== 'more') return data.days;
            const fresh = data.days.filter((d) => !prev.some((p) => p.key === d.key));
            return fresh.length ? [...prev, ...fresh] : prev;
          });
        }
      } catch (err) {
        if (gen !== calGenRef.current) return;
        if (mode === 'reset') {
          setCalError(
            err instanceof Error ? err.message : 'Failed to load calendar meetings'
          );
        }
      } finally {
        if (gen === calGenRef.current && mode === 'reset') setCalLoading(false);
        if (mode === 'more') setCalLoadingMore(false);
      }
    },
    [sourceView, from, to, tz]
  );

  // Latest-fn refs so long-lived callbacks (SSE, observer, refreshTrigger)
  // always call the current filters without re-subscribing.
  const fetchArchiveRef = useRef(fetchArchive);
  fetchArchiveRef.current = fetchArchive;
  const fetchCalendarRef = useRef(fetchCalendar);
  fetchCalendarRef.current = fetchCalendar;
  const sourceViewRef = useRef(sourceView);
  sourceViewRef.current = sourceView;

  // Filters changed (tab / search / range) or first mount → reset the
  // archive listing. Pagination restarts from the top.
  useEffect(() => {
    void fetchArchive('reset');
  }, [fetchArchive]);

  // Calendar views load on entry + whenever the range changes while active.
  useEffect(() => {
    if (sourceView === 'archive') return;
    void fetchCalendar('reset');
  }, [fetchCalendar, sourceView]);

  // Keep the "Not imported (n)" radio badge fresh while in the archive.
  useEffect(() => {
    if (sourceView !== 'archive') return;
    void fetchCalendar('counts');
  }, [fetchCalendar, sourceView]);

  /** Silent refetch of everything currently on screen (+ radio counts). */
  const silentRefetchAll = useCallback(() => {
    void fetchArchiveRef.current('silent');
    void fetchCalendarRef.current(sourceViewRef.current === 'archive' ? 'counts' : 'silent');
  }, []);

  // Import dialogs closing / uploads created bump refreshTrigger — refetch
  // the loaded windows silently (an imported meeting must leave "Not
  // imported" immediately). Skip the initial mount (reset effect covers it).
  const refreshedOnceRef = useRef(false);
  useEffect(() => {
    if (!refreshedOnceRef.current) {
      refreshedOnceRef.current = true;
      return;
    }
    silentRefetchAll();
  }, [refreshTrigger, silentRefetchAll]);

  // Live updates: someone (including another tab or a colleague) changed a
  // transcript — silently refresh the loaded window. Debounced so bursts
  // (bulk imports) coalesce into one reload.
  const liveReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveEvents((e) => {
    if (!['created', 'deleted', 'meta', 'status', 'notes', 'shares'].includes(e.kind)) return;
    if (liveReloadTimer.current) clearTimeout(liveReloadTimer.current);
    liveReloadTimer.current = setTimeout(silentRefetchAll, 800);
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

  // Infinite scroll: a sentinel below the table loads the next page when it
  // approaches the viewport. Callback-ref so the observer follows the
  // sentinel through conditional renders.
  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (sourceView === 'archive') {
      if (hasMore && !loading && !loadingMore && !error) void fetchArchive('more');
    } else if (calHasMore && !calLoading && !calLoadingMore && !calError) {
      void fetchCalendar('more');
    }
  };
  const sentinelObserverRef = useRef<IntersectionObserver | null>(null);
  const sentinelVisibleRef = useRef(false);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    sentinelObserverRef.current?.disconnect();
    sentinelObserverRef.current = null;
    sentinelVisibleRef.current = false;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        sentinelVisibleRef.current = entries.some((entry) => entry.isIntersecting);
        if (sentinelVisibleRef.current) loadMoreRef.current();
      },
      { rootMargin: '300px' }
    );
    io.observe(node);
    sentinelObserverRef.current = io;
  }, []);
  useEffect(() => () => sentinelObserverRef.current?.disconnect(), []);
  // The observer only fires on intersection CHANGES — if the sentinel is
  // still inside the viewport after a page appends (short pages), kick the
  // next load explicitly.
  useEffect(() => {
    if (sentinelVisibleRef.current) loadMoreRef.current();
  }, [days, calDays]);

  /** Optimistic local removal (delete/restore) — the follow-up silent
   * refetch reconciles counts and day totals. */
  const removeRowLocally = useCallback((assemblyaiId: string) => {
    setDays((prev) =>
      prev
        .map((g) => {
          const removed = g.rows.find((r) => r.assemblyai_id === assemblyaiId);
          if (!removed) return g;
          return {
            ...g,
            rows: g.rows.filter((r) => r.assemblyai_id !== assemblyaiId),
            totalSecs: Math.max(0, (g.totalSecs ?? 0) - (removed.duration ?? 0)),
          };
        })
        .filter((g) => g.rows.length > 0)
    );
  }, []);

  /**
   * Delete semantics follow the row's state: a normal row moves to the
   * trash without confirmation (it's restorable from the Trash tab); a row
   * already in the trash is deleted forever (confirmed); a queued deferred
   * import is cancelled (confirmed — the server hard-deletes placeholders).
   */
  const handleDeleteTranscript = async (e: React.MouseEvent, t: ListRow) => {
    e.stopPropagation();
    const trashed = !!t.deleted_at;
    const queued = t.status === 'waiting';
    if (trashed && !confirm('Delete forever? This cannot be undone.')) return;
    if (queued && !confirm('Cancel this queued import?')) return;

    try {
      const res = await fetch(
        `/api/transcripts/${t.assemblyai_id}${trashed ? '?permanent=1' : ''}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(detail || `Delete failed (${res.status})`);
      }
      removeRowLocally(t.assemblyai_id);
      void fetchArchiveRef.current('silent');
    } catch (err) {
      alert('Failed to delete transcript: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleRestoreTranscript = async (e: React.MouseEvent, assemblyaiId: string) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/transcripts/${assemblyaiId}/restore`, { method: 'POST' });
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(detail || `Restore failed (${res.status})`);
      }
      removeRowLocally(assemblyaiId);
      void fetchArchiveRef.current('silent');
    } catch (err) {
      alert('Failed to restore transcript: ' + (err instanceof Error ? err.message : 'Unknown error'));
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
      case 'waiting':
        // Deferred import — queued until Google finishes preparing the files.
        return (
          <span
            className={`${base} bg-amber-500 animate-pulse`}
            aria-label="Waiting for Google"
          />
        );
      case 'queued':
        return <span className={`${base} bg-muted-foreground/40`} aria-label="Queued" />;
      case 'error':
        return <span className={`${base} bg-status-err`} aria-label="Error" />;
      default:
        return <span className={`${base} bg-muted-foreground/40`} aria-label={status} />;
    }
  };

  const sourceIcon = (t: ListRow) => {
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
  const calendarIcon = (t: ListRow) =>
    t.has_event ? (
      <span title="Linked to a calendar event" className="shrink-0">
        <CalendarCheck2 className="h-3.5 w-3.5 text-status-ok/70" />
      </span>
    ) : (
      <span title="No calendar event linked" className="shrink-0">
        <CalendarX2 className="h-3.5 w-3.5 text-muted-foreground/40" />
      </span>
    );

  const ownerCell = (t: ListRow) => {
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
  const uploadProgressLine = (t: ListRow): string => {
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
    t: ListRow
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

  const renderColCell = (key: ColKey, t: ListRow) => {
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

  const tabButton = (key: TabKey, label: string, count?: number) => (
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
      {count !== undefined && (
        <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
          {count}
        </span>
      )}
    </button>
  );

  const sourceRadioButton = (key: SourceView, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setSourceView(key)}
      aria-pressed={sourceView === key}
      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
        sourceView === key
          ? 'bg-background font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );

  const monthLabel = useMemo(() => {
    const now = new Date();
    const y = pickedMonth?.y ?? now.getFullYear();
    const m = pickedMonth?.m ?? now.getMonth();
    return new Date(y, m, 1).toLocaleDateString([], { month: 'short', year: 'numeric' });
  }, [pickedMonth]);

  const stepMonth = (delta: number) => {
    const now = new Date();
    const y = pickedMonth?.y ?? now.getFullYear();
    const m = pickedMonth?.m ?? now.getMonth();
    const next = new Date(y, m + delta, 1);
    setPickedMonth({ y: next.getFullYear(), m: next.getMonth() });
  };

  const rangePicker = (
    <div className="flex items-center gap-1">
      <select
        value={rangePreset}
        onChange={(e) => {
          const preset = e.target.value as RangePreset;
          setRangePreset(preset);
          if (preset === 'month' && !pickedMonth) {
            const now = new Date();
            setPickedMonth({ y: now.getFullYear(), m: now.getMonth() });
          }
        }}
        title="Date range"
        className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="all">All time</option>
        <option value="thisWeek">This week</option>
        <option value="lastWeek">Last week</option>
        <option value="thisMonth">This month</option>
        <option value="lastMonth">Last month</option>
        <option value="month">Pick month…</option>
      </select>
      {rangePreset === 'month' && (
        <div className="flex h-8 items-center gap-0.5 rounded-md border border-input bg-background px-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            title="Previous month"
            onClick={() => stepMonth(-1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span className="sr-only">Previous month</span>
          </Button>
          <span className="w-[72px] text-center text-xs tabular-nums">{monthLabel}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            title="Next month"
            onClick={() => stepMonth(1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="sr-only">Next month</span>
          </Button>
        </div>
      )}
    </div>
  );

  const manualRefresh = () => {
    if (sourceView === 'archive') {
      void fetchArchive('silent');
      void fetchCalendar('counts');
    } else {
      void fetchCalendar('silent');
    }
  };

  const toolbar = (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b">
      <div className="mb-2 mt-0.5 flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5">
        {sourceRadioButton('archive', 'Archive')}
        {sourceRadioButton(
          'unimported',
          `Not imported${calCounts ? ` (${calCounts.unimported})` : ''}`
        )}
        {sourceRadioButton('norec', 'No recording')}
      </div>
      {sourceView === 'archive' && (
        <div className="flex items-center">
          {tabButton('all', 'All', counts?.all)}
          {tabButton('mine', 'Mine', counts?.mine)}
          {tabButton('shared', 'Shared', counts?.shared)}
          {tabButton('trash', 'Trash', counts?.trash)}
        </div>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1.5 pb-2">
        {toolbarExtra}
        {rangePicker}
        {sourceView === 'archive' && (
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
        )}
        {sourceView === 'archive' && columnChooser}
        <Button
          onClick={manualRefresh}
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

  const spinner = (
    <div className="flex items-center justify-center py-16 text-muted-foreground">
      <RefreshCw className="h-5 w-5 animate-spin" />
    </div>
  );

  /** One listing row — shared by the flat list and the day-grouped view. */
  const renderRow = (t: ListRow) => {
    const { primary, secondary, untitled } = titleOf(t);
    const processing = t.status === 'processing' || t.status === 'queued';
    // Placeholder rows have a synthetic `up-…` / `defer-…` id — there is no
    // detail page to open until the upload/deferred import finishes and the
    // row is promoted to (or replaced by) its real id. Failed deferred rows
    // keep the `defer-…` id, so key off the id, not only the status.
    const uploading = t.status === 'uploading';
    const waiting = t.status === 'waiting';
    const placeholder = uploading || t.assemblyai_id.startsWith('defer-');
    const trashed = !!t.deleted_at;
    return (
      <TableRow
        key={t.id}
        onClick={() => {
          if (!placeholder) router.push(`/transcript/${t.assemblyai_id}`);
        }}
        className={`group transition-colors hover:bg-accent/40 ${
          placeholder ? 'cursor-default' : 'cursor-pointer'
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
                  } ${processing || uploading || waiting ? 'text-shimmer' : ''}`}
                >
                  {primary}
                </div>
                {!uploading && !waiting && !trashed && (
                  <SeriesBadge
                    assemblyaiId={t.assemblyai_id}
                    membership={
                      t.series_id && t.series_title
                        ? { series_id: t.series_id, title: t.series_title }
                        : null
                    }
                    suspected={
                      t.suspected_series_id && t.suspected_series_title
                        ? { series_id: t.suspected_series_id, title: t.suspected_series_title }
                        : null
                    }
                    defaultTitle={t.title}
                    onOpenSeries={setOpenSeriesId}
                    onChanged={() => void fetchArchiveRef.current('silent')}
                  />
                )}
              </div>
              {trashed ? (
                <div className="truncate text-xs text-muted-foreground">
                  deleted {new Date(t.deleted_at!).toLocaleString()} — restore, or delete
                  forever
                </div>
              ) : uploading ? (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {uploadProgressLine(t)}
                </div>
              ) : waiting ? (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {`import queued — Google is still preparing the ${
                    t.deferred_mode === 'video'
                      ? 'video file'
                      : t.deferred_mode === 'both'
                        ? 'video + transcript'
                        : 'transcript Doc'
                  }; runs automatically (checked every minute)`}
                </div>
              ) : t.status === 'error' && t.deferred_error ? (
                <div className="truncate text-xs text-destructive/80">{t.deferred_error}</div>
              ) : processing ? (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  transcribing… — open it to share or link the calendar event
                </div>
              ) : (() => {
                // Server-side search matches ride on the row itself in v2.
                const matchedIn = debouncedQ ? t.matched_in : undefined;
                if (
                  t.snippet &&
                  (matchedIn === 'notes' || matchedIn === 'content')
                ) {
                  return (
                    <div className="truncate text-xs text-muted-foreground">
                      <span className="italic">…{t.snippet.trim()}…</span>{' '}
                      <span className="text-[10px] uppercase tracking-wide">
                        in {matchedIn === 'notes' ? 'summary' : 'transcript'}
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
            {trashed && t.access === 'owner' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                onClick={(e) => handleRestoreTranscript(e, t.assemblyai_id)}
                title="Restore"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            {t.access === 'owner' && !uploading && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                onClick={(e) => handleDeleteTranscript(e, t)}
                title={trashed ? 'Delete forever' : waiting ? 'Cancel queued import' : 'Move to trash'}
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

  // Day groups with pre-computed headings (server guarantees day ordering —
  // pages append whole days, never splitting one across pages).
  const archiveGroups = useMemo(
    () =>
      days.map((g) => {
        const { label, sub } = dayHeading(parseDayKey(g.key));
        return { ...g, heading: label, sub };
      }),
    [days]
  );
  const flatRows = useMemo(() => days.flatMap((g) => g.rows as ListRow[]), [days]);
  const calGroups = useMemo<CalendarHeadedGroup[]>(
    () =>
      calDays.map((g) => {
        const { label, sub } = dayHeading(parseDayKey(g.key));
        return { ...g, heading: label, sub };
      }),
    [calDays]
  );

  const rowCount = flatRows.length;
  const searchEmpty = rowCount === 0 && debouncedQ.length > 0;

  const archiveBody = loading ? (
    container(spinner)
  ) : error ? (
    container(
      <div className="flex flex-col items-center py-16 text-center">
        <p className="text-sm font-medium">Couldn&apos;t load transcripts</p>
        <p className="mt-1 text-xs text-destructive">{error}</p>
        <Button
          onClick={() => void fetchArchive('reset')}
          variant="outline"
          size="sm"
          className="mt-4"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  ) : (
    container(
      rowCount === 0 ? (
        searchEmpty ? (
          emptyState(
            <Search className="h-5 w-5 text-muted-foreground" />,
            `No matches for "${debouncedQ}"`,
            'Searched titles, filenames, descriptions, summaries, and full transcript text.'
          )
        ) : tab === 'trash' ? (
          emptyState(
            <Trash2 className="h-5 w-5 text-muted-foreground" />,
            'Trash is empty',
            'Deleted transcripts land here and can be restored or removed forever.'
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
            {colPrefs.groupByDay
              ? archiveGroups.map((g) => (
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
                    {(g.rows as ListRow[]).map(renderRow)}
                  </Fragment>
                ))
              : flatRows.map(renderRow)}
          </TableBody>
        </Table>
      )
    )
  );

  const calView = sourceView === 'norec' ? 'norec' : 'unimported';
  const calendarBody = calLoading ? (
    container(spinner)
  ) : calError ? (
    container(
      <div className="flex flex-col items-center py-16 text-center">
        <p className="text-sm font-medium">Couldn&apos;t load calendar meetings</p>
        <p className="mt-1 text-xs text-destructive">{calError}</p>
        <Button
          onClick={() => void fetchCalendar('reset')}
          variant="outline"
          size="sm"
          className="mt-4"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  ) : !calConnected ? (
    container(
      emptyState(
        <Video className="h-5 w-5 text-muted-foreground" />,
        'Connect Google to see your calendar here',
        'Use "Import meeting" in the header to connect your Google account.'
      )
    )
  ) : calGroups.length === 0 ? (
    container(
      calView === 'unimported'
        ? emptyState(
            <Video className="h-5 w-5 text-muted-foreground" />,
            'Everything with a recording is already imported 🎉',
            null
          )
        : emptyState(
            <CalendarX2 className="h-5 w-5 text-muted-foreground" />,
            'No unrecorded meetings found in this range',
            'Data accumulates from calendar sweeps going forward.'
          )
    )
  ) : (
    container(
      <CalendarMeetingsTable
        view={calView}
        groups={calGroups}
        onImportMeeting={onImportMeeting}
      />
    )
  );

  const showSentinel =
    sourceView === 'archive'
      ? !loading && !error && hasMore
      : !calLoading && !calError && calConnected && calHasMore;
  const showLoadingMore = sourceView === 'archive' ? loadingMore : calLoadingMore;

  return (
    <div>
      {toolbar}
      {sourceView === 'archive' ? archiveBody : calendarBody}
      {showSentinel && <div ref={sentinelRef} className="h-1" aria-hidden />}
      {showLoadingMore && (
        <div className="flex items-center justify-center py-3 text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" />
        </div>
      )}
      <SeriesDialog
        seriesId={openSeriesId}
        onClose={() => setOpenSeriesId(null)}
        onChanged={() => void fetchArchiveRef.current('silent')}
      />
    </div>
  );
}
