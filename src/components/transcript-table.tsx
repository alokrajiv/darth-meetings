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
  formatAgo,
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
  EyeOff,
  FileAudio,
  FileText,
  Filter,
  Search,
  ChevronRight,
  Inbox,
  Columns3,
  Film,
  GripVertical,
  Video,
  X,
} from 'lucide-react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { LayersDropdown } from '@/components/layers-dropdown';
import { SeriesBadge } from '@/components/series-badge';
import { SeriesDialog } from '@/components/series-dialog';
import { LabelChips } from '@/components/label-chips';
import { LabelPicker, anchorFromElement, parseError, type PickerAnchor } from '@/components/label-picker';
import { BulkLabelBar } from '@/components/bulk-label-bar';
import { refreshLabelCatalog } from '@/hooks/use-label-catalog';
import { labelFilterToParams, type LabelFilter } from '@/lib/labels';
import type { LabelRef } from '@/lib/format';
import {
  PeopleFilterChips,
  PeopleFilterControl,
  EMPTY_PEOPLE_FILTERS,
  appendPeopleFilterParams,
  hasPeopleFilters,
  peopleFiltersKey,
  readPeopleFiltersFromUrl,
  writePeopleFiltersToUrl,
  type PeopleFilters,
} from '@/components/people-filter';
import {
  CalendarEventRow,
  type CalendarDayGroup,
  type CalendarLayer,
  type CalendarMeetingRow,
  type CalendarMeetingsResponse,
} from '@/components/calendar-meeting-rows';
import type {
  CalendarMuteEntry,
  CalendarMutesResponse,
} from '@/app/api/calendar-mutes/route';

interface TranscriptTableProps {
  refreshTrigger?: number;
  /** Extra controls rendered in the toolbar row, left of the search box. */
  toolbarExtra?: React.ReactNode;
  /** Calendar-view rows' Import action — page.tsx wires this to the
   * existing gmeetFocus mechanism (focus + open GmeetImportDialog). */
  onImportMeeting?: (m: { meetingCode: string; eventStart: string }) => void;
  /** Label filter (`?label=<id|none>&exact=1`), owned by page.tsx together
   * with the rail (docs/labels-design.md §4). null = no filter. */
  labelFilter?: LabelFilter | null;
  /** False until the page has read `?label=` from the URL — gates the first
   * fetch so a filtered link doesn't fire an unfiltered request first. */
  labelFilterReady?: boolean;
  /** Row chips / picker set the filter through this (the page writes the URL). */
  onLabelFilter?: (f: LabelFilter | null) => void;
}

type TabKey = 'all' | 'mine' | 'shared' | 'trash';

/**
 * The merged timeline's multi-select layers. 'archive' = imported rows
 * (listing v2); the other two are the calendar-backed views. All on by
 * default — unticking a chip hides that layer's rows.
 */
type LayerKey = 'archive' | CalendarLayer;

interface LayerPrefs {
  archive: boolean;
  unimported: boolean;
  norec: boolean;
}

const DEFAULT_LAYERS: LayerPrefs = { archive: true, unimported: true, norec: true };
const LAYERS_STORAGE_KEY = 'mw:layers:v1';
const CAL_VIEWS = ['unimported', 'norec'] as const;

