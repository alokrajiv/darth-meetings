'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';
import { LabelChip, labelDotColor } from '@/components/label-chips';
import { useLabelCatalog } from '@/hooks/use-label-catalog';
import { formatDuration, formatSmartDate } from '@/lib/format';
import { meetingTitleOf } from '@/lib/meeting-title';
import {
  MATCHED_IN_LABEL,
  SEARCH_HIT_LIMIT,
  matchRanges,
  shapeMeetingSearch,
  splitByRanges,
  type MatchRange,
  type MeetingSearchHit,
  type MeetingSearchResponse,
} from '@/lib/meeting-search';
import { shellSearchAction, useShellSignals, type ShellSearchDetail } from '@/lib/shell-signals';
import { cn } from '@/lib/utils';

/**
 * Darth desktop shell search (README "Darth desktop shell").
 *
 * Inside the shell (`inDesktopShell`, decided at SSR from the UA) the shell's
 * title-band search field drives a results panel through `darth-shell:search`
 * window events; the in-app "Search meetings…" field feeds the SAME panel
 * (`useShellSearch().drive`), so both paths look identical. Outside the shell
 * the provider renders nothing extra and registers no listener — the in-app
 * field keeps filtering the listing as it always did.
 *
 * The panel: anchored under the app header, full content width up to 720 px,
 * centred, over the page. Opens on the first non-empty query, follows the
 * query live (submit:false — the shell already debounces; the panel adds a
 * short one for the in-app field), runs at once on submit:true and then moves
 * focus into the results (↑/↓ move, Enter opens the meeting, Esc closes and
 * clears; a typed character goes back to the in-app field when that was the
 * source). A cleared query keeps the panel open on its empty state. Never two
 * panels: one provider, one panel.
 */

export const PANEL_DEBOUNCE_MS = 150;
const PANEL_MAX_W = 720;

type Source = 'band' | 'field';

interface ShellSearchApi {
  inDesktopShell: boolean;
  open: boolean;
  query: string;
  /** Feed one search event (the band's, or the in-app field's). */
  drive: (detail: ShellSearchDetail, source: Source) => void;
  close: () => void;
  /** Move focus into the results (↓ from the in-app field). */
  focusResults: () => void;
  /** The in-app field registers itself: typed characters in the results go
   * back to it, and clicks on it never count as "outside the panel". */
  registerField: (ref: RefObject<HTMLInputElement | null> | null) => void;
  /** The band's sidebar button; returns the unsubscribe. */
  onToggleSidebar: (fn: () => void) => () => void;
}

const NOOP_API: ShellSearchApi = {
  inDesktopShell: false,
  open: false,
  query: '',
  drive: () => {},
  close: () => {},
  focusResults: () => {},
  registerField: () => {},
  onToggleSidebar: () => () => {},
};

const ShellSearchContext = createContext<ShellSearchApi>(NOOP_API);

export function useShellSearch(): ShellSearchApi {
  return useContext(ShellSearchContext);
}

/** Runs `fn` on the band's sidebar button (inside the shell only). */
export function useShellToggleSidebar(fn: () => void): void {
  const { onToggleSidebar } = useShellSearch();
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => onToggleSidebar(() => latest.current()), [onToggleSidebar]);
}

