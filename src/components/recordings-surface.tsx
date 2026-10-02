'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Archive,
  CalendarSearch,
  Check,
  ExternalLink,
  FilePlus2,
  Hourglass,
  Laptop,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { formatBytes, formatDuration, scratchTrashDate, type TranscriptListRow } from '@/lib/format';
import type { RecordingSection, RecordingSectionCounts } from '@/lib/recordings-page';
import {
  expiresCopy,
  recordingDisplayTitle,
  stripForRecordingView,
  type RecordingViewWire,
} from '@/lib/recording-view';
import { meetingTitleOf, shortWhen } from '@/lib/meeting-title';
import { stripForArchiveRow, stripForRecorderRef, type StripActionKind } from '@/lib/recording-strip';
import type { RecorderMatch, RecorderRecordingRef } from '@/lib/recorder';
import { recorderRowIsConfident, RECORDING_STALE_MS } from '@/lib/recorder';
import {
  getCompanion,
  useCompanion,
  useCompanionRecordings,
} from '@/lib/companion/companion-client';
import { RecordingStrip, SourceGlyph } from '@/components/recording-strip';
import { LinkEventDialog } from '@/components/link-event-dialog';
import { OFFLINE_TITLE } from '@/lib/offline/offline-types';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';
import {
  linkedMeetingLabel,
  linkedRecordingFacts,
  registryItemsAwaitingSwap,
  swapRefreshDelay,
  type LinkedMeetingWire,
} from '@/lib/recordings-live';

/**
 * The Recordings surface (docs/recordings-meetings-series-design.md §3.1):
 * the caller's OWN recordings that belong to no meeting. Its own page,
 * `/recordings`, a sibling of Meetings and Series in the top nav — a
 * recording is not a kind of meeting row.
 *
 * ONE newest-first, cursor-paginated list from ONE owner-scoped endpoint,
 * `GET /api/recordings?mine=1` (lib/server/own-recordings; P6, paginated in
 * P7): standalone recordings (uploads born as recordings, design P7), legacy
 * bare / temporary uploads that are still meeting rows, and Darth Recorder
 * files still on a Mac. A section filter with the server's counts, a
 * search box, and more pages as the list scrolls (the listing's sentinel
 * pattern). Link to meeting… / Make a meeting / Keep move a recording out
 * of the unlinked sections — only a meeting is ever shared (a link to a
 * calendar event shares it with the invite's internal people); the
 * recording itself never is.
 *
 * Linked recordings stay findable (2026-10-02): a "Linked to a meeting"
 * section (`section=linked`), and under All a short group of the newest
 * ones, each with Open meeting / Open recording. A Mac row whose upload is
 * under way refetches until the server hands it back as its recording, so
 * Link / Make a meeting are there while the bytes still move
 * (lib/recordings-live.ts).
 */

/** Own-registry row as the server serves it (lib/server/recorder-view
 * OwnRecordingView, re-declared here so no server module is imported into
 * the client bundle). */
export interface OwnRecorderRecording {
  id: string;
  device_id: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  bytes: number | null;
  segments: unknown;
  call: { title?: string; app?: string; kind?: string } | null;
  matched: RecorderMatch | null;
  /** The server's verdict on `matched` — the ONE definition of confident
   * (lib/server/recorder-view). Absent on a row the server matched before
   * 2026-09-22 17:00 SGT; `recorderRowIsConfident()` below re-derives it. */
  matched_confident?: boolean;
  transcript_id: string | null;
  error: string | null;
}

/** One item of `GET /api/recordings?mine=1` (lib/server/own-recordings RecordingsPageItem). */
export type RecordingsItemWire =
  | {
      kind: 'recording';
      section: RecordingSection;
      sort_us: string;
      recording: RecordingViewWire;
      /** Section 'linked' only: the meetings holding it that the caller can open. */
      meetings?: LinkedMeetingWire[];
    }
  | {
      kind: 'meeting';
      section: RecordingSection;
      sort_us: string;
      row: TranscriptListRow;
      registry: OwnRecorderRecording | null;
    }
  | { kind: 'registry'; section: 'mac'; sort_us: string; registry: OwnRecorderRecording };

interface RecordingsPageWire {
  items: RecordingsItemWire[];
  next_cursor: string | null;
  counts: RecordingSectionCounts;
}

const EMPTY_COUNTS: RecordingSectionCounts = { mac: 0, uploaded: 0, temporary: 0 };

function segmentCount(segments: unknown): number | null {
  return Array.isArray(segments) ? segments.length : null;
}

/**
 * The Meetings listing's "N recordings aren't linked to a meeting yet"
 * strip: counts only (`limit=0`) — sections 1 + 2, as it always counted.
 */
