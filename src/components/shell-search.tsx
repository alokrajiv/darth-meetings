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
import { Clock, CornerDownLeft, Loader2, Search, X } from 'lucide-react';
import { LabelChip, labelDotColor } from '@/components/label-chips';
import { useLabelCatalog } from '@/hooks/use-label-catalog';
import { formatDuration, formatSmartDate, formatTime } from '@/lib/format';
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
import { searchInMeeting, type ScopeHit, type ScopeUtterance } from '@/lib/meeting-scope-search';
import {
  pushRecentSearch,
  removeRecentSearch,
  type RecentSearch,
  type RecentSearchScope,
} from '@/lib/recent-searches';
import { loadRecentSearches, saveRecentSearches } from '@/lib/recent-searches-store';
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
 * centred, over the page. Opens on the first non-empty query (or an empty
 * Enter: suggestions + Recent searches), follows the query live
 * (submit:false — the shell already debounces; the panel adds a short one for
 * the in-app field), runs at once on submit:true and then moves focus into the
 * results (↑/↓ move, Enter picks, Esc closes and clears; a typed character
 * goes back to the in-app field when that was the source). The keyboard
 * handed back by the shell (its ↓ key, or Esc) also lands in the results. A
 * cleared query keeps the panel open on its suggestions. Never two panels.
 *
 * Search scope, like Slack's `in:#channel` (2026-10-02): a meeting page
 * OFFERS its meeting (`useShellSearchScope`). The panel's first row is then
 * "Search in <title>", selected by default — so Enter from the band (or on
 * that row) applies the chip `in: <title>` and the query runs over that
 * meeting's transcript, client-side, over what the page shows (edits and
 * speaker names applied — lib/meeting-scope-search.ts; there is no
 * per-meeting server search). A hit jumps the page to that moment. The chip's
 * × (or Backspace in the results) removes it: the broad search across all
 * meetings, as before. The last five searches, with their chips, are kept as
 * "Recent searches" in the shell's local store (lib/recent-searches-store.ts).
 */

export const PANEL_DEBOUNCE_MS = 150;
const PANEL_MAX_W = 720;
/** A recent search for ANOTHER meeting navigates there first; its scope is
 * applied when that page offers it, if it does so within this long. */
const PENDING_SCOPE_MS = 30_000;

type Source = 'band' | 'field';

/** What a meeting page offers the panel (`useShellSearchScope`). */
export interface ShellSearchScopeOffer {
  /** Transcript route id. */
  id: string;
  /** The meeting's display title (the chip's text). */
  title: string;
  /** The utterances as the page shows them — read at search time. */
  utterances: () => ScopeUtterance[];
  /** Jump the page to an utterance (seek + scroll). */
  jump: (index: number) => void;
  /** Bump when the utterances change (edits, renames) so open results refresh. */
  version?: number;
}

interface OfferInfo {
  id: string;
  title: string;
  version: number;
}

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
  /** A meeting page offers its meeting as the search scope (again on every
   * title / version change). */
  registerScope: (offer: ShellSearchScopeOffer) => void;
  /** The page with this id is gone: no offer (unless another page took over). */
  unregisterScope: (id: string) => void;
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
  registerScope: () => {},
  unregisterScope: () => {},
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

/**
 * A meeting page offers its meeting as the search scope while mounted (only
 * inside the shell does anything listen). `offer` may be a fresh object every
 * render: the provider is told again only when id / title / version change,
 * and the functions are read through a ref at call time.
 */
export function useShellSearchScope(offer: ShellSearchScopeOffer | null): void {
  const { registerScope, unregisterScope, inDesktopShell } = useShellSearch();
  const latest = useRef(offer);
  useEffect(() => {
    latest.current = offer;
  });
  const id = offer?.id ?? null;
  const title = offer?.title ?? '';
  const version = offer?.version ?? 0;
  // Withdrawn only when the page goes (or the id changes) — a title / version
  // change re-registers without a gap, so an applied chip survives an edit.
  useEffect(() => {
    if (!inDesktopShell || id === null) return;
    return () => unregisterScope(id);
  }, [inDesktopShell, unregisterScope, id]);
  useEffect(() => {
    if (!inDesktopShell || id === null) return;
    registerScope({
      id,
      title,
      version,
      utterances: () => latest.current?.utterances() ?? [],
      jump: (index) => latest.current?.jump(index),
    });
  }, [inDesktopShell, registerScope, id, title, version]);
}

