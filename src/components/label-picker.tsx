'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownLeft, Loader2, Plus } from 'lucide-react';
import type { LabelRef } from '@/lib/format';
import {
  buildTree,
  flattenTree,
  joinPath,
  matchesLabelQuery,
  pathKeyOf,
  splitPath,
  validatePath,
  type LabelRow,
} from '@/lib/labels';
import { refreshLabelCatalog, useLabelCatalog } from '@/hooks/use-label-catalog';
import { LabelDot, labelDotColor } from '@/components/label-chips';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { isNetworkFailure } from '@/lib/offline/offline-fetch';

/**
 * The shared label picker (docs/labels-design.md §4) — used by the listing
 * row ghost "+", the bulk bar, the detail page and the rail's "Move to…".
 *
 * A position:fixed popover (escapes the table's overflow) with an
 * autofocused search input, the catalog rendered as an indented tree (full
 * paths while searching), checkmarks for current assignments, ↑↓ / Enter /
 * Esc, and — when the typed text matches no existing path — a first row
 * `Create "A/B/C"` that POSTs the whole chain. Search is segment-aware
 * (`cust/lp` matches `Customers/LP Global/…`).
 *
 * The picker owns no assignment state: `onSelect(label, nextOn)` is the
 * parent's job (POST/DELETE). In 'toggle' mode it stays open so several
 * labels can be flipped; in 'pick' mode the first choice closes it.
 */

export interface PickerAnchor {
  top: number;
  left: number;
  bottom: number;
  right?: number;
}

export function anchorFromElement(el: Element): PickerAnchor {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, bottom: r.bottom, right: r.right };
}

export interface LabelPickerProps {
  anchor: PickerAnchor | null;
  onClose: () => void;
  /** Current assignments (checkmarks). */
  selectedIds?: ReadonlySet<number>;
  /** Called when a label is chosen / toggled. May return a promise (row shows a spinner). */
  onSelect: (label: LabelRef, nextOn: boolean) => void | Promise<void>;
  mode?: 'toggle' | 'pick';
  /** Restrict the list to these ids (e.g. Remove label → the selection's labels). */
  onlyIds?: ReadonlySet<number>;
  /** Hide these ids (e.g. Move to… hides the node's own subtree). */
  excludeIds?: ReadonlySet<number>;
  /** Offer `Create "…"` for unmatched paths (default true). */
  allowCreate?: boolean;
  /** Optional fixed first row (e.g. "Top level" for Move to…). */
  extraTop?: { label: string; hint?: string; onPick: () => void | Promise<void> };
  title?: string;
  placeholder?: string;
  width?: number;
  /** Stable key so the picker resets its query when the target changes. */
  resetKey?: string | number;
}

type Item =
  | { kind: 'create'; path: string; error: string | null }
  | { kind: 'extra' }
  | { kind: 'label'; row: LabelRow };

const POPOVER_H = 340;