export function useUnlinkedRecordings(opts: { enabled: boolean; refreshKey: number; tz: string }): {
  count: number;
  loading: boolean;
  refresh: () => void;
} {
  const { enabled, refreshKey, tz } = opts;
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    const params = new URLSearchParams({ mine: '1', unlinked: '1', limit: '0', tz });
    fetch(`/api/recordings?${params.toString()}`, { credentials: 'include' })
      .then(async (res) => (res.ok ? ((await res.json()) as RecordingsPageWire) : null))
      .then((data) => {
        if (live && data) setCount(data.counts.mac + data.counts.uploaded);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, refreshKey, nonce, tz]);
  return { count, loading, refresh };
}

export type RecordingsFilter = 'all' | RecordingSection;

export interface RecordingsPage {
  items: RecordingsItemWire[];
  counts: RecordingSectionCounts;
  /** Linked recordings: the count, and (outside the Linked filter) the
   * newest few for the All view's group. */
  linked: { count: number; preview: RecordingsItemWire[] };
  filter: RecordingsFilter;
  setFilter: (f: RecordingsFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore: () => void;
  refresh: () => void;
}

const PAGE_SIZE = 50;
/** How many linked recordings the All view shows under its own heading. */
export const LINKED_PREVIEW = 4;

/**
 * The paginated list. A new filter / search / refresh starts over at page
 * one; `loadMore` appends the next page from `next_cursor`. Registry-dirtying
 * tray events (upload done, a recording stopped) refresh it.
 */
export function useRecordingsPage(opts: {
  enabled: boolean;
  tz: string;
  initialFilter?: RecordingsFilter;
}): RecordingsPage {
  const { enabled, tz } = opts;
  const [filter, setFilter] = useState<RecordingsFilter>(opts.initialFilter ?? 'all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<RecordingsItemWire[]>([]);
  const [counts, setCounts] = useState<RecordingSectionCounts>(EMPTY_COUNTS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const genRef = useRef(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const companion = useCompanion();
  const ev = companion.lastEvent;
  const evKey =
    ev && ['recording_stopped', 'upload_done', 'upload_failed', 'recording_deleted'].includes(ev.type) ? ev.at : 0;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const urlFor = useCallback(
    (after: string | null) => {
      const params = new URLSearchParams({ mine: '1', limit: String(PAGE_SIZE), tz });
      if (filter !== 'all') params.set('section', filter);
      if (debounced) params.set('q', debounced);
      if (after) params.set('cursor', after);
      return `/api/recordings?${params.toString()}`;
    },
    [filter, debounced, tz]
  );

  const fetchPage = useCallback(
    async (after: string | null) => {
      const res = await fetch(urlFor(after), { credentials: 'include' });
      if (!res.ok) throw await offlineAwareError(res, `Failed to load recordings (${res.status})`);
      return (await res.json()) as RecordingsPageWire;
    },
    [urlFor]
  );

  useEffect(() => {
    if (!enabled) return;
    const gen = ++genRef.current;
    setLoading(true);
    fetchPage(null)
      .then((data) => {
        if (gen !== genRef.current) return;
        setItems(data.items);
        setCounts(data.counts);
        setCursor(data.next_cursor);
        setError(null);
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return;
        setError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Failed to load recordings');
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
  }, [enabled, fetchPage, nonce, evKey]);

  // The registry -> recording swap (lib/recordings-live.ts): a Mac row seen
  // uploading refetches, on a short backoff, until the server lists it as
  // the recording its upload opened — the row Link / Make a meeting act on.
  const awaitingSwap = useMemo(
    () => registryItemsAwaitingSwap(items, companion.uploads).join(','),
    [items, companion.uploads]
  );
  const swapRef = useRef<{ key: string; attempt: number }>({ key: '', attempt: 0 });
  useEffect(() => {
    if (!enabled || loading || !awaitingSwap) return;
    if (swapRef.current.key !== awaitingSwap) swapRef.current = { key: awaitingSwap, attempt: 0 };
    const delay = swapRefreshDelay(swapRef.current.attempt);
    if (delay === null) return;
    swapRef.current.attempt += 1;
    const t = setTimeout(refresh, delay);
    return () => clearTimeout(t);
  }, [enabled, loading, awaitingSwap, items, refresh]);

  // Linked recordings outside the Linked filter: their count for the chip and
  // the newest few for the All view's group (`section=linked` is asked for by
  // name; the default answer never carries it).
  const [linkedCount, setLinkedCount] = useState(0);
  const [linkedPreview, setLinkedPreview] = useState<RecordingsItemWire[]>([]);
  useEffect(() => {
    if (!enabled || filter === 'linked') return;
    let live = true;
    const params = new URLSearchParams({
      mine: '1',
      section: 'linked',
      limit: String(filter === 'all' ? LINKED_PREVIEW : 0),
      tz,
    });
    if (debounced) params.set('q', debounced);
    fetch(`/api/recordings?${params.toString()}`, { credentials: 'include' })
      .then(async (res) => (res.ok ? ((await res.json()) as RecordingsPageWire) : null))
      .then((data) => {
        if (!live || !data) return;
        setLinkedCount(data.counts.linked ?? 0);
        setLinkedPreview(data.items);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, filter, debounced, tz, nonce, evKey]);

  const loadMore = useCallback(() => {
    if (!cursor || loading || loadingMore || error) return;
    const gen = genRef.current;
    setLoadingMore(true);
    fetchPage(cursor)
      .then((data) => {
        if (gen !== genRef.current) return;
        setItems((prev) => {
          const seen = new Set(prev.map(itemKey));
          return [...prev, ...data.items.filter((i) => !seen.has(itemKey(i)))];
        });
        setCounts(data.counts);
        setCursor(data.next_cursor);
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return;
        setError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Failed to load more');
      })
      .finally(() => {
        if (gen === genRef.current) setLoadingMore(false);
      });
  }, [cursor, loading, loadingMore, error, fetchPage]);

  return {
    items,
    counts,
    linked:
      filter === 'linked'
        ? { count: counts.linked ?? 0, preview: [] }
        : { count: linkedCount, preview: filter === 'all' ? linkedPreview : [] },
    filter,
    setFilter,
    query,
    setQuery,
    loading,
    loadingMore,
    hasMore: !!cursor,
    error,
    loadMore,
    refresh,
  };
}

function itemKey(i: RecordingsItemWire): string {
  return i.kind === 'recording' ? `r:${i.recording.id}` : i.kind === 'meeting' ? `m:${i.row.assemblyai_id}` : `g:${i.registry.id}`;
}

// ---------------------------------------------------------------------------

export interface RecordingsSurfaceProps {
  data: RecordingsPage;
  disabled?: boolean;
  /** Something changed that the archive should notice (a link, a name, a trash). */
  onChanged?: () => void;
}

const FILTERS: Array<{ key: RecordingsFilter; label: string; short: string }> = [
  { key: 'all', label: 'All', short: 'All' },
  { key: 'mac', label: 'On your Macs', short: 'Macs' },
  { key: 'uploaded', label: 'Uploaded, not in a meeting', short: 'Uploaded' },
  { key: 'temporary', label: 'Temporary', short: 'Temporary' },
  { key: 'linked', label: 'Linked to a meeting', short: 'Linked' },
];

export function RecordingsSurface({ data, disabled = false, onChanged }: RecordingsSurfaceProps) {
  const {
    items,
    counts,
    linked,
    filter,
    setFilter,
    query,
    setQuery,
    loading,
    loadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
  } = data;
  const companion = useCompanion();
  const tray = useCompanionRecordings(companion.connected);
  const trayIds = useMemo(() => new Set(tray.recordings.map((r) => r.id)), [tray.recordings]);
  const [linkFor, setLinkFor] = useState<
    { kind: 'meeting'; id: string; dateIso: string | null } | { kind: 'recording'; id: string; dateIso: string | null } | null
  >(null);

  const changed = useCallback(() => {
    refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  // Infinite scroll — the listing's sentinel pattern (transcript-table.tsx):
  // a callback-ref observer, and an explicit kick when a short page leaves
  // the sentinel on screen.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleRef = useRef(false);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    visibleRef.current = false;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        visibleRef.current = entries.some((e) => e.isIntersecting);
        if (visibleRef.current) loadMoreRef.current();
      },
      { rootMargin: '300px' }
    );
    io.observe(node);
    observerRef.current = io;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  useEffect(() => {
    if (visibleRef.current) loadMoreRef.current();
  }, [items.length]);

  const total = counts.mac + counts.uploaded + counts.temporary + linked.count;
  const countOf = (f: RecordingsFilter) => (f === 'all' ? total : f === 'linked' ? linked.count : counts[f]);
  const empty = !loading && !error && items.length === 0;

  return (
    <div className="space-y-3" data-recordings-surface>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Sections"
          className="flex min-w-0 flex-wrap items-center gap-1"
          data-recordings-filters
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              title={f.label}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs ${
                filter === f.key ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
              data-filter={f.key}
              {...(f.key === 'temporary' ? { id: 'temporary' } : {})}
            >
              {f.key === 'temporary' && <Hourglass className="h-3 w-3" />}
              {f.key === 'linked' && <Link2 className="h-3 w-3" />}
              <span className="sm:hidden">{f.short}</span>
              <span className="hidden sm:inline">{f.label}</span>
              <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{countOf(f.key)}</span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles and file names"
            className="h-8 pl-7 text-sm"
            aria-label="Search recordings"
            data-recordings-search
          />
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="truncate">{error}</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      {loading && items.length === 0 && !error && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin" />
        </div>
      )}
      {empty && (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted">
            <Laptop className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="mt-3 text-sm font-medium">
            {query.trim()
              ? 'No recording matches that search'
              : filter === 'linked'
                ? 'No recording is linked to a meeting yet'
                : 'No recordings outside a meeting'}
          </p>
          {!query.trim() && filter !== 'linked' && (
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Recordings are yours alone — nobody else sees them. A new upload waits here until you
              link it to a meeting or make a meeting of it; when one looks like a meeting in your
              calendar it says so and you decide. Nothing is linked or shared on a match alone.
            </p>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2" data-recordings-list>
          {items.map((it) =>
            it.kind === 'recording' && it.section === 'linked' ? (
              <LinkedCard key={itemKey(it)} r={it.recording} meetings={it.meetings ?? []} />
            ) : it.kind === 'registry' ? (
              <MacCard
                key={itemKey(it)}
                r={it.registry}
                trayHasIt={companion.connected && trayIds.has(it.registry.id)}
                live={companion.uploads[it.registry.id]?.status === 'uploading' ? companion.uploads[it.registry.id] : null}
                disabled={disabled}
                onChanged={() => {
                  setTimeout(refresh, 800);
                }}
              />
            ) : it.kind === 'meeting' ? (
              <BareCard
                key={itemKey(it)}
                row={it.row}
                temporary={it.section === 'temporary'}
                reg={it.registry}
                live={
                  it.row.recorder_recording_id && companion.uploads[it.row.recorder_recording_id]?.status === 'uploading'
                    ? companion.uploads[it.row.recorder_recording_id]
                    : null
                }
                disabled={disabled}
                onLink={() =>
                  setLinkFor({ kind: 'meeting', id: it.row.assemblyai_id, dateIso: it.row.recorded_at ?? it.row.created_at })
                }
                onChanged={changed}
              />
            ) : (
              <RecordingCard
                key={itemKey(it)}
                r={it.recording}
                live={
                  it.recording.recorder_recording_id &&
                  companion.uploads[it.recording.recorder_recording_id]?.status === 'uploading'
                    ? companion.uploads[it.recording.recorder_recording_id]
                    : null
                }
                disabled={disabled}
                onLink={() =>
                  setLinkFor({
                    kind: 'recording',
                    id: it.recording.id,
                    dateIso: it.recording.started_at ?? it.recording.created_at,
                  })
                }
                onChanged={changed}
              />
            )
          )}
        </div>
      )}

      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-3" data-recordings-sentinel>
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Load more
          </Button>
        </div>
      )}

      {filter === 'all' && linked.preview.length > 0 && (
        <LinkedGroup items={linked.preview} count={linked.count} onShowAll={() => setFilter('linked')} />
      )}

      {linkFor && (
        <LinkEventDialog
          open
          transcriptId={linkFor.kind === 'meeting' ? linkFor.id : ''}
          recordingId={linkFor.kind === 'recording' ? linkFor.id : undefined}
          initialDateIso={linkFor.dateIso}
          onClose={() => setLinkFor(null)}
          onLinked={() => {
            setLinkFor(null);
            changed();
          }}
        />
      )}
    </div>
  );
}

/** "Looks like Data scrum · 14:00" — the matcher's best guess, shown only
 * when it is a confident one, and only ever to the owner. No raw score: a
 * number invites reading a weak match as "82 % sure" (design §3.1, F3). */
function MatchHint({ m, onLink, busy }: { m: RecorderMatch | null; onLink?: () => void; busy?: boolean }) {
  if (!m || !m.title) return null;
  const when = new Date(m.occ_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" data-match-hint>
      <CalendarSearch className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">
        Looks like <span className="text-foreground/80">{m.title}</span> · {when}
      </span>
      {onLink && (
        <button
          type="button"
          disabled={busy}
          onClick={onLink}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-primary/35 bg-primary/5 px-2 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-60"
          data-link-suggested
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
          Link to it
        </button>
      )}
    </div>
  );
}

function cardCls(extra = '') {
  return `flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] ${extra}`;
}

// ---------------------------------------------------------------------------

function MacCard({
  r,
  trayHasIt,
  live,
  disabled,
  onChanged,
}: {
  r: OwnRecorderRecording;
  trayHasIt: boolean;
  live: { pct: number; bytesSent: number | null; bytesTotal: number | null; segment: number | null; segmentsTotal: number | null } | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const ref: RecorderRecordingRef = {
    id: r.id,
    mine: true,
    ownerEmail: null,
    hostname: null,
    status: live ? 'uploading' : r.status,
    startedAt: r.started_at,
    durationS: r.duration_s,
    transcriptId: r.transcript_id,
    ownTranscriptId: r.transcript_id,
    // This surface has its own MatchHint; the calendar row is where the
    // suggestion strip lives.
    suggestedEvent: null,
  };
  const model = stripForRecorderRef(ref, { trayConnected: trayHasIt, fmtDuration: formatDuration });
  if (live) {
    const parts: string[] = [`Uploading from your Mac · ${Math.round(live.pct)}%`];
    if (live.bytesSent != null && live.bytesTotal != null && live.bytesTotal > 0) {
      parts.push(`${formatBytes(live.bytesSent)} of ${formatBytes(live.bytesTotal)}`);
    }
    if (live.segment != null && live.segmentsTotal != null && live.segmentsTotal > 1) {
      parts.push(`part ${live.segment} of ${live.segmentsTotal}`);
    }
    model.text = parts.join(' · ');
    model.progress = { pct: live.pct, label: model.text, live: true };
  }
  const startedMs = r.started_at ? Date.parse(r.started_at) : NaN;
  const stale = r.status === 'recording' && Number.isFinite(startedMs) && Date.now() - startedMs > RECORDING_STALE_MS;
  const title = r.call?.title?.trim() || (r.call?.app ? `${r.call.app} call` : null) || `Recording · ${shortWhen(r.started_at)}`;
  const segs = segmentCount(r.segments);
  const meta = [
    r.call?.title ? shortWhen(r.started_at) : null,
    r.duration_s ? formatDuration(r.duration_s) : null,
    r.bytes ? formatBytes(r.bytes) : null,
    segs && segs > 1 ? `${segs} segments` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const onAction = (kind: StripActionKind) => {
    setNote(null);
    if (kind === 'upload') {
      // No linked event: the server has not linked an upload to a calendar
      // match since 6287854, and never will — linking is the person's
      // action, taken from the card's own suggestion or the Link dialog.
      const ok = getCompanion().upload(r.id, null);
      setNote(ok ? 'uploading…' : 'Open Darth Recorder on that Mac to upload it');
      onChanged();
    } else if (kind === 'open-recorder') {
      setNote('Open Darth Recorder on the Mac that holds the file');
    }
  };
  const busy = r.status === 'uploading' || (r.status === 'recording' && !stale) || !!live;

  return (
    <div className={cardCls()} data-recording-card="mac" data-status={r.status} data-recorder-recording={r.status} data-recorder-mine="1">
      <div className="flex min-w-0 items-start gap-2">
        <SourceGlyph source="mac" className="mt-1 h-3.5 w-3.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          {meta && <p className="truncate text-[11px] text-muted-foreground">{meta}</p>}
        </div>
        {!busy && trayHasIt && (
          <button
            type="button"
            disabled={disabled}
            title="Delete this recording from this Mac — it was never uploaded, so it is gone for good"
            aria-label="Delete from this Mac"
            data-recorder-delete
            onClick={() => {
              if (window.confirm(`Delete this recording from this Mac? It was never uploaded.\n\n${title}`)) {
                getCompanion().deleteRecording(r.id);
                onChanged();
              }
            }}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <MatchHint m={recorderRowIsConfident(r) ? r.matched : null} />
      <RecordingStrip
        model={model}
        noGlyph
        onAction={onAction}
        note={note ?? (r.status === 'upload_failed' && r.error ? r.error : null)}
        disabled={disabled}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** "expires in 12 days" / "expires today" for a temporary upload. */
export function expiresInCopy(createdAt: string, now: number = Date.now()): string {
  const ms = scratchTrashDate(createdAt).getTime() - now;
  const days = Math.ceil(ms / 86_400_000);
  if (days <= 0) return 'expires today';
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * One uploaded recording that is in no meeting — section 2, or section 3
 * with `temporary`. Actions (design §3.1): Link to meeting… · Make a meeting
 * (Q5: a name on a recording makes a standalone meeting) · Keep (temporary
 * only: drops the expiry, it stays a recording) · Open · Delete.
 */
function BareCard({
  row,
  temporary = false,
  reg,
  live,
  disabled,
  onLink,
  onChanged,
}: {
  row: TranscriptListRow;
  /** A temporary upload (migration 042): shows its expiry and offers Keep. */
  temporary?: boolean;
  reg: OwnRecorderRecording | null;
  live: { pct: number; bytesSent: number | null; bytesTotal: number | null } | null;
  disabled: boolean;
  onLink: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'name' | 'link' | 'trash' | 'retry' | 'keep' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const placeholder = row.status === 'uploading' || row.assemblyai_id.startsWith('defer-');
  const { primary, filename } = meetingTitleOf(row);
  const model =
    stripForArchiveRow(row, { live, fmtBytes: formatBytes, fmtDuration: formatDuration }) ??
    ({
      source: row.provider === 'gmeet' ? 'meet' : row.provider === 'teams' ? 'teams' : row.source === 'uploaded' ? 'file' : 'text',
      state: 'transcribed',
      tone: 'muted',
      text: [
        'Transcribed',
        row.duration ? formatDuration(row.duration) : null,
        row.speaker_count ? `${row.speaker_count} speaker${row.speaker_count === 1 ? '' : 's'}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      title: filename,
      progress: null,
      action: null,
      busy: false,
    } as const);
  const source = model.source;

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(isNetworkFailure(e) ? OFFLINE_TITLE : e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };
  const saveName = () =>
    run('name', async () => {
      const t = name.trim();
      if (!t) return;
      // A named recording IS a meeting (Q5). A temporary one stops being
      // temporary in the same write — a meeting cannot be temporary (§3.2).
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(temporary ? { title: t, scratch: false } : { title: t }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Could not make the meeting (${res.status})`);
      setRenaming(false);
      onChanged();
    });
  const keep = () =>
    run('keep', async () => {
      // Keep (Q6): the expiry goes; it stays a recording (and lands in
      // "Uploaded, not in a meeting" unless it already has a title).
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scratch: false }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Keep failed (${res.status})`);
      onChanged();
    });
  const linkSuggested = () =>
    run('link', async () => {
      // Belt on the braces: the button only renders for a confident match.
      if (!recorderRowIsConfident(reg) || !reg?.matched?.event_key) return;
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}/link-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventKey: reg.matched.event_key }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Link failed (${res.status})`);
      }
      onChanged();
    });
  const trash = () =>
    run('trash', async () => {
      if (placeholder && !window.confirm('Cancel this upload?')) return;
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Delete failed (${res.status})`);
      onChanged();
    });
  const retry = () =>
    run('retry', async () => {
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}/retry-ingest`, { method: 'POST' });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Retry failed (${res.status})`);
      }
      onChanged();
    });

  const iconBtn = 'h-7 gap-1 px-2 text-xs';
  return (
    <div
      className={cardCls()}
      data-recording-card={temporary ? 'temporary' : 'bare'}
      data-status={row.status}
      data-row-id={row.assemblyai_id}
    >
      <div className="flex min-w-0 items-start gap-2">
        {temporary ? (
          <span title={filename ?? undefined} className="mt-1 shrink-0">
            <Hourglass className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" aria-label="Temporary" />
          </span>
        ) : (
          <SourceGlyph source={source} className="mt-1 h-3.5 w-3.5" title={filename ?? undefined} />
        )}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
            >
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(false);
                }}
                placeholder="Meeting title"
                className="h-7 text-sm"
                data-rename-input
              />
              <Button type="submit" size="sm" variant="default" className="h-7 px-2" disabled={busy === 'name' || !name.trim()}>
                {busy === 'name' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => setRenaming(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </form>
          ) : (
            <p className="truncate text-sm font-medium" title={filename ?? undefined}>
              {primary}
            </p>
          )}
          {!renaming && (
            <p className="truncate text-[11px] text-muted-foreground">
              {[
                new Date(row.recorded_at ?? row.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
                (row.recording_count ?? 1) > 1 ? `${row.recording_count} ${source === 'mac' ? 'segments' : 'parts'}` : null,
                reg?.bytes ? formatBytes(reg.bytes) : null,
                temporary ? expiresInCopy(row.created_at) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      </div>
      <MatchHint
        m={recorderRowIsConfident(reg) ? reg!.matched : null}
        onLink={recorderRowIsConfident(reg) && reg!.matched!.event_key && !placeholder ? linkSuggested : undefined}
        busy={busy === 'link'}
      />
      <RecordingStrip
        model={model}
        noGlyph
        onAction={(k) => (k === 'retry' ? retry() : undefined)}
        disabled={disabled}
      />
      {err && <p className="text-[11px] text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <Button
          size="sm"
          variant="outline"
          className={iconBtn}
          disabled={disabled || placeholder}
          onClick={onLink}
          title="Link it to a calendar event — the meeting takes the invite's title, date and people"
          data-link-meeting
        >
          <Link2 className="h-3.5 w-3.5" />
          Link to meeting…
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={iconBtn}
          disabled={disabled || placeholder}
          onClick={() => {
            setName(row.title && !filename?.startsWith(row.title) ? row.title : '');
            setRenaming(true);
          }}
          title="Give it a title and it becomes a meeting of its own — then it can be shared"
          data-name-meeting
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          Make a meeting
        </Button>
        {temporary && (
          <Button
            size="sm"
            variant="outline"
            className={iconBtn}
            disabled={disabled || placeholder || busy === 'keep'}
            onClick={keep}
            title="Keep it — no expiry; it stays one of your recordings"
            data-keep-recording
          >
            {busy === 'keep' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
            Keep
          </Button>
        )}
        {!placeholder && (
          <Button size="sm" variant="ghost" className={iconBtn} onClick={() => router.push(`/transcript/${row.assemblyai_id}`)}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </Button>
        )}
        {row.access === 'owner' && (
          <Button
            size="sm"
            variant="ghost"
            className={`${iconBtn} ml-auto text-muted-foreground hover:text-destructive`}
            disabled={disabled || busy === 'trash'}
            onClick={trash}
            title={placeholder ? 'Cancel the upload' : 'Move to trash'}
          >
            {busy === 'trash' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        )}
        {row.status === 'uploading' && !live && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Upload className="h-3 w-3" /> in flight
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * One STANDALONE recording (design P7) — an upload born as a recording.
 * Actions (§3.1): Link to meeting… · Make a meeting · Keep (temporary only) ·
 * Open (its own page, recording mode) · Delete. Only the owner ever sees
 * this card. The recording is never shared; Link to meeting… makes a meeting
 * that is shared with the event's internal invitees (meeting policy).
 */
function RecordingCard({
  r,
  live,
  disabled,
  onLink,
  onChanged,
}: {
  r: RecordingViewWire;
  live: { pct: number; bytesSent?: number | null; bytesTotal?: number | null } | null;
  disabled: boolean;
  onLink: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'name' | 'link' | 'keep' | 'delete' | 'dismiss' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const title = recordingDisplayTitle(r, (iso) => shortWhen(iso));
  const model = stripForRecordingView(r, { live, fmtBytes: formatBytes, fmtDuration: formatDuration });
  // Link / Make a meeting are not gated on the upload or the transcription
  // (2026-09-30): the meeting is born now, its text lands when the
  // recording's does. Only a failed transcription has nothing to hand over.
  const linkable = r.status !== 'failed';

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(isNetworkFailure(e) ? OFFLINE_TITLE : e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };
  const call = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `Failed (${res.status})`);
    }
    return res;
  };
  const makeMeeting = () =>
    run('name', async () => {
      const t = name.trim();
      if (!t) return;
      await call(`/api/recordings/${r.id}/make-meeting`, 'POST', { title: t });
      setNaming(false);
      onChanged();
    });
  const linkSuggested = () =>
    run('link', async () => {
      if (!r.suggested_event) return;
      await call(`/api/recordings/${r.id}/link`, 'POST', { eventKey: r.suggested_event.key });
      onChanged();
    });
  const dismiss = () =>
    run('dismiss', async () => {
      await call(`/api/recordings/${r.id}`, 'PATCH', { dismissSuggestedEvent: true });
      onChanged();
    });
  const keep = () =>
    run('keep', async () => {
      await call(`/api/recordings/${r.id}`, 'PATCH', { keep: true });
      onChanged();
    });
  const remove = () =>
    run('delete', async () => {
      if (!window.confirm(`Delete this recording for good? Its file and transcript go too.\n\n${title}`)) return;
      await call(`/api/recordings/${r.id}`, 'DELETE');
      onChanged();
    });

  const meta = [
    shortWhen(r.started_at ?? r.created_at),
    r.part_count > 1 ? `${r.part_count} parts` : null,
    r.bytes ? formatBytes(r.bytes) : null,
    r.temporary ? expiresCopy(r.expires_at) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const iconBtn = 'h-7 gap-1 px-2 text-xs';
  const suggestion = r.suggested_event;

  return (
    <div
      className={cardCls()}
      data-recording-card={r.temporary ? 'temporary' : 'recording'}
      data-status={r.status}
      data-recording-id={r.id}
    >
      <div className="flex min-w-0 items-start gap-2">
        {r.temporary ? (
          <span title={r.original_filename ?? undefined} className="mt-1 shrink-0">
            <Hourglass className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" aria-label="Temporary" />
          </span>
        ) : (
          <SourceGlyph source={model.source} className="mt-1 h-3.5 w-3.5" title={r.original_filename ?? undefined} />
        )}
        <div className="min-w-0 flex-1">
          {naming ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void makeMeeting();
              }}
            >
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNaming(false);
                }}
                placeholder="Meeting title"
                className="h-7 text-sm"
                data-rename-input
              />
              <Button type="submit" size="sm" variant="default" className="h-7 px-2" disabled={busy === 'name' || !name.trim()}>
                {busy === 'name' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => setNaming(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </form>
          ) : (
            <p className="truncate text-sm font-medium" title={r.original_filename ?? undefined}>
              {title}
            </p>
          )}
          {!naming && meta && <p className="truncate text-[11px] text-muted-foreground">{meta}</p>}
        </div>
      </div>
      {suggestion && suggestion.title && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground" data-match-hint>
          <CalendarSearch className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">
            Looks like <span className="text-foreground/80">{suggestion.title}</span> ·{' '}
            {new Date(suggestion.startIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {linkable && (
            <button
              type="button"
              disabled={disabled || busy === 'link'}
              onClick={linkSuggested}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-primary/35 bg-primary/5 px-2 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-60"
              data-link-suggested
            >
              {busy === 'link' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
              Link to it
            </button>
          )}
          <button
            type="button"
            disabled={disabled || busy === 'dismiss'}
            onClick={dismiss}
            className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-[11px] hover:bg-muted disabled:opacity-60"
            data-dismiss-suggested
          >
            Not this
          </button>
        </div>
      )}
      <RecordingStrip model={model} noGlyph disabled={disabled} />
      {err && <p className="text-[11px] text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <Button
          size="sm"
          variant="outline"
          className={iconBtn}
          disabled={disabled || !linkable}
          onClick={onLink}
          title={linkable ? 'Link it to a calendar event — that makes it a meeting, shared with the Trames colleagues on the invite' : 'Its transcription failed — retry it first'}
          data-link-meeting
        >
          <Link2 className="h-3.5 w-3.5" />
          Link to meeting…
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={iconBtn}
          disabled={disabled || !linkable}
          onClick={() => {
            setName(r.title ?? '');
            setNaming(true);
          }}
          title={linkable ? 'Give it a title and it becomes a meeting of its own — then it can be shared' : 'Its transcription failed — retry it first'}
          data-name-meeting
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          Make a meeting
        </Button>
        {r.temporary && (
          <Button
            size="sm"
            variant="outline"
            className={iconBtn}
            disabled={disabled || busy === 'keep'}
            onClick={keep}
            title="Keep it — no expiry; it stays one of your recordings"
            data-keep-recording
          >
            {busy === 'keep' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
            Keep
          </Button>
        )}
        <Button size="sm" variant="ghost" className={iconBtn} onClick={() => router.push(`/recording/${r.id}`)}>
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={`${iconBtn} ml-auto text-muted-foreground hover:text-destructive`}
          disabled={disabled || busy === 'delete' || r.status === 'uploading'}
          onClick={remove}
          title="Delete for good"
          data-recording-delete
        >
          {busy === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * All view: the newest linked recordings under their own heading, after the
 * unlinked list — they need nothing from you, so they do not crowd it.
 */
export function LinkedGroup({
  items,
  count,
  onShowAll,
}: {
  items: RecordingsItemWire[];
  count: number;
  onShowAll: () => void;
}) {
  return (
    <section className="space-y-2 pt-2" data-linked-group aria-label="Linked to a meeting">
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Link2 className="h-3.5 w-3.5" />
          Linked to a meeting
          <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{count}</span>
        </h2>
        {count > items.length && (
          <button type="button" onClick={onShowAll} className="text-xs text-primary hover:underline" data-linked-show-all>
            Show all {count}
          </button>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {items.map((it) =>
          it.kind === 'recording' ? <LinkedCard key={itemKey(it)} r={it.recording} meetings={it.meetings ?? []} /> : null
        )}
      </div>
    </section>
  );
}

/**
 * One recording a meeting holds (section 'linked'). Its own facts — date,
 * duration, source app, size — the meeting(s) it is in, and two ways out:
 * Open meeting and Open recording. Nothing here links, unlinks or shares;
 * the meeting is where that happens.
 */
export function LinkedCard({ r, meetings }: { r: RecordingViewWire; meetings: LinkedMeetingWire[] }) {
  const title = recordingDisplayTitle(r, (iso) => shortWhen(iso));
  const facts = linkedRecordingFacts(r, {
    when: (iso) => shortWhen(iso),
    duration: formatDuration,
    bytes: formatBytes,
  });
  const first = meetings[0] ?? null;
  const linkCls = 'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors hover:bg-muted';
  return (
    <div className={cardCls()} data-recording-card="linked" data-recording-id={r.id}>
      <div className="flex min-w-0 items-start gap-2">
        <SourceGlyph
          source={r.source_kind === 'recorder' ? 'mac' : 'file'}
          className="mt-1 h-3.5 w-3.5"
          title={r.original_filename ?? undefined}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={r.original_filename ?? undefined}>
            {title}
          </p>
          {facts && <p className="truncate text-[11px] text-muted-foreground">{facts}</p>}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground" data-linked-meetings>
        {meetings.length > 0 ? (
          meetings.map((m) => (
            <span key={m.assemblyai_id} className="flex min-w-0 items-center gap-1.5">
              <Link2 className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">
                In <span className="text-foreground/80">{linkedMeetingLabel(m, (iso) => shortWhen(iso))}</span>
              </span>
            </span>
          ))
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <Link2 className="h-3 w-3 shrink-0" />
            In a meeting you can no longer open
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        {first && (
          <a
            href={`/transcript/${encodeURIComponent(first.assemblyai_id)}`}
            className={`${linkCls} border border-primary/35 bg-primary/5 text-primary hover:bg-primary/10`}
            data-open-meeting
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open meeting
          </a>
        )}
        <a href={`/recording/${encodeURIComponent(r.id)}`} className={`${linkCls} text-foreground`} data-open-recording>
          <ExternalLink className="h-3.5 w-3.5" />
          Open recording
        </a>
      </div>
    </div>
  );
}