export function ShellSearchProvider({
  inDesktopShell,
  children,
}: {
  inDesktopShell: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const queryRef = useRef('');
  queryRef.current = query;
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

  // Scope: what the current page offers, and the chip when applied.
  const offerRef = useRef<ShellSearchScopeOffer | null>(null);
  const [offer, setOffer] = useState<OfferInfo | null>(null);
  const [scope, setScopeState] = useState<RecentSearchScope | null>(null);
  const scopeRef = useRef<RecentSearchScope | null>(null);
  const setScope = useCallback((s: RecentSearchScope | null) => {
    scopeRef.current = s;
    setScopeState(s);
  }, []);
  // The chip was removed in this open: a later Enter does not put it back.
  const scopeDismissed = useRef(false);
  const pendingRef = useRef<{ id: string; q: string; at: number } | null>(null);

  // Recent searches (loaded on the first open, then kept in memory).
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const recentsRef = useRef<RecentSearch[]>([]);
  const recentsLoaded = useRef(false);
  const ensureRecents = useCallback(() => {
    if (recentsLoaded.current) return;
    recentsLoaded.current = true;
    void loadRecentSearches().then((list) => {
      // A search remembered before the load landed stays on top.
      const merged = recentsRef.current.reduce((acc, r) => pushRecentSearch(acc, r), list);
      recentsRef.current = merged;
      setRecents(merged);
    });
  }, []);
  const remember = useCallback((q: string, s: RecentSearchScope | null) => {
    if (!q.trim()) return;
    const next = pushRecentSearch(recentsRef.current, { q, scope: s, at: Date.now() });
    recentsRef.current = next;
    setRecents(next);
    void saveRecentSearches(next);
  }, []);
  const forget = useCallback((r: RecentSearch) => {
    const next = removeRecentSearch(recentsRef.current, r);
    recentsRef.current = next;
    setRecents(next);
    void saveRecentSearches(next);
  }, []);

  const openPanel = useCallback(() => {
    openRef.current = true;
    setOpen(true);
    setOpenSeq((n) => n + 1);
    setSubmitted(null);
    setScope(null);
    scopeDismissed.current = false;
    ensureRecents();
  }, [ensureRecents, setScope]);

  /** Run `q` now (as if submitted) under `s`, opening the panel if needed. */
  const runNow = useCallback(
    (q: string, s: RecentSearchScope | null) => {
      if (!openRef.current) openPanel();
      setScope(s);
      setQuery(q);
      setSubmitted(q.trim());
      setSubmitSeq((n) => n + 1);
      remember(q, s);
    },
    [openPanel, remember, setScope]
  );

  const drive = useCallback(
    (detail: ShellSearchDetail, src: Source) => {
      const action = shellSearchAction(openRef.current, detail);
      if (action === 'ignore') {
        // Closed + empty: nothing to show, but the in-app field still echoes.
        setQuery(detail.query);
        return;
      }
      if (action === 'open') openPanel();
      setSource(src);
      setQuery(detail.query);
      if (detail.submit) {
        const q = detail.query.trim();
        let s = scopeRef.current;
        // Enter picks the first row — "Search in <this meeting>" when the
        // page offers one and the chip was not just removed.
        const o = offerRef.current;
        if (q && !s && o && !scopeDismissed.current) {
          s = { id: o.id, title: o.title };
          setScope(s);
        }
        setSubmitted(q);
        setSubmitSeq((n) => n + 1);
        if (q) remember(q, s);
      }
    },
    [openPanel, remember, setScope]
  );

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setQuery('');
    setSubmitted(null);
    setScope(null);
  }, [setScope]);

  const registerScope = useCallback(
    (o: ShellSearchScopeOffer) => {
      offerRef.current = o;
      setOffer({ id: o.id, title: o.title, version: o.version ?? 0 });
      const s = scopeRef.current;
      // The chip only ever names the meeting on screen.
      if (s && o.id !== s.id) setScope(null);
      else if (s && o.title !== s.title) setScope({ id: o.id, title: o.title });
      const p = pendingRef.current;
      if (!p) return;
      pendingRef.current = null;
      if (p.id === o.id && Date.now() - p.at < PENDING_SCOPE_MS) runNow(p.q, { id: o.id, title: o.title });
    },
    [runNow, setScope]
  );

  const unregisterScope = useCallback(
    (id: string) => {
      if (offerRef.current?.id !== id) return;
      offerRef.current = null;
      setOffer(null);
      if (scopeRef.current) setScope(null);
    },
    [setScope]
  );

  const applyScope = useCallback(() => {
    const o = offerRef.current;
    if (!o) return;
    const s = { id: o.id, title: o.title };
    setScope(s);
    scopeDismissed.current = false;
    if (queryRef.current.trim()) remember(queryRef.current, s);
  }, [remember, setScope]);

  const clearScope = useCallback(() => {
    setScope(null);
    scopeDismissed.current = true;
  }, [setScope]);

  const pickRecent = useCallback(
    (r: RecentSearch) => {
      if (!r.scope) {
        runNow(r.q, null);
        return;
      }
      const o = offerRef.current;
      if (o && o.id === r.scope.id) {
        runNow(r.q, { id: o.id, title: o.title });
        return;
      }
      // Another meeting: go there; its page offers the scope and the search
      // runs then (registerScope). Meanwhile the panel says where it's going.
      pendingRef.current = { id: r.scope.id, q: r.q, at: Date.now() };
      setQuery(r.q);
      setSubmitted(null);
      router.push(`/transcript/${encodeURIComponent(r.scope.id)}`);
    },
    [router, runNow]
  );

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
        ? {
            inDesktopShell,
            open,
            query,
            drive,
            close,
            focusResults,
            registerField,
            onToggleSidebar,
            registerScope,
            unregisterScope,
          }
        : NOOP_API,
    [inDesktopShell, open, query, drive, close, focusResults, registerField, onToggleSidebar, registerScope, unregisterScope]
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
          offer={offer}
          offerRef={offerRef}
          scope={scope}
          onApplyScope={applyScope}
          onClearScope={clearScope}
          recents={recents}
          onPickRecent={pickRecent}
          onForgetRecent={forget}
          onRemember={remember}
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