export function ShellSearchProvider({
  inDesktopShell,
  children,
}: {
  inDesktopShell: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Per-open key (a fresh panel per open), submit counter + the query it
  // submitted, and a counter for "focus the results now" (↓ from the field).
  const [openSeq, setOpenSeq] = useState(0);
  const [submitSeq, setSubmitSeq] = useState(0);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [focusSeq, setFocusSeq] = useState(0);
  const [source, setSource] = useState<Source>('band');
  const openRef = useRef(false);
  openRef.current = open;
  const fieldRef = useRef<RefObject<HTMLInputElement | null> | null>(null);
  const sidebarFns = useRef(new Set<() => void>());

  const drive = useCallback((detail: ShellSearchDetail, src: Source) => {
    const action = shellSearchAction(openRef.current, detail);
    if (action === 'ignore') {
      // Closed + empty: nothing to show, but the in-app field still echoes.
      setQuery(detail.query);
      return;
    }
    if (action === 'open') {
      openRef.current = true;
      setOpen(true);
      setOpenSeq((n) => n + 1);
      setSubmitted(null);
    }
    setSource(src);
    setQuery(detail.query);
    if (detail.submit) {
      setSubmitted(detail.query.trim());
      setSubmitSeq((n) => n + 1);
    }
  }, []);

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setQuery('');
    setSubmitted(null);
  }, []);

  const focusResults = useCallback(() => setFocusSeq((n) => n + 1), []);
  const registerField = useCallback((ref: RefObject<HTMLInputElement | null> | null) => {
    fieldRef.current = ref;
  }, []);
  const onToggleSidebar = useCallback((fn: () => void) => {
    sidebarFns.current.add(fn);
    return () => {
      sidebarFns.current.delete(fn);
    };
  }, []);

  useShellSignals(inDesktopShell, {
    search: (detail) => drive(detail, 'band'),
    toggleSidebar: () => {
      for (const fn of sidebarFns.current) fn();
    },
  });

  const api = useMemo<ShellSearchApi>(
    () =>
      inDesktopShell
        ? { inDesktopShell, open, query, drive, close, focusResults, registerField, onToggleSidebar }
        : NOOP_API,
    [inDesktopShell, open, query, drive, close, focusResults, registerField, onToggleSidebar]
  );

  return (
    <ShellSearchContext.Provider value={api}>
      {children}
      {inDesktopShell && open && (
        <MeetingSearchPanel
          key={openSeq}
          query={query}
          submitted={submitted}
          submitSeq={submitSeq}
          focusSeq={focusSeq}
          source={source}
          fieldRef={fieldRef}
          onClose={close}
        />
      )}
    </ShellSearchContext.Provider>
  );
}

type Status = 'idle' | 'loading' | 'done' | 'error';

/** Bottom edge of the sticky app header (the panel hangs just under it). */
function headerBottom(): number {
  if (typeof document === 'undefined') return 56;
  const h = document.querySelector('header');
  const b = h?.getBoundingClientRect().bottom;
  return typeof b === 'number' && Number.isFinite(b) ? Math.max(0, b) : 56;
}