function loadLayerPrefs(): LayerPrefs {
  try {
    const raw = localStorage.getItem(LAYERS_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYERS;
    const parsed = JSON.parse(raw) as Partial<LayerPrefs>;
    const next: LayerPrefs = {
      archive: parsed.archive !== false,
      unimported: parsed.unimported !== false,
      norec: parsed.norec !== false,
    };
    // At least one layer must stay on — a corrupt all-off set resets.
    if (!next.archive && !next.unimported && !next.norec) return DEFAULT_LAYERS;
    return next;
  } catch {
    return DEFAULT_LAYERS;
  }
}

/** Per-source paging state for the two calendar layers. `loaded` = the
 * first page for the CURRENT filters landed (merge-blocking until then). */
interface CalSourceState {
  days: CalendarDayGroup[];
  cursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

const EMPTY_CAL_SOURCE: CalSourceState = {
  days: [],
  cursor: null,
  hasMore: false,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: null,
};

type RangePreset = 'all' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'month';

/** Listing v2 rows carry optional server-search matches. */
type ListRow = TranscriptListRow & {
  matched_in?: string | null;
  snippet?: string | null;
};

/** One row of a merged day group, tagged with its source layer. */
type MergedItem =
  | { at: number; kind: 'archive'; row: ListRow }
  | { at: number; kind: 'cal'; layer: CalendarLayer; row: CalendarMeetingRow };

interface MergedGroup {
  key: string;
  heading: string;
  sub: string | null;
  items: MergedItem[];
  totalSecs: number;
}

const RESTING_SHADOW = 'shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]';

/** Page-size knobs sent to the server (server caps: days 60, minRows 200). */
const PAGE_DAYS = 14;
const PAGE_MIN_ROWS = 40;

/**
 * Configurable middle columns (Title is locked first, actions locked last).
 * Users pick visibility + order via the toolbar chooser; persisted in
 * localStorage under COLS_STORAGE_KEY.
 */
type ColKey = 'labels' | 'owner' | 'date' | 'duration' | 'speakers' | 'language' | 'imported';

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
  'labels',
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
  labels: 'Labels',
  owner: 'Owner',
  date: 'Date',
  duration: 'Duration',
  speakers: 'Speakers',
  language: 'Language',
  imported: 'Imported',
};

/** Width + responsive visibility per column (applied to head & cells). */
const COL_HEAD_WIDTH: Record<ColKey, string> = {
  labels: 'w-[14%]',
  owner: 'w-[16%]',
  date: 'w-[14%]',
  duration: 'w-[11%]',
  speakers: 'w-[9%]',
  language: 'w-[9%]',
  imported: 'w-[12%]',
};
const COL_RESPONSIVE: Record<ColKey, string> = {
  labels: 'hidden md:table-cell',
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

/** Label assignment mirrors share management: owner or edit share. */
const canEditRow = (t: ListRow) => t.access === 'owner' || t.access === 'edit';

export function TranscriptTable({
  refreshTrigger,
  toolbarExtra,
  onImportMeeting,
  labelFilter = null,
  labelFilterReady = true,
  onLabelFilter,
}: TranscriptTableProps) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [openSeriesId, setOpenSeriesId] = useState<number | null>(null);

  // Layer chips (multi-select, all on by default). Loaded client-side to
  // avoid SSR localStorage access; `layersLoaded` gates the lazy calendar
  // fetches so a stored "off" layer isn't fetched on first paint.
  const [layers, setLayers] = useState<LayerPrefs>(DEFAULT_LAYERS);
  const [layersLoaded, setLayersLoaded] = useState(false);
  useEffect(() => {
    setLayers(loadLayerPrefs());
    setLayersLoaded(true);
  }, []);
  const toggleLayer = useCallback((key: LayerKey) => {
    setLayers((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // At least one layer must stay on.
      if (!next.archive && !next.unimported && !next.norec) return prev;
      try {
        localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage full/blocked — prefs just won't persist
      }
      return next;
    });
  }, []);

  // Tabs (Mine/Shared/Trash) and search are ARCHIVE-ONLY concepts — while
  // either is active the calendar layers hide entirely and the table
  // behaves like the plain archive view.
  // A label filter is archive-only too: labels live on transcripts (v1 —
  // calendar rows carry none), so the calendar layers hide while it's set.
  const mergedMode = tab === 'all' && debouncedQ.length === 0 && !labelFilter;
  const renderMerged = mergedMode && (layers.unimported || layers.norec);

  // Date-range filter — shared by the archive and both calendar layers.
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

  // People / organizer / provider filters — shared by the archive and both
  // calendar layers (the server applies them to rows AND counts). The URL
  // (?participant=&organizer=&provider=) is the source of truth on load so
  // a filtered view is a shareable link; every change is written back with
  // history.replaceState. `peopleLoaded` gates the first fetches so a
  // filtered link doesn't fire an unfiltered request first.
  const [peopleFilters, setPeopleFiltersState] = useState<PeopleFilters>(EMPTY_PEOPLE_FILTERS);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  useEffect(() => {
    setPeopleFiltersState(readPeopleFiltersFromUrl(window.location.search));
    setPeopleLoaded(true);
  }, []);
  // Only swap the object on a real change — its identity is what the fetch
  // callbacks key on, so a no-op "Apply" must not refetch.
  const setPeopleFilters = useCallback((next: PeopleFilters) => {
    setPeopleFiltersState((prev) =>
      peopleFiltersKey(prev) === peopleFiltersKey(next) ? prev : next
    );
    writePeopleFiltersToUrl(next);
  }, []);
  // Back/forward between two filtered URLs: re-read the params.
  useEffect(() => {
    const onPop = () => setPeopleFiltersState(readPeopleFiltersFromUrl(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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

  // ---- Calendar layers state (/api/calendar-meetings, one per view) ----
  const [calSrc, setCalSrc] = useState<Record<CalendarLayer, CalSourceState>>({
    unimported: EMPTY_CAL_SOURCE,
    norec: EMPTY_CAL_SOURCE,
  });
  const [calCounts, setCalCounts] = useState<{ unimported: number; norec: number } | null>(
    null
  );
  const [calConnected, setCalConnected] = useState(true);
  /** First-sweep progress after connecting Google — drives the "still
   * syncing, events may be missing" banner. */
  const [calSync, setCalSync] = useState<CalendarMeetingsResponse['sync'] | null>(null);
  const calGenRef = useRef<Record<CalendarLayer, number>>({ unimported: 0, norec: 0 });
  const calSrcRef = useRef(calSrc);
  calSrcRef.current = calSrc;

  // ---- Calendar-event mutes (hidden rows) — /api/calendar-mutes ----
  // Fetched once on mount (drives the "Hidden (n)" count), refreshed on
  // popover open and after every add/remove.
  const [mutes, setMutes] = useState<CalendarMuteEntry[]>([]);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const hiddenMenuRef = useRef<HTMLDivElement | null>(null);
  const fetchMutes = useCallback(async () => {
    try {
      const res = await fetch('/api/calendar-mutes', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as CalendarMutesResponse;
      setMutes(data.mutes);
    } catch {
      // quiet — the hidden list just stays stale
    }
  }, []);
  useEffect(() => {
    void fetchMutes();
  }, [fetchMutes]);
  useEffect(() => {
    if (!hiddenOpen) return;
    const onDown = (e: MouseEvent) => {
      if (hiddenMenuRef.current && !hiddenMenuRef.current.contains(e.target as Node)) {
        setHiddenOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [hiddenOpen]);

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
      appendPeopleFilterParams(params, peopleFilters);
      for (const [k, v] of Object.entries(labelFilterToParams(labelFilter))) params.set(k, v);
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
    [tab, debouncedQ, from, to, tz, peopleFilters, labelFilter]
  );

  /**
   * Calendar-layer fetch (one paged source per view). Modes as fetchArchive.
   * Every response also refreshes the chip badge counts + `connected`.
   */
  const fetchCalendar = useCallback(
    async (view: CalendarLayer, mode: 'reset' | 'more' | 'silent') => {
      const gen = mode === 'reset' ? ++calGenRef.current[view] : calGenRef.current[view];
      const src = calSrcRef.current[view];
      const params = new URLSearchParams({ view, tz });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      appendPeopleFilterParams(params, peopleFilters);
      if (mode === 'more') {
        if (!src.cursor) return;
        params.set('days', String(PAGE_DAYS));
        params.set('minRows', String(PAGE_MIN_ROWS));
        params.set('cursor', src.cursor);
      } else if (mode === 'silent') {
        const loadedDays = src.days.length;
        const loadedRows = src.days.reduce((n, g) => n + g.rows.length, 0);
        params.set('days', String(Math.min(loadedDays || PAGE_DAYS, 60)));
        params.set('minRows', String(Math.min(loadedRows || PAGE_MIN_ROWS, 200)));
      } else {
        params.set('days', String(PAGE_DAYS));
        params.set('minRows', String(PAGE_MIN_ROWS));
      }
      const patch = (p: Partial<CalSourceState>) =>
        setCalSrc((prev) => ({ ...prev, [view]: { ...prev[view], ...p } }));
      if (mode === 'reset') {
        // Mark loading in the ref synchronously too, so the lazy-load
        // effect can't double-fire a reset within the same commit.
        calSrcRef.current = {
          ...calSrcRef.current,
          [view]: { ...src, loading: true },
        };
        patch({ loading: true, error: null });
      }
      if (mode === 'more') patch({ loadingMore: true });
      try {
        const res = await fetch(`/api/calendar-meetings?${params.toString()}`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`Failed to load calendar meetings (${res.status})`);
        const data = (await res.json()) as CalendarMeetingsResponse;
        if (gen !== calGenRef.current[view]) return; // superseded by a newer reset
        setCalCounts(data.counts);
        setCalConnected(data.connected);
        setCalSync(data.sync ?? null);
        setCalSrc((prev) => {
          const cur = prev[view];
          let nextDays = data.days;
          if (mode === 'more') {
            const fresh = data.days.filter((d) => !cur.days.some((p) => p.key === d.key));
            nextDays = fresh.length ? [...cur.days, ...fresh] : cur.days;
          }
          return {
            ...prev,
            [view]: {
              days: nextDays,
              cursor: data.nextCursor,
              hasMore: data.hasMore,
              loaded: true,
              loading: false,
              loadingMore: false,
              error: null,
            },
          };
        });
      } catch (err) {
        if (gen !== calGenRef.current[view]) return;
        if (mode === 'reset') {
          patch({
            loading: false,
            error:
              err instanceof Error ? err.message : 'Failed to load calendar meetings',
          });
        } else if (mode === 'more') {
          patch({ loadingMore: false });
        }
        // silent failures are quiet — the loaded window stays usable
      }
    },
    [from, to, tz, peopleFilters]
  );

  /** Minimal request just to keep the "Not imported (n)" chip badge and
   * `connected` fresh while the full unimported layer isn't being fetched. */
  const fetchCalCounts = useCallback(async () => {
    const params = new URLSearchParams({
      view: 'unimported',
      tz,
      days: '1',
      minRows: '1',
    });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    appendPeopleFilterParams(params, peopleFilters);
    try {
      const res = await fetch(`/api/calendar-meetings?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = (await res.json()) as CalendarMeetingsResponse;
      setCalCounts(data.counts);
      setCalConnected(data.connected);
      setCalSync(data.sync ?? null);
    } catch {
      // quiet — badge just stays stale
    }
  }, [from, to, tz, peopleFilters]);

  // Latest-fn refs so long-lived callbacks (SSE, observer, refreshTrigger)
  // always call the current filters without re-subscribing.
  const fetchArchiveRef = useRef(fetchArchive);
  fetchArchiveRef.current = fetchArchive;
  const fetchCalendarRef = useRef(fetchCalendar);
  fetchCalendarRef.current = fetchCalendar;
  const fetchCalCountsRef = useRef(fetchCalCounts);
  fetchCalCountsRef.current = fetchCalCounts;
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const mergedModeRef = useRef(mergedMode);
  mergedModeRef.current = mergedMode;

  // Filters changed (tab / search / range) or first mount → reset the
  // archive listing. Pagination restarts from the top.
  useEffect(() => {
    if (!peopleLoaded || !labelFilterReady) return;
    void fetchArchive('reset');
  }, [fetchArchive, peopleLoaded, labelFilterReady]);

  // Range/tz changed → the calendar windows are stale. Drop them (bumping
  // gens so in-flight responses discard) and let the lazy loader below
  // refetch whichever layers are enabled.
  useEffect(() => {
    calGenRef.current.unimported++;
    calGenRef.current.norec++;
    setCalSrc({ unimported: EMPTY_CAL_SOURCE, norec: EMPTY_CAL_SOURCE });
  }, [from, to, tz, peopleFilters]);

  // Lazy layer loading: an enabled-but-never-fetched calendar layer fetches
  // on entry to merged mode / on toggle-on / after a filter reset. Toggling
  // OFF hides rows but keeps the data. Errors don't auto-retry (the error
  // strip has an explicit Retry).
  useEffect(() => {
    if (!layersLoaded || !peopleLoaded || !mergedMode) return;
    for (const v of CAL_VIEWS) {
      if (!layers[v]) continue;
      const s = calSrcRef.current[v];
      if (!s.loaded && !s.loading && !s.error) void fetchCalendar(v, 'reset');
    }
  }, [fetchCalendar, layers, layersLoaded, peopleLoaded, mergedMode, calSrc]);

  // Keep the "Not imported (n)" chip badge fresh when the full unimported
  // layer isn't being fetched (layer off, or archive-only mode).
  useEffect(() => {
    if (!layersLoaded || !peopleLoaded) return;
    if (mergedMode && layers.unimported) return; // full fetch carries counts
    void fetchCalCounts();
  }, [fetchCalCounts, layersLoaded, peopleLoaded, mergedMode, layers.unimported]);

  /** Silent refetch of everything currently on screen (+ chip counts). */
  const silentRefetchAll = useCallback(() => {
    void fetchArchiveRef.current('silent');
    let didCal = false;
    if (mergedModeRef.current) {
      for (const v of CAL_VIEWS) {
        if (layersRef.current[v] && calSrcRef.current[v].loaded) {
          didCal = true;
          void fetchCalendarRef.current(v, 'silent');
        }
      }
    }
    if (!didCal) void fetchCalCountsRef.current();
  }, []);

  /** Silent refetch of just the calendar layers (+ chip counts) — used
   * after a mute add/remove: hidden rows must leave/re-enter the timeline
   * immediately, but the archive layer is unaffected. */
  const silentRefetchCalendars = useCallback(() => {
    let didCal = false;
    if (mergedModeRef.current) {
      for (const v of CAL_VIEWS) {
        if (layersRef.current[v] && calSrcRef.current[v].loaded) {
          didCal = true;
          void fetchCalendarRef.current(v, 'silent');
        }
      }
    }
    if (!didCal) void fetchCalCountsRef.current();
  }, []);

  // "Sync now": run one poller sweep for the caller (server-side, same code
  // path and cache writes as the 30-minute background tick), then refetch the
  // calendar layers. The `lastPollAt` chip is the freshness indicator for
  // everything the calendar layers show.
  const [manualSyncing, setManualSyncing] = useState(false);
  const runManualCalSync = useCallback(async () => {
    if (manualSyncing) return;
    setManualSyncing(true);
    try {
      const res = await fetch('/api/calendar/sync', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as { lastPollAt: string | null };
        setCalSync((prev) =>
          prev
            ? { ...prev, lastPollAt: data.lastPollAt ?? prev.lastPollAt, syncing: false }
            : prev
        );
      }
      silentRefetchCalendars();
    } catch {
      // transient — the chip simply keeps the old timestamp
    } finally {
      setManualSyncing(false);
    }
  }, [manualSyncing, silentRefetchCalendars]);

  /** A hide was confirmed from a calendar row's popover. */
  const handleMuteChanged = useCallback(() => {
    void fetchMutes();
    silentRefetchCalendars();
  }, [fetchMutes, silentRefetchCalendars]);

  // While the first post-connect sweep runs, poll its progress so the
  // syncing banner clears itself — and refetch the calendar layers the
  // moment it completes, so the "missing" events appear without a manual
  // refresh.
  const wasSyncingRef = useRef(false);
  useEffect(() => {
    const syncing = !!calSync?.syncing;
    if (wasSyncingRef.current && !syncing) {
      silentRefetchCalendars();
    }
    wasSyncingRef.current = syncing;
    if (!syncing || !mergedMode) return;
    const t = setInterval(() => void fetchCalCountsRef.current(), 15_000);
    return () => clearInterval(t);
  }, [calSync?.syncing, mergedMode, silentRefetchCalendars]);

  const handleUnmute = useCallback(
    async (m: CalendarMuteEntry) => {
      try {
        const res = await fetch(
          `/api/calendar-mutes?kind=${encodeURIComponent(m.kind)}&value=${encodeURIComponent(m.value)}`,
          { method: 'DELETE', credentials: 'include' }
        );
        if (!res.ok) return;
        setMutes((prev) =>
          prev.filter((x) => !(x.kind === m.kind && x.value === m.value))
        );
        silentRefetchCalendars();
      } catch {
        // quiet — the entry stays listed, retry works
      }
    },
    [silentRefetchCalendars]
  );

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
  // 'labels' events (taxonomy or assignment changes; a bulk tag emits one per
  // row) also refresh the shared label catalog — on the same 800ms debounce,
  // so a burst costs one /api/labels?counts=1, not one per event. The rail
  // has no SSE of its own; it re-renders through the catalog store.
  const labelsDirtyRef = useRef(false);
  useLiveEvents((e) => {
    if (!['created', 'deleted', 'meta', 'status', 'notes', 'shares', 'labels'].includes(e.kind)) return;
    if (e.kind === 'labels') labelsDirtyRef.current = true;
    if (liveReloadTimer.current) clearTimeout(liveReloadTimer.current);
    liveReloadTimer.current = setTimeout(() => {
      if (labelsDirtyRef.current) {
        labelsDirtyRef.current = false;
        void refreshLabelCatalog();
      }
      silentRefetchAll();
    }, 800);
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

  // Infinite scroll: a sentinel below the table loads the next page from
  // EVERY enabled source that still has more (each with its own cursor).
  // Callback-ref so the observer follows the sentinel through conditional
  // renders.
  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (!renderMerged || layers.archive) {
      if (hasMore && !loading && !loadingMore && !error) void fetchArchive('more');
    }
    if (renderMerged) {
      for (const v of CAL_VIEWS) {
        const s = calSrc[v];
        if (layers[v] && s.loaded && s.hasMore && !s.loading && !s.loadingMore && !s.error) {
          void fetchCalendar(v, 'more');
        }
      }
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
  }, [days, calSrc]);

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

  // ---- Labels: row picker, multi-select + bulk bar (docs/labels-design.md §4) ----
  // One LabelPicker instance for the whole table, re-anchored per row.
  const [rowPicker, setRowPicker] = useState<{ id: string; anchor: PickerAnchor } | null>(null);
  const rowById = useMemo(() => {
    const m = new Map<string, ListRow>();
    for (const g of days) for (const r of g.rows as ListRow[]) m.set(r.assemblyai_id, r);
    return m;
  }, [days]);
  const rowPickerRow = rowPicker ? rowById.get(rowPicker.id) ?? null : null;
  const rowPickerSelected = useMemo(
    () => new Set((rowPickerRow?.labels ?? []).map((l) => l.id)),
    [rowPickerRow]
  );
  const closeRowPicker = useCallback(() => setRowPicker(null), []);
  /** Optimistic chip update, then the silent refetch + catalog refresh reconcile. */
  const patchRowLabels = useCallback((assemblyaiId: string, labels: LabelRef[]) => {
    setDays((prev) =>
      prev.map((g) =>
        g.rows.some((r) => r.assemblyai_id === assemblyaiId)
          ? {
              ...g,
              rows: g.rows.map((r) => (r.assemblyai_id === assemblyaiId ? { ...r, labels } : r)),
            }
          : g
      )
    );
  }, []);
  const toggleRowLabel = useCallback(
    async (assemblyaiId: string, label: LabelRef, nextOn: boolean) => {
      const res = nextOn
        ? await fetch(`/api/transcripts/${assemblyaiId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId: label.id }),
          })
        : await fetch(`/api/transcripts/${assemblyaiId}/labels/${label.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(parseError(txt) || (res.status === 403 ? 'Read-only access' : `Failed (${res.status})`));
      }
      const data = (await res.json().catch(() => null)) as { labels?: LabelRef[] } | null;
      if (data?.labels) patchRowLabels(assemblyaiId, data.labels);
      void fetchArchiveRef.current('silent');
      void refreshLabelCatalog();
    },
    [patchRowLabels]
  );
  // Selection (assemblyai ids). Checkboxes reveal on row hover / while the
  // selection is non-empty; shift-click ranges over the rendered order.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const renderedIdsRef = useRef<string[]>([]);
  const hoverRowIdRef = useRef<string | null>(null);
  const [bulkOpenSignal, setBulkOpenSignal] = useState(0);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    selectionAnchorRef.current = null;
  }, []);
  const toggleSelected = useCallback((id: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const order = renderedIdsRef.current;
      const anchor = selectionAnchorRef.current;
      if (shift && anchor && order.includes(anchor) && order.includes(id)) {
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const turnOn = !prev.has(id);
        for (let i = lo; i <= hi; i++) {
          if (turnOn) next.add(order[i]);
          else next.delete(order[i]);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      selectionAnchorRef.current = id;
      return next;
    });
  }, []);
  // Filters changed → the selection no longer maps to what's on screen.
  useEffect(() => {
    clearSelection();
  }, [tab, debouncedQ, from, to, peopleFilters, labelFilter, clearSelection]);
  // Drop ids that left the loaded window (deleted / filtered away).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (rowById.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rowById]);
  const selectedRows = useMemo(
    () => [...selected].map((id) => rowById.get(id)).filter((r): r is ListRow => !!r),
    [selected, rowById]
  );
  const selectedIds = useMemo(() => selectedRows.map((r) => r.assemblyai_id), [selectedRows]);
  const selectedLabels = useMemo(() => {
    const m = new Map<number, LabelRef>();
    for (const r of selectedRows) for (const l of r.labels ?? []) m.set(l.id, l);
    return [...m.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [selectedRows]);
  const selectedReadOnly = useMemo(
    () => selectedRows.filter((r) => !canEditRow(r)).length,
    [selectedRows]
  );
  const selectionMode = selected.size > 0;

  // Keyboard: `x` toggles the hovered row, `l` opens the label picker for
  // the selection (or the hovered row), `Esc` clears the selection.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (document.querySelector('[data-label-picker]')) return; // picker owns keys
      // Compare case-folded: Shift+x reports 'X' (shift = range select), and
      // Caps Lock must not kill the shortcuts.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 'x') {
        const id = hoverRowIdRef.current;
        if (!id) return;
        const row = rowById.get(id);
        if (!row || row.deleted_at || row.status === 'uploading' || id.startsWith('defer-')) return;
        e.preventDefault();
        toggleSelected(id, e.shiftKey);
      } else if (key === 'l') {
        if (selected.size > 0) {
          e.preventDefault();
          setBulkOpenSignal((n) => n + 1);
          return;
        }
        const id = hoverRowIdRef.current;
        if (!id) return;
        const row = rowById.get(id);
        if (!row || !canEditRow(row) || row.deleted_at) return;
        const btn = document.querySelector(`[data-row-id="${CSS.escape(id)}"] [data-label-add]`);
        if (!btn) return;
        e.preventDefault();
        setRowPicker({ id, anchor: anchorFromElement(btn) });
      } else if (e.key === 'Escape' && selected.size > 0) {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rowById, selected.size, toggleSelected, clearSelection]);

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
        // Deferred import — queued until the provider finishes the files.
        return (
          <span
            className={`${base} bg-amber-500 animate-pulse`}
            aria-label="Waiting for files"
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

  /** "N recordings" chip: extra Meet segments, a stitched multi-file upload,
   * or a combined re-transcription — one meeting, several source videos. */
  const recordingsChip = (t: ListRow) =>
    (t.recording_count ?? 1) > 1 ? (
      <span
        title={`${t.recording_count} recordings in this meeting`}
        className="inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] text-muted-foreground"
      >
        <Film className="h-3 w-3" />
        {t.recording_count}
      </span>
    ) : null;

  /** Series auto-import dot: blue = fully unattended (speakers
   * auto-identified, report generated without review), amber = auto-imported
   * but waiting on human speaker review. */
  const autoDot = (t: ListRow) =>
    t.auto_state === 'passed' ? (
      <span
        title="Auto-imported — speakers auto-identified and summary generated without review"
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500"
      />
    ) : t.auto_state === 'gated' ? (
      <span
        title="Auto-imported — waiting on speaker review before the summary"
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
      />
    ) : t.auto_state === 'auto' ? (
      <span
        title="Auto-imported from a series"
        className="inline-block h-2 w-2 shrink-0 rounded-full border border-blue-500"
      />
    ) : null;

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
      case 'labels': {
        // Chips moved here from the title cell (column-chooser controlled,
        // default on). Placeholder/queued/trashed rows show an empty cell.
        const placeholder = t.status === 'uploading' || t.assemblyai_id.startsWith('defer-');
        if (placeholder || t.status === 'waiting' || t.deleted_at) return null;
        return (
          // w-0 + min-w-full + overflow-hidden: the chips contribute zero
          // min-content width, so they can't widen the table (repo gotcha).
          // `fit` makes the chips shrink+truncate INSIDE that width so the
          // "+N" badge and the hover-"+" (the [data-label-add] anchor) never
          // get clipped out of the cell.
          <div className="w-0 min-w-full overflow-hidden">
            <LabelChips
              labels={t.labels}
              fit
              onFilter={
                onLabelFilter
                  ? (l) => onLabelFilter({ kind: 'id', id: l.id, exact: false })
                  : undefined
              }
              onAdd={
                canEditRow(t)
                  ? (e) =>
                      setRowPicker({
                        id: t.assemblyai_id,
                        anchor: anchorFromElement(e.currentTarget),
                      })
                  : undefined
              }
            />
          </div>
        );
      }
      case 'owner':
        return ownerCell(t);
      case 'date': {
        const when = t.recorded_at ?? t.created_at;
        // Grouped view already names the day in the section header — the
        // column narrows down to time-of-day.
        const label =
          colPrefs.groupByDay || renderMerged
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

  const toolbar = (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b">
      <div className="mb-2 mt-0.5">
        <LayersDropdown
          layers={layers}
          unimportedCount={calCounts ? calCounts.unimported : null}
          inactive={!mergedMode}
          onToggle={toggleLayer}
        />
      </div>
      {renderMerged && calConnected && calSync && (
        <div className="mb-2 mt-0.5 flex items-center gap-0.5 text-[11px] text-muted-foreground">
          <span
            title="When your calendar and meeting artifacts were last swept from Google/Microsoft. The background sync runs every 30 minutes; the import dialog always checks live."
          >
            {manualSyncing
              ? 'Syncing…'
              : calSync.lastPollAt
                ? `Cal synced ${formatAgo(calSync.lastPollAt)}`
                : 'Calendar not synced yet'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            disabled={manualSyncing}
            title="Sweep your calendar and meeting artifacts now"
            onClick={() => void runManualCalSync()}
          >
            <RefreshCw className={`h-3 w-3 ${manualSyncing ? 'animate-spin' : ''}`} />
            Sync
          </Button>
        </div>
      )}
      {mutes.length > 0 && (
        <div className="relative mb-2 mt-0.5" ref={hiddenMenuRef}>
          <button
            type="button"
            onClick={() => {
              setHiddenOpen((v) => {
                if (!v) void fetchMutes();
                return !v;
              });
            }}
            aria-expanded={hiddenOpen}
            title="Calendar rows you've hidden — review or undo"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <EyeOff className="h-3 w-3" />
            Hidden ({mutes.length})
          </button>
          {hiddenOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border bg-popover p-1 shadow-md">
              <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Hidden calendar meetings
              </p>
              <div className="max-h-64 overflow-y-auto">
                {mutes.map((m) => (
                  <div
                    key={`${m.kind}:${m.value}`}
                    className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        {m.title?.trim() || m.value}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {m.kind === 'series' ? 'series + future' : 'occurrence'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleUnmute(m)}
                      title="Unhide"
                      className="rounded p-1 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span className="sr-only">Unhide</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center">
        {tabButton('all', 'All', counts?.all)}
        {tabButton('mine', 'Mine', counts?.mine)}
        {tabButton('shared', 'Shared', counts?.shared)}
        {tabButton('trash', 'Trash', counts?.trash)}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5 pb-2">
        {toolbarExtra}
        {rangePicker}
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
        <PeopleFilterControl value={peopleFilters} onChange={setPeopleFilters} />
        {columnChooser}
        <Button
          onClick={silentRefetchAll}
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

  const filterChips = <PeopleFilterChips value={peopleFilters} onChange={setPeopleFilters} />;
  const peopleActive = hasPeopleFilters(peopleFilters) || !!labelFilter;

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

  /** One listing row — shared by the flat list, the day-grouped view, and
   * the merged timeline. */
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
    const selectable = !placeholder && !trashed;
    const isSelected = selected.has(t.assemblyai_id);
    return (
      <TableRow
        key={t.id}
        data-row-id={t.assemblyai_id}
        onMouseEnter={() => {
          hoverRowIdRef.current = t.assemblyai_id;
        }}
        onMouseLeave={() => {
          if (hoverRowIdRef.current === t.assemblyai_id) hoverRowIdRef.current = null;
        }}
        onClick={() => {
          if (!placeholder) router.push(`/transcript/${t.assemblyai_id}`);
        }}
        className={`group transition-colors hover:bg-accent/40 ${
          placeholder ? 'cursor-default' : 'cursor-pointer'
        } ${isSelected ? 'bg-primary/5' : ''}`}
      >
        <TableCell className={`relative py-2 ${selectionMode ? 'pl-8' : 'pl-4'}`}>
          {/* Selection checkbox — sits in the cell's left padding, revealed on
              hover; the padding widens while a selection exists. */}
          {selectable && (
            <input
              type="checkbox"
              checked={isSelected}
              aria-label={isSelected ? 'Deselect meeting' : 'Select meeting'}
              data-row-select
              onClick={(e) => {
                e.stopPropagation();
                toggleSelected(t.assemblyai_id, e.shiftKey);
              }}
              onChange={() => {}}
              className={`absolute top-1/2 -translate-y-1/2 cursor-pointer accent-primary ${
                selectionMode
                  ? 'left-2.5 h-3.5 w-3.5 opacity-100'
                  : 'left-[3px] h-3 w-3 opacity-0 group-hover:opacity-100 focus:opacity-100'
              }`}
            />
          )}
          {/* w-0 + min-w-full: zero min-content contribution, so long nowrap
              titles/series chips can't widen the table past its container. */}
          <div className="w-0 min-w-full">
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
                {/* Below md every middle column (incl. Labels) is hidden —
                    keep a compact read-only chip row here so phones still
                    see labels. No onAdd: [data-label-add] must stay unique
                    to the Labels column for the 'l'-shortcut anchor. */}
                {!uploading && !waiting && !trashed && (
                  <LabelChips
                    labels={t.labels}
                    className="md:hidden"
                    onFilter={
                      onLabelFilter
                        ? (l) => onLabelFilter({ kind: 'id', id: l.id, exact: false })
                        : undefined
                    }
                  />
                )}
                {!uploading && !waiting && !trashed && recordingsChip(t)}
                {!trashed && autoDot(t)}
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
                  {t.deferred_background
                    ? 'importing in the background — pulling the recording and submitting for transcription'
                    : `import queued — ${t.provider === 'teams' ? 'Microsoft' : 'Google'} is still preparing the ${
                        t.deferred_mode === 'video'
                          ? 'video file'
                          : t.deferred_mode === 'both'
                            ? 'video + transcript'
                            : t.provider === 'teams'
                              ? 'transcript'
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

  /**
   * The merged timeline: interleave archive rows and calendar events inside
   * shared day groups, newest day first, time-desc within a day.
   *
   * Day watermark: a day is renderable only when EVERY enabled source has
   * fully covered it. A source with more pages covers all days >= its
   * nextCursor (day keys are YYYY-MM-DD — string compare works); one with
   * hasMore=false covers everything. Days beyond the watermark stay
   * buffered until every enabled source reaches them — no half-days.
   *
   * null = blocked: an enabled calendar layer hasn't finished its first
   * load yet (errored layers don't block — they just contribute nothing).
   */
  const mergedGroups = useMemo<MergedGroup[] | null>(() => {
    if (!renderMerged) return null;
    for (const v of CAL_VIEWS) {
      if (layers[v] && !calSrc[v].loaded && !calSrc[v].error) return null;
    }
    let watermark: string | null = null;
    const consider = (srcHasMore: boolean, cursor: string | null) => {
      if (srcHasMore && cursor && (watermark === null || cursor > watermark)) {
        watermark = cursor;
      }
    };
    if (layers.archive) consider(hasMore, nextCursor);
    for (const v of CAL_VIEWS) {
      if (layers[v] && calSrc[v].loaded) consider(calSrc[v].hasMore, calSrc[v].cursor);
    }
    const covered = (key: string) => watermark === null || key >= watermark;
    const byKey = new Map<string, { items: MergedItem[]; totalSecs: number }>();
    const bucket = (key: string) => {
      let b = byKey.get(key);
      if (!b) {
        b = { items: [], totalSecs: 0 };
        byKey.set(key, b);
      }
      return b;
    };
    if (layers.archive) {
      for (const g of days) {
        if (!covered(g.key)) continue;
        const b = bucket(g.key);
        b.totalSecs += g.totalSecs ?? 0;
        for (const r of g.rows as ListRow[]) {
          b.items.push({
            at: new Date(r.recorded_at ?? r.created_at).getTime(),
            kind: 'archive',
            row: r,
          });
        }
      }
    }
    for (const v of CAL_VIEWS) {
      if (!layers[v]) continue;
      for (const g of calSrc[v].days) {
        if (!covered(g.key)) continue;
        const b = bucket(g.key);
        for (const r of g.rows) {
          b.totalSecs += r.durationSecs ?? 0;
          b.items.push({ at: new Date(r.eventStart).getTime(), kind: 'cal', layer: v, row: r });
        }
      }
    }
    return [...byKey.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([key, g]) => {
        g.items.sort((x, y) => y.at - x.at);
        const { label, sub } = dayHeading(parseDayKey(key));
        return { key, heading: label, sub, items: g.items, totalSecs: g.totalSecs };
      });
  }, [renderMerged, layers, calSrc, days, hasMore, nextCursor]);

  const rowCount = flatRows.length;
  const searchEmpty = rowCount === 0 && debouncedQ.length > 0;
  // Rendered archive-row order (for shift-click ranges), kept in a ref so
  // the selection handlers don't re-create on every page.
  renderedIdsRef.current = mergedGroups
    ? mergedGroups.flatMap((g) =>
        g.items.flatMap((it) => (it.kind === 'archive' ? [it.row.assemblyai_id] : []))
      )
    : flatRows.map((r) => r.assemblyai_id);

  const archiveTableHeader = (
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
  );

  const dayHeaderRow = (g: {
    key: string;
    heading: string;
    sub: string | null;
    count: number;
    totalSecs: number;
  }) => (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={visibleCols.length + 2} className="bg-muted/40 py-1.5 pl-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
          {g.heading}
        </span>
        {g.sub && (
          <span className="ml-1.5 text-[11px] text-muted-foreground/70">{g.sub}</span>
        )}
        <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
          {g.count} meeting{g.count === 1 ? '' : 's'}
          {g.totalSecs > 0 ? ` · ${formatDuration(g.totalSecs)}` : ''}
        </span>
      </TableCell>
    </TableRow>
  );

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
        ) : peopleActive ? (
          emptyState(
            <Filter className="h-5 w-5 text-muted-foreground" />,
            'No meetings match these filters',
            'Remove a filter chip above, or widen the date range.'
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
          {archiveTableHeader}
          <TableBody>
            {colPrefs.groupByDay
              ? archiveGroups.map((g) => (
                  <Fragment key={g.key}>
                    {dayHeaderRow({
                      key: g.key,
                      heading: g.heading,
                      sub: g.sub,
                      count: g.rows.length,
                      totalSecs: g.totalSecs,
                    })}
                    {(g.rows as ListRow[]).map(renderRow)}
                  </Fragment>
                ))
              : flatRows.map(renderRow)}
          </TableBody>
        </Table>
      )
    )
  );

  /** Merged timeline body (tab=all, no search, ≥1 calendar layer on). */
  const mergedBody = (() => {
    if (loading || mergedGroups === null) return container(spinner);
    if (error) {
      return container(
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
      );
    }
    const strips: React.ReactNode[] = [];
    if (!calConnected) {
      strips.push(
        <div
          key="connect"
          className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
        >
          <Video className="h-3.5 w-3.5 shrink-0" />
          Connect Google to see calendar meetings in this timeline — use &quot;Import
          meeting&quot; in the header.
        </div>
      );
    }
    for (const v of CAL_VIEWS) {
      if (!layers[v] || !calSrc[v].error) continue;
      strips.push(
        <div
          key={`err-${v}`}
          className="flex items-center justify-between gap-2 border-b bg-destructive/5 px-4 py-1.5 text-xs text-destructive"
        >
          <span className="min-w-0 truncate">
            Couldn&apos;t load the {v === 'unimported' ? 'Not imported' : 'No recording'}{' '}
            layer — {calSrc[v].error}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => void fetchCalendar(v, 'reset')}
          >
            Retry
          </Button>
        </div>
      );
    }
    const totalItems = mergedGroups.reduce((n, g) => n + g.items.length, 0);
    if (totalItems === 0) {
      return container(
        <>
          {strips}
          {!calConnected && !layers.archive ? (
            emptyState(
              <Video className="h-5 w-5 text-muted-foreground" />,
              'Connect Google to see your calendar here',
              'Use "Import meeting" in the header to connect your Google account.'
            )
          ) : peopleActive ? (
            emptyState(
              <Filter className="h-5 w-5 text-muted-foreground" />,
              'No meetings match these filters',
              'Remove a filter chip above, or widen the date range.'
            )
          ) : layers.archive ? (
            emptyState(
              <FileAudio className="h-5 w-5 text-muted-foreground" />,
              'No meetings here yet',
              'Drag a file anywhere on this page, or use Upload audio in the header.'
            )
          ) : (
            emptyState(
              <CalendarX2 className="h-5 w-5 text-muted-foreground" />,
              'No calendar meetings found in this range',
              'Data accumulates from calendar sweeps going forward.'
            )
          )}
        </>
      );
    }
    return container(
      <>
        {strips}
        <Table>
          {archiveTableHeader}
          <TableBody>
            {mergedGroups.map((g) => (
              <Fragment key={g.key}>
                {dayHeaderRow({
                  key: g.key,
                  heading: g.heading,
                  sub: g.sub,
                  count: g.items.length,
                  totalSecs: g.totalSecs,
                })}
                {g.items.map((it) =>
                  it.kind === 'archive' ? (
                    renderRow(it.row)
                  ) : (
                    <CalendarEventRow
                      key={`cal-${it.layer}-${it.row.key}`}
                      row={it.row}
                      layer={it.layer}
                      visibleCols={visibleCols}
                      colClass={(key) => COL_RESPONSIVE[key as ColKey] ?? ''}
                      onImportMeeting={onImportMeeting}
                      onMuteChanged={handleMuteChanged}
                      onOpenSeries={setOpenSeriesId}
                    />
                  )
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </>
    );
  })();

  const archiveMoreEligible =
    (!renderMerged || layers.archive) && !loading && !error && hasMore;
  const calMoreEligible =
    renderMerged &&
    CAL_VIEWS.some(
      (v) => layers[v] && calSrc[v].loaded && calSrc[v].hasMore && !calSrc[v].error
    );
  const showSentinel = archiveMoreEligible || calMoreEligible;
  const showLoadingMore =
    loadingMore || calSrc.unimported.loadingMore || calSrc.norec.loadingMore;

  return (
    <div>
      {toolbar}
      {filterChips}
      {renderMerged && calSync?.syncing && (
        <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <div>
            <span className="font-medium">Calendar sync in progress.</span>{' '}
            <span className="text-muted-foreground">
              Your Google Calendar and meeting artifacts are being fetched for
              the first time since connecting — events may still be missing
              here. This usually finishes within a few minutes; the list
              updates itself when it does.
            </span>
          </div>
        </div>
      )}
      {renderMerged ? mergedBody : archiveBody}
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
        onMerged={setOpenSeriesId}
      />
      {rowPicker && rowPickerRow && (
        <LabelPicker
          anchor={rowPicker.anchor}
          onClose={closeRowPicker}
          selectedIds={rowPickerSelected}
          onSelect={(label, nextOn) => toggleRowLabel(rowPicker.id, label, nextOn)}
          resetKey={rowPicker.id}
        />
      )}
      <BulkLabelBar
        selectedIds={selectedIds}
        selectedLabels={selectedLabels}
        readOnlyCount={selectedReadOnly}
        onClear={clearSelection}
        openAddSignal={bulkOpenSignal}
        onApplied={() => {
          void fetchArchiveRef.current('silent');
          void refreshLabelCatalog();
        }}
      />
    </div>
  );
}