/** One keyboard-selectable row of the panel. */
type PanelItem =
  | { kind: 'scope' }
  | { kind: 'recent'; recent: RecentSearch }
  | { kind: 'hit'; hit: MeetingSearchHit }
  | { kind: 'line'; line: ScopeHit };

export function MeetingSearchPanel({
  query,
  submitted,
  submitSeq,
  focusSeq,
  source,
  fieldRef,
  onClose,
  offer = null,
  offerRef,
  scope = null,
  onApplyScope = () => {},
  onClearScope = () => {},
  recents = [],
  onPickRecent = () => {},
  onForgetRecent = () => {},
  onRemember = () => {},
}: {
  query: string;
  submitted: string | null;
  submitSeq: number;
  focusSeq: number;
  source: Source;
  fieldRef: RefObject<RefObject<HTMLInputElement | null> | null>;
  onClose: () => void;
  offer?: OfferInfo | null;
  offerRef?: RefObject<ShellSearchScopeOffer | null>;
  scope?: RecentSearchScope | null;
  onApplyScope?: () => void;
  onClearScope?: () => void;
  recents?: RecentSearch[];
  onPickRecent?: (r: RecentSearch) => void;
  onForgetRecent?: (r: RecentSearch) => void;
  onRemember?: (q: string, s: RecentSearchScope | null) => void;
}) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<MeetingSearchHit[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const text = query.trim();
  const usable = shapeMeetingSearch(text) !== null;
  const runNow = submitted !== null && submitted === text;
  const scoped = scope !== null && offer !== null && offer.id === scope.id;
  const [status, setStatus] = useState<Status>(() => (usable && !scoped ? 'loading' : 'idle'));
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

  // In this meeting: computed here, synchronously, from the page's text.
  const offerVersion = offer?.version ?? 0;
  const scopedResult = useMemo(() => {
    if (!scoped || !usable) return null;
    const utts = offerRef?.current?.utterances() ?? [];
    return searchInMeeting(utts, text);
    // offerVersion: the page's text changed (edits) — recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, usable, text, offerVersion, offerRef]);
  useEffect(() => {
    if (!scoped) return;
    setSelected(0);
    setAnsweredSeq(submitSeq);
  }, [scoped, scopedResult, submitSeq]);

  // All meetings: the query → GET /api/search. Unusable (empty / 1-char
  // words) → idle, no request.
  useEffect(() => {
    if (scoped) return;
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
  }, [text, usable, runNow, submitSeq, scoped]);

  // The rows the keyboard walks, in display order.
  const showHits = !scoped && (status === 'done' || (status === 'loading' && hits.length > 0));
  const items = useMemo<PanelItem[]>(() => {
    if (scoped) return (scopedResult?.hits ?? []).map((line) => ({ kind: 'line' as const, line }));
    const out: PanelItem[] = [];
    if (offer) out.push({ kind: 'scope' });
    if (!text) for (const recent of recents) out.push({ kind: 'recent', recent });
    if (showHits) for (const hit of hits) out.push({ kind: 'hit', hit });
    return out;
  }, [scoped, scopedResult, offer, text, recents, showHits, hits]);
  const sel = items.length ? Math.min(selected, items.length - 1) : -1;

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
  // The shell handed the keyboard to the page (its ↓ key, Esc): it lands in
  // the results, not on whatever the page had focused before (an editable
  // utterance would swallow the arrows). After the browser's own focus
  // restore (next tick). A click into the page also focuses the window: the
  // click itself then closes the panel or lands inside it, as before.
  useEffect(() => {
    if (source !== 'band') return;
    let t: number | null = null;
    const onFocus = () => {
      if (t !== null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        if (!panel.current?.contains(document.activeElement)) list.current?.focus();
      }, 0);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (t !== null) window.clearTimeout(t);
    };
  }, [source]);

  const go = useCallback(
    (hit: MeetingSearchHit) => {
      if (text) onRemember(text, null);
      router.push(`/transcript/${encodeURIComponent(hit.id)}`);
      onClose();
    },
    [router, onClose, onRemember, text]
  );

  const jump = useCallback(
    (line: ScopeHit) => {
      if (text && scope) onRemember(text, scope);
      offerRef?.current?.jump(line.index);
      onClose();
    },
    [offerRef, onClose, onRemember, scope, text]
  );

  const pick = useCallback(
    (item: PanelItem) => {
      if (item.kind === 'scope') {
        onApplyScope();
        list.current?.focus();
      } else if (item.kind === 'recent') onPickRecent(item.recent);
      else if (item.kind === 'hit') go(item.hit);
      else jump(item.line);
    },
    [go, jump, onApplyScope, onPickRecent]
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
        if (!items.length) return;
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((i) => (Math.min(i, items.length - 1) + d + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter') {
        const item = items[sel] ?? items[0];
        if (item) {
          e.preventDefault();
          pick(item);
        }
        return;
      }
      // Backspace removes the `in:` chip, like an empty Slack search box.
      if (e.key === 'Backspace' && scoped) {
        e.preventDefault();
        onClearScope();
        return;
      }
      // A typed character goes back to the in-app field when it drove us.
      if (source === 'field' && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        fieldRef.current?.current?.focus();
      }
    },
    [items, sel, pick, onClose, scoped, onClearScope, source, fieldRef]
  );

  // Keep the selected row in view while arrowing.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-item-index="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const activeId = sel >= 0 ? `meeting-search-item-${sel}` : undefined;
  const scopedTotal = scopedResult?.total ?? 0;
  let index = -1;
  const nextIndex = () => ++index;

  const summary = scoped ? (
    text ? (
      usable ? (
        <>
          {`${scopedTotal} match${scopedTotal === 1 ? '' : 'es'} for `}
          <span className="font-medium text-foreground">“{text}”</span>
        </>
      ) : (
        'Type at least 2 characters'
      )
    ) : (
      'Type to search this meeting'
    )
  ) : text ? (
    <>
      {status === 'done'
        ? `${hits.length >= SEARCH_HIT_LIMIT ? `${SEARCH_HIT_LIMIT}+` : hits.length} result${hits.length === 1 ? '' : 's'} for `
        : 'Searching for '}
      <span className="font-medium text-foreground">“{text}”</span>
    </>
  ) : (
    'Search meeting titles, notes and transcripts'
  );

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
          {status === 'loading' && !scoped ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          ) : (
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {scoped && scope && <ScopeChip title={scope.title} onRemove={onClearScope} />}
          <span className="min-w-0 flex-1 truncate" data-testid="meeting-search-summary">
            {summary}
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
          aria-label={scoped ? 'Matches in this meeting' : 'Meetings'}
          aria-activedescendant={activeId}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          data-testid="meeting-search-results"
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5 outline-none"
        >
          {scoped ? (
            <>
              {text && usable && scopedTotal === 0 && (
                <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="meeting-search-none">
                  Nothing in this meeting matches. Backspace removes the chip to search all meetings.
                </div>
              )}
              {!text && (
                <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="meeting-search-scope-empty">
                  Searches what this meeting&apos;s transcript says, as shown on the page.
                </div>
              )}
              {scopedResult?.hits.map((line) => {
                const i = nextIndex();
                return (
                  <ScopeLineRow
                    key={line.index}
                    index={i}
                    line={line}
                    selected={i === sel}
                    onSelect={() => jump(line)}
                    onHover={() => setSelected(i)}
                  />
                );
              })}
              {scopedResult && scopedResult.total > scopedResult.hits.length && (
                <div className="px-3 py-2 text-[11px] text-muted-foreground">
                  First {scopedResult.hits.length} of {scopedResult.total} — add a word to narrow it down.
                </div>
              )}
            </>
          ) : (
            <>
              {offer &&
                (() => {
                  const i = nextIndex();
                  return (
                    <ScopeSuggestionRow
                      index={i}
                      title={offer.title}
                      query={text}
                      selected={i === sel}
                      onSelect={() => pick({ kind: 'scope' })}
                      onHover={() => setSelected(i)}
                    />
                  );
                })()}
              {!text && recents.length > 0 && (
                <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Recent searches
                </div>
              )}
              {!text &&
                recents.map((r) => {
                  const i = nextIndex();
                  return (
                    <RecentSearchRow
                      key={`${r.scope?.id ?? ''}|${r.q}`}
                      index={i}
                      recent={r}
                      selected={i === sel}
                      onSelect={() => onPickRecent(r)}
                      onForget={() => onForgetRecent(r)}
                      onHover={() => setSelected(i)}
                    />
                  );
                })}
              {offer && text && showHits && hits.length > 0 && (
                <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  All meetings
                </div>
              )}
              {status === 'idle' && text && !usable && (
                <div className="px-3 py-3 text-xs text-muted-foreground">Type at least 2 characters.</div>
              )}
              {status === 'idle' && !text && !offer && recents.length === 0 && (
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
              {showHits &&
                hits.map((hit) => {
                  const i = nextIndex();
                  return (
                    <MeetingHitRow
                      key={hit.id}
                      index={i}
                      hit={hit}
                      terms={terms}
                      selected={i === sel}
                      onSelect={() => go(hit)}
                      onHover={() => setSelected(i)}
                    />
                  );
                })}
            </>
          )}
        </div>
        {items.length > 0 && (
          <div className="hidden border-t px-3 py-1.5 text-[11px] text-muted-foreground sm:block">
            {scoped
              ? '↑ ↓ to move · Enter to jump there · Backspace for all meetings · Esc to close'
              : '↑ ↓ to move · Enter to open · Esc to close'}
          </div>
        )}
      </div>
    </div>
  );
}

/** The `in: <meeting>` chip in the panel's header; × = all meetings again. */
export function ScopeChip({ title, onRemove }: { title: string; onRemove: () => void }) {
  return (
    <span
      className="inline-flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-md bg-primary/10 py-0.5 pl-1.5 pr-0.5 text-[11px] font-medium text-primary"
      data-testid="meeting-search-scope-chip"
    >
      <span className="shrink-0 opacity-70">in:</span>
      <span className="min-w-0 truncate" title={title}>
        {title}
      </span>
      <button
        type="button"
        aria-label={`Remove “in: ${title}” — search all meetings`}
        title="Search all meetings"
        onClick={onRemove}
        className="grid h-4 w-4 shrink-0 place-items-center rounded hover:bg-primary/15"
        data-testid="meeting-search-scope-remove"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/** First row on a meeting page: "Search in <title>" (Enter picks it). */
export function ScopeSuggestionRow({
  index,
  title,
  query,
  selected,
  onSelect,
  onHover,
}: {
  index: number;
  title: string;
  query: string;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      id={`meeting-search-item-${index}`}
      aria-selected={selected}
      data-testid="meeting-search-scope-suggestion"
      data-item-index={index}
      onClick={onSelect}
      onMouseEnter={onHover}
      tabIndex={-1}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        Search in <span className="font-medium">{title}</span>
        {query && <span className="text-muted-foreground"> for “{query}”</span>}
      </span>
      {selected && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Enter" />}
    </button>
  );
}

/** A Recent searches row: clock, the chip when scoped, the query, × forget. */
export function RecentSearchRow({
  index,
  recent,
  selected,
  onSelect,
  onForget,
  onHover,
}: {
  index: number;
  recent: RecentSearch;
  selected: boolean;
  onSelect: () => void;
  onForget: () => void;
  onHover: () => void;
}) {
  return (
    <div
      role="option"
      id={`meeting-search-item-${index}`}
      aria-selected={selected}
      data-testid="meeting-search-recent"
      data-item-index={index}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'group/recent flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
    >
      <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {recent.scope && (
        <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          <span className="shrink-0 opacity-70">in:</span>
          <span className="min-w-0 truncate">{recent.scope.title || 'a meeting'}</span>
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{recent.q}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Forget “${recent.q}”`}
        title="Remove from recent searches"
        onClick={(e) => {
          e.stopPropagation();
          onForget();
        }}
        className={cn(
          'grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground',
          selected ? 'opacity-100' : 'opacity-0 group-hover/recent:opacity-100'
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** A match inside the scoped meeting: time · speaker, the snippet. */
export function ScopeLineRow({
  index,
  line,
  selected,
  onSelect,
  onHover,
}: {
  index: number;
  line: ScopeHit;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      id={`meeting-search-item-${index}`}
      aria-selected={selected}
      data-testid="meeting-search-line"
      data-item-index={index}
      data-utterance={line.index}
      onClick={onSelect}
      onMouseEnter={onHover}
      tabIndex={-1}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0 font-mono tabular-nums">{formatTime(line.startMs)}</span>
        <span className="min-w-0 truncate font-medium text-foreground/80">{line.speaker}</span>
      </span>
      <span className="line-clamp-2 break-words text-xs" data-testid="meeting-search-line-snippet">
        {!line.snippet.atStart && '…'}
        <Highlighted text={line.snippet.text} ranges={line.snippet.ranges} />
        {!line.snippet.atEnd && '…'}
      </span>
    </button>
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
      id={`meeting-search-item-${index}`}
      aria-selected={selected}
      data-testid="meeting-search-hit"
      data-hit-index={index}
      data-item-index={index}
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