export function MeetingSearchPanel({
  query,
  submitted,
  submitSeq,
  focusSeq,
  source,
  fieldRef,
  onClose,
}: {
  query: string;
  submitted: string | null;
  submitSeq: number;
  focusSeq: number;
  source: Source;
  fieldRef: RefObject<RefObject<HTMLInputElement | null> | null>;
  onClose: () => void;
}) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<MeetingSearchHit[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const text = query.trim();
  const usable = shapeMeetingSearch(text) !== null;
  const runNow = submitted !== null && submitted === text;
  const [status, setStatus] = useState<Status>(() => (usable ? 'loading' : 'idle'));
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState(56);
  // The submit counter the latest answer belongs to: focus moves into the
  // results only once THAT submit's answer is in, never on a stale list.
  const [answeredSeq, setAnsweredSeq] = useState(-1);

  // Placement: under the header, following it while banners scroll away.
  useEffect(() => {
    const place = () => setTop(headerBottom());
    place();
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
    };
  }, []);

  // The query → results. Unusable (empty / 1-char words) → idle, no request.
  useEffect(() => {
    const seq = submitSeq;
    if (!usable) {
      setHits([]);
      setTerms([]);
      setStatus('idle');
      setError(null);
      setSelected(0);
      setAnsweredSeq(seq);
      return;
    }
    setStatus('loading');
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        fetch(`/api/search?q=${encodeURIComponent(text)}`, {
          credentials: 'include',
          signal: controller.signal,
        })
          .then(async (res) => {
            if (!res.ok) {
              const body = (await res.json().catch(() => null)) as { error?: string } | null;
              throw new Error(body?.error || `Search failed (${res.status})`);
            }
            return (await res.json()) as MeetingSearchResponse;
          })
          .then((r) => {
            if (controller.signal.aborted) return;
            setHits(r.hits);
            setTerms(r.terms);
            setSelected(0);
            setError(null);
            setStatus('done');
            setAnsweredSeq(seq);
          })
          .catch((err: unknown) => {
            if (controller.signal.aborted) return;
            setHits([]);
            setError(
              err instanceof Error && err.message !== 'Failed to fetch'
                ? err.message
                : "Search needs the server — you're offline."
            );
            setStatus('error');
            setAnsweredSeq(seq);
          });
      },
      runNow ? 0 : PANEL_DEBOUNCE_MS
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, usable, runNow, submitSeq]);

  // Submit (Enter) → once its answer is in, focus moves into the results.
  // ↓ from the in-app field → focus now.
  // (A fresh panel per open starts at 0, and an open resets `submitted`, so a
  // stale counter from an earlier open never steals focus.)
  const focusedSubmit = useRef(0);
  useEffect(() => {
    // `runNow`: the query is still the submitted one — typing on after Enter
    // keeps the focus where the typing is.
    if (!runNow || answeredSeq !== submitSeq || submitSeq === focusedSubmit.current) return;
    focusedSubmit.current = submitSeq;
    list.current?.focus();
  }, [answeredSeq, submitSeq, runNow]);
  const focusedSeq = useRef(focusSeq);
  useEffect(() => {
    if (focusSeq === focusedSeq.current) return;
    focusedSeq.current = focusSeq;
    list.current?.focus();
  }, [focusSeq]);

  const go = useCallback(
    (hit: MeetingSearchHit) => {
      router.push(`/transcript/${encodeURIComponent(hit.id)}`);
      onClose();
    },
    [router, onClose]
  );

  // Esc anywhere in the page closes; a press outside the panel (and outside
  // the in-app field) closes too.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panel.current?.contains(t)) return;
      if (fieldRef.current?.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, fieldRef]);

  const onListKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!hits.length) return;
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((i) => (i + d + hits.length) % hits.length);
        return;
      }
      if (e.key === 'Enter') {
        const hit = hits[selected] ?? hits[0];
        if (hit) {
          e.preventDefault();
          go(hit);
        }
        return;
      }
      // A typed character goes back to the in-app field when it drove us.
      if (source === 'field' && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        fieldRef.current?.current?.focus();
      }
    },
    [hits, selected, go, onClose, source, fieldRef]
  );

  // Keep the selected row in view while arrowing.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-hit-index="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const activeId = hits.length ? `meeting-search-hit-${Math.min(selected, hits.length - 1)}` : undefined;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4"
      style={{ top: top + 8 }}
      data-testid="meeting-search-layer"
    >
      <div
        ref={panel}
        role="dialog"
        aria-label="Search results"
        data-testid="meeting-search-panel"
        className="pointer-events-auto flex max-h-[min(72vh,680px)] w-full flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-[0_12px_32px_-8px_rgb(0_0_0/0.18),0_2px_6px_0_rgb(0_0_0/0.06)]"
        style={{ maxWidth: PANEL_MAX_W }}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
          {status === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          ) : (
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate" data-testid="meeting-search-summary">
            {text ? (
              <>
                {status === 'done'
                  ? `${hits.length >= SEARCH_HIT_LIMIT ? `${SEARCH_HIT_LIMIT}+` : hits.length} result${hits.length === 1 ? '' : 's'} for `
                  : 'Searching for '}
                <span className="font-medium text-foreground">“{text}”</span>
              </>
            ) : (
              'Search meeting titles, notes and transcripts'
            )}
          </span>
          <kbd className="hidden rounded border bg-muted px-1 font-sans text-[10px] sm:inline">Esc</kbd>
          <button
            type="button"
            aria-label="Close search"
            title="Close"
            data-testid="meeting-search-close"
            onClick={onClose}
            className="-mr-1 rounded-md p-1 hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          ref={list}
          role="listbox"
          id="meeting-search-results"
          aria-label="Meetings"
          aria-activedescendant={activeId}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          data-testid="meeting-search-results"
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5 outline-none"
        >
          {status === 'idle' && text && !usable && (
            <div className="px-3 py-3 text-xs text-muted-foreground">Type at least 2 characters.</div>
          )}
          {status === 'idle' && !text && (
            <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="meeting-search-empty-query">
              Matches titles, file names, descriptions, AI notes and full transcript text.
            </div>
          )}
          {status === 'done' && hits.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="meeting-search-none">
              No meetings match.
            </div>
          )}
          {status === 'error' && error && (
            <div role="alert" className="px-3 py-3 text-xs text-destructive">
              {error}
            </div>
          )}
          {(status === 'done' || (status === 'loading' && hits.length > 0)) &&
            hits.map((hit, i) => (
              <MeetingHitRow
                key={hit.id}
                index={i}
                hit={hit}
                terms={terms}
                selected={i === selected}
                onSelect={() => go(hit)}
                onHover={() => setSelected(i)}
              />
            ))}
        </div>
        {hits.length > 0 && (
          <div className="hidden border-t px-3 py-1.5 text-[11px] text-muted-foreground sm:block">
            ↑ ↓ to move · Enter to open · Esc to close
          </div>
        )}
      </div>
    </div>
  );
}