export function LabelPicker({
  anchor,
  onClose,
  selectedIds,
  onSelect,
  mode = 'toggle',
  onlyIds,
  excludeIds,
  allowCreate = true,
  extraTop,
  title,
  placeholder = 'Search or create a label…',
  width = 320,
  resetKey,
}: LabelPickerProps) {
  const catalog = useLabelCatalog();
  // Offline mode / network down: every pick/create hits the server, so the
  // rows stay visible but inert, with one line saying why.
  const { blocked } = useOfflineGate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // In-flight guards as refs: the keydown handler can fire again (held /
  // auto-repeated Enter) before the `creating` / `busyIds` state flushes.
  const creatingRef = useRef(false);
  const busyRef = useRef<Set<number>>(new Set());

  // Reset typed state when the picker is re-targeted.
  useEffect(() => {
    setQuery('');
    setActive(0);
    setError(null);
  }, [resetKey, anchor]);

  // Outside click / Esc / scroll (outside the popover) close it.
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  const ordered = useMemo(() => flattenTree(buildTree(catalog.rows)), [catalog.rows]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const out: Item[] = [];
    const visible = ordered.filter((r) => {
      if (onlyIds && !onlyIds.has(r.id)) return false;
      if (excludeIds && excludeIds.has(r.id)) return false;
      return matchesLabelQuery(r.path, q);
    });
    if (q && allowCreate) {
      const key = pathKeyOf(q);
      const exact = ordered.some((r) => r.path_key === key);
      if (!exact) {
        const v = validatePath(q);
        out.push({
          kind: 'create',
          path: v.ok ? joinPath(v.value) : joinPath(splitPath(q)),
          error: v.ok ? null : v.error,
        });
      }
    }
    if (extraTop && !q) out.push({ kind: 'extra' });
    for (const r of visible) out.push({ kind: 'label', row: r });
    return out;
  }, [ordered, query, onlyIds, excludeIds, allowCreate, extraTop]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Default active row while typing: the first REAL match when there is one
  // (so Enter on a partial query like 'cust' picks 'Customers' instead of
  // creating a top-level 'cust'); the Create row (index 0) only when nothing
  // matches. ArrowUp still reaches Create.
  useEffect(() => {
    const firstLabel = items.findIndex((it) => it.kind === 'label');
    setActive(firstLabel > 0 ? firstLabel : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Keep the active row in view while arrowing.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = useCallback(
    async (item: Item) => {
      setError(null);
      if (blocked) {
        setError(OFFLINE_TITLE);
        return;
      }
      if (item.kind === 'extra') {
        try {
          await extraTop?.onPick();
        } catch (err) {
          setError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Request failed');
          return;
        }
        onClose();
        return;
      }
      if (item.kind === 'create') {
        if (item.error) {
          setError(item.error);
          return;
        }
        if (creatingRef.current) return;
        creatingRef.current = true;
        setCreating(true);
        try {
          const res = await fetch('/api/labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: item.path }),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(parseError(txt) || `Could not create label (${res.status})`);
          }
          const data = (await res.json()) as { label: LabelRef };
          void refreshLabelCatalog();
          await onSelect(data.label, true);
          setQuery('');
          if (mode === 'pick') onClose();
        } catch (err) {
          setError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Could not create label');
        } finally {
          creatingRef.current = false;
          setCreating(false);
        }
        return;
      }
      const row = item.row;
      if (busyRef.current.has(row.id)) return;
      busyRef.current.add(row.id);
      const nextOn = !(selectedIds?.has(row.id) ?? false);
      setBusyIds((s) => new Set(s).add(row.id));
      try {
        await onSelect(
          { id: row.id, name: row.name, path: row.path, color: row.color },
          mode === 'pick' ? true : nextOn
        );
        if (mode === 'pick') onClose();
      } catch (err) {
        setError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Request failed');
      } finally {
        busyRef.current.delete(row.id);
        setBusyIds((s) => {
          const n = new Set(s);
          n.delete(row.id);
          return n;
        });
      }
    },
    [extraTop, onClose, onSelect, selectedIds, mode, blocked]
  );

  if (!anchor) return null;

  const flipUp = anchor.bottom + 6 + POPOVER_H > window.innerHeight && anchor.top > POPOVER_H;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  const style: React.CSSProperties = flipUp
    ? { position: 'fixed', bottom: window.innerHeight - anchor.top + 6, left, width }
    : { position: 'fixed', top: anchor.bottom + 6, left, width };
  const searching = query.trim().length > 0;

  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label={title ?? 'Labels'}
      data-label-picker
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={style}
      className="z-[60] rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.14),0_1px_2px_0_rgb(0_0_0/0.04)]"
    >
      {title && (
        <p className="px-1.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
      )}
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const it = items[active];
            if (it) void pick(it);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder={placeholder}
        className="mb-1 h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:border-primary/50"
      />
      {blocked && !error && (
        <p className="px-1.5 pb-1 text-[11px] text-muted-foreground">{OFFLINE_TITLE}</p>
      )}
      {error && <p className="px-1.5 pb-1 text-[11px] text-destructive">{error}</p>}
      <div ref={listRef} className="max-h-64 overflow-y-auto" role="listbox">
        {!catalog.loaded ? (
          <div className="flex items-center gap-2 px-1.5 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading labels…
          </div>
        ) : items.length === 0 ? (
          <div className={`px-1.5 py-2 text-xs ${catalog.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {catalog.error
              ? `Could not load labels: ${catalog.error}`
              : catalog.rows.length === 0 && !searching
                ? 'No labels yet — type a name to create one.'
                : 'No matching labels.'}
          </div>
        ) : (
          items.map((it, idx) => {
            const isActive = idx === active;
            const base = `flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm ${
              isActive ? 'bg-muted' : 'hover:bg-muted/60'
            }`;
            if (it.kind === 'create') {
              return (
                <button
                  key="create"
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-idx={idx}
                  disabled={creating || blocked}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => void pick(it)}
                  className={`${base} ${it.error ? 'text-muted-foreground' : 'text-primary'} disabled:cursor-not-allowed disabled:opacity-60`}
                  title={blocked ? OFFLINE_TITLE : (it.error ?? `Create ${it.path} (creates missing parents)`)}
                >
                  {creating ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    Create &ldquo;{it.path}&rdquo;
                  </span>
                  {isActive && <CornerDownLeft className="h-3 w-3 shrink-0 opacity-60" />}
                </button>
              );
            }
            if (it.kind === 'extra') {
              return (
                <button
                  key="extra"
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-idx={idx}
                  disabled={blocked}
                  title={blocked ? OFFLINE_TITLE : undefined}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => void pick(it)}
                  className={`${base} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span className="min-w-0 flex-1 truncate">{extraTop?.label}</span>
                  {extraTop?.hint && (
                    <span className="text-[10px] text-muted-foreground">{extraTop.hint}</span>
                  )}
                </button>
              );
            }
            const r = it.row;
            const on = selectedIds?.has(r.id) ?? false;
            const busy = busyIds.has(r.id);
            const parent = r.path.slice(0, Math.max(0, r.path.length - r.name.length));
            return (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-idx={idx}
                data-label-option={r.id}
                disabled={busy || blocked}
                onMouseEnter={() => setActive(idx)}
                onClick={() => void pick(it)}
                title={blocked ? OFFLINE_TITLE : r.path}
                className={`${base} disabled:cursor-not-allowed disabled:opacity-60`}
                style={searching ? undefined : { paddingLeft: 6 + (r.depth - 1) * 14 }}
              >
                <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : on ? (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  ) : null}
                </span>
                <LabelDot color={labelDotColor(r, catalog.byId)} />
                <span className="min-w-0 flex-1 truncate">
                  {searching && parent && (
                    <span className="text-muted-foreground">{parent}</span>
                  )}
                  {r.name}
                </span>
                {typeof r.count_visible === 'number' && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {r.count_visible}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      <p className="mt-1 border-t px-1.5 pt-1 text-[10px] text-muted-foreground">
        ↑↓ move · Enter {mode === 'toggle' ? 'toggles' : 'picks'} · Esc closes
      </p>
    </div>
  );
}

/** Routes answer `{error}` JSON or plain text; pull a human line out. */
export function parseError(txt: string): string {
  if (!txt) return '';
  try {
    const j = JSON.parse(txt) as { error?: string; message?: string };
    return j.error || j.message || '';
  } catch {
    return txt.length > 200 ? '' : txt;
  }
}