/** One result row — title (bold matches), date; meta (owner · duration ·
 * where it matched · labels); the snippet with the matched words bold. */
export function MeetingHitRow({
  hit,
  index,
  terms,
  selected,
  onSelect,
  onHover,
}: {
  hit: MeetingSearchHit;
  index: number;
  terms: readonly string[];
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const { byId } = useLabelCatalog();
  const title = meetingTitleOf({
    title: hit.title,
    original_filename: hit.original_filename,
    has_event: hit.has_event,
    scratch: false,
    deleted_at: null,
    recorded_at: hit.recorded_at,
    created_at: hit.created_at,
    recorder_recording_id: hit.recorder_recording_id,
    source: hit.source,
    provider: hit.provider,
  });
  const titleRanges = title.kind === 'title' ? matchRanges(title.primary, terms) : [];
  const owner = hit.owner ? hit.owner.name || hit.owner.email : hit.access === 'owner' ? 'You' : 'Shared with you';
  const meta = [owner, hit.duration ? formatDuration(hit.duration) : null, `in ${MATCHED_IN_LABEL[hit.matched_in]}`]
    .filter(Boolean)
    .join(' · ');
  const shownLabels = hit.labels.slice(0, 2);
  const moreLabels = hit.labels.length - shownLabels.length;
  return (
    <button
      type="button"
      role="option"
      id={`meeting-search-hit-${index}`}
      aria-selected={selected}
      data-testid="meeting-search-hit"
      data-hit-index={index}
      data-meeting-id={hit.id}
      onClick={onSelect}
      onMouseEnter={onHover}
      tabIndex={-1}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={title.filename ?? undefined}>
          <Highlighted text={title.primary} ranges={titleRanges} />
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={new Date(hit.at).toLocaleString()}>
          {formatSmartDate(hit.at)}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate" data-testid="meeting-search-meta">
          {meta}
        </span>
        {shownLabels.map((l) => (
          <LabelChip key={l.id} label={l} color={labelDotColor(l, byId)} />
        ))}
        {moreLabels > 0 && <span className="shrink-0">+{moreLabels}</span>}
      </span>
      {hit.snippet && hit.snippet.text && (
        <span className="line-clamp-2 break-words text-xs text-muted-foreground" data-testid="meeting-search-snippet">
          {!hit.snippet.atStart && '…'}
          <Highlighted text={hit.snippet.text} ranges={hit.snippet.ranges} />
          {!hit.snippet.atEnd && '…'}
        </span>
      )}
    </button>
  );
}

/** `text` with `ranges` as <mark class="search-match"> — bold foreground, no tint (globals.css). */
export function Highlighted({ text, ranges }: { text: string; ranges: readonly MatchRange[] }) {
  return (
    <>
      {splitByRanges(text, ranges).map((p, i) =>
        p.match ? (
          <mark key={i} className="search-match">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}
