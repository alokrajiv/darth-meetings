'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Repeat,
  Tag,
  X,
} from 'lucide-react';
import {
  buildTree,
  flattenTree,
  joinPath,
  subtreeIds,
  validatePath,
  validateSegment,
  type LabelFilter,
  type LabelNode,
  type LabelRow,
} from '@/lib/labels';
import type { LabelRef } from '@/lib/format';
import { refreshLabelCatalog, useLabelCatalog } from '@/hooks/use-label-catalog';
import { LabelDot, labelDotColor } from '@/components/label-chips';
import { LabelPicker, anchorFromElement, parseError, type PickerAnchor } from '@/components/label-picker';

/**
 * Left rail of the listing (docs/labels-design.md §4): the org-wide label
 * tree with visible-to-you counts, All / Unlabelled pseudo-nodes, the active
 * filter's breadcrumb (+ "incl. sub-labels" toggle) in its header, a ⋯ menu
 * per node (New sub-label / Rename / Move to… / Color / Delete) and
 * "+ New label". Click-only — no drag.
 *
 * The rail never owns the filter: page.tsx holds `?label=&exact=` and passes
 * it down; the rail just calls `onFilter`. After every taxonomy mutation it
 * refreshes the shared catalog and calls `onChanged` so the page can
 * silently refetch the listing (renames change row chips too).
 */

export const LABEL_RAIL_STORAGE_KEY = 'mw-label-rail';
const OPEN_STORAGE_KEY = 'mw-label-rail-open';

/** Preset palette for the Color menu (Tailwind 500s, readable in both themes). */
const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
  '#78716c', '#64748b',
];

export interface LabelRailProps {
  filter: LabelFilter | null;
  onFilter: (f: LabelFilter | null) => void;
  /** After any taxonomy mutation — the listing must refetch (chips, counts). */
  onChanged: () => void;
  onCollapse: () => void;
  className?: string;
}

type Editing =
  | { kind: 'create'; parentId: number | null }
  | { kind: 'rename'; id: number }
  | null;

interface MenuState {
  id: number;
  anchor: PickerAnchor;
}

function loadOpenIds(): Set<number> | null {
  try {
    const raw = localStorage.getItem(OPEN_STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return new Set(arr.filter((x): x is number => typeof x === 'number'));
  } catch {
    return null;
  }
}

function saveOpenIds(ids: Set<number>) {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // storage blocked — expansion just won't persist
  }
}

async function patchLabel(id: number, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/labels/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(parseError(txt) || `Update failed (${res.status})`);
  }
}

export function LabelRail({ filter, onFilter, onChanged, onCollapse, className = '' }: LabelRailProps) {
  const catalog = useLabelCatalog();
  const [openIds, setOpenIds] = useState<Set<number> | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveFor, setMoveFor] = useState<{ id: number; anchor: PickerAnchor } | null>(null);
  const [colorFor, setColorFor] = useState<{ id: number; anchor: PickerAnchor } | null>(null);
  const [exactOpen, setExactOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLDivElement>(null);
  const exactRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildTree(catalog.rows), [catalog.rows]);
  const flat = useMemo(() => flattenTree(tree), [tree]);
  const nodeById = useMemo(() => {
    const m = new Map<number, LabelNode<LabelRow>>();
    for (const n of flat) m.set(n.id, n);
    return m;
  }, [flat]);

  // Expansion state: stored set, else top-level nodes open by default.
  useEffect(() => {
    if (!catalog.loaded || openIds !== null) return;
    const stored = loadOpenIds();
    if (stored) {
      setOpenIds(stored);
      return;
    }
    // Top-level nodes open by default — except the reserved "Series" root
    // (auto-labels, one child per recurring series), which starts collapsed.
    setOpenIds(
      new Set(
        catalog.rows
          .filter((r) => r.depth === 1 && r.path_key !== 'series')
          .map((r) => r.id)
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.loaded]);

  // The active filter's ancestors are always expanded.
  useEffect(() => {
    if (!filter || filter.kind !== 'id' || !catalog.loaded) return;
    const row = catalog.byId.get(filter.id);
    if (!row) return;
    const need: number[] = [];
    let cur = row.parent_id == null ? undefined : catalog.byId.get(row.parent_id);
    while (cur) {
      need.push(cur.id);
      cur = cur.parent_id == null ? undefined : catalog.byId.get(cur.parent_id);
    }
    if (need.length === 0) return;
    setOpenIds((prev) => {
      const next = new Set(prev ?? []);
      let changed = false;
      for (const id of need) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (!changed) return prev;
      saveOpenIds(next);
      return next;
    });
  }, [filter, catalog.loaded, catalog.byId]);

  const toggleOpen = useCallback((id: number) => {
    setOpenIds((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveOpenIds(next);
      return next;
    });
  }, []);

  // Live updates: NO EventSource of its own — the listing table's SSE handler
  // (transcript-table.tsx) refreshes the shared catalog on kind 'labels' and
  // this rail re-renders through useLabelCatalog. One /api/events per tab.

  // Outside-click closers for the ⋯ menu, color popover, exact dropdown.
  useEffect(() => {
    if (!menu && !colorFor && !exactOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu && menuRef.current && !menuRef.current.contains(t)) setMenu(null);
      if (colorFor && colorRef.current && !colorRef.current.contains(t)) setColorFor(null);
      if (exactOpen && exactRef.current && !exactRef.current.contains(t)) setExactOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setColorFor(null);
        setExactOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu, colorFor, exactOpen]);

  const afterMutation = useCallback(async () => {
    await refreshLabelCatalog();
    onChanged();
  }, [onChanged]);

  const startCreate = (parentId: number | null) => {
    setMenu(null);
    setError(null);
    setDraft('');
    setEditing({ kind: 'create', parentId });
    if (parentId != null) {
      setOpenIds((prev) => {
        const next = new Set(prev ?? []);
        next.add(parentId);
        saveOpenIds(next);
        return next;
      });
    }
  };

  const startRename = (id: number) => {
    setMenu(null);
    setError(null);
    setDraft(catalog.byId.get(id)?.name ?? '');
    setEditing({ kind: 'rename', id });
  };

  const commitEdit = async () => {
    if (!editing) return;
    // Top-level create accepts a full path ('A/B/C' nests); rename and
    // sub-label create take one segment.
    const topLevelCreate = editing.kind === 'create' && editing.parentId == null;
    const v = topLevelCreate ? validatePath(draft) : validateSegment(draft);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing.kind === 'create') {
        const parent = editing.parentId == null ? null : catalog.byId.get(editing.parentId);
        const body = parent
          ? { name: v.value as string, parentId: parent.id }
          : { path: joinPath(v.value as string[]) };
        const res = await fetch('/api/labels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(parseError(txt) || `Could not create label (${res.status})`);
        }
      } else {
        const cur = catalog.byId.get(editing.id);
        if (cur && cur.name !== v.value) await patchLabel(editing.id, { name: v.value as string });
      }
      setEditing(null);
      setDraft('');
      await afterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const doMove = async (id: number, parentId: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await patchLabel(id, { parentId });
      if (parentId != null) {
        setOpenIds((prev) => {
          const next = new Set(prev ?? []);
          next.add(parentId);
          saveOpenIds(next);
          return next;
        });
      }
      await afterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setBusy(false);
    }
  };

  const doColor = async (id: number, color: string | null) => {
    setColorFor(null);
    setBusy(true);
    setError(null);
    try {
      await patchLabel(id, { color });
      await afterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recolor failed');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: number) => {
    setMenu(null);
    const node = nodeById.get(id);
    if (!node) return;
    const subs = subtreeIds(node).length - 1;
    const n = node.count_visible ?? 0;
    const msg =
      `Delete label "${node.path}"?\n\n` +
      `This removes it from ${n} meeting${n === 1 ? '' : 's'} visible to you` +
      (subs > 0 ? ` and deletes ${subs} sub-label${subs === 1 ? '' : 's'} (with their assignments)` : '') +
      '. Other people’s assignments are removed too. This cannot be undone.';
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/labels/${id}${subs > 0 ? '?cascade=1' : ''}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(parseError(txt) || `Delete failed (${res.status})`);
      }
      // If the filter pointed into the deleted subtree, clear it.
      if (filter?.kind === 'id' && subtreeIds(node).includes(filter.id)) onFilter(null);
      await afterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const activeId = filter?.kind === 'id' ? filter.id : null;
  const activeRow = activeId != null ? catalog.byId.get(activeId) ?? null : null;
  const crumbs = useMemo(() => {
    if (!activeRow) return [];
    const out: LabelRow[] = [];
    let cur: LabelRow | undefined = activeRow;
    while (cur) {
      out.unshift(cur);
      cur = cur.parent_id == null ? undefined : catalog.byId.get(cur.parent_id);
    }
    return out;
  }, [activeRow, catalog.byId]);

  const editInput = (placeholder: string, depth: number) => (
    <div className="flex items-center gap-1 py-0.5 pr-2" style={{ paddingLeft: 10 + depth * 14 }}>
      <input
        autoFocus
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commitEdit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(null);
            setError(null);
          }
        }}
        onBlur={() => {
          // Blur with an empty draft = cancel; otherwise keep for Enter.
          if (!draft.trim()) {
            setEditing(null);
            setError(null);
          }
        }}
        placeholder={placeholder}
        data-label-edit
        className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-sm outline-none focus:border-primary/50"
      />
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
    </div>
  );

  const renderNode = (node: LabelNode<LabelRow>, depth: number): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const open = openIds?.has(node.id) ?? false;
    const isActive = activeId === node.id;
    const renaming = editing?.kind === 'rename' && editing.id === node.id;
    const color = labelDotColor(node as LabelRef, catalog.byId);
    // The reserved "Series" root groups the per-series auto-labels — render
    // it slightly muted with the series glyph instead of a color dot.
    const isSeriesRoot = node.parent_id === null && node.path_key === 'series';
    return (
      <div key={node.id}>
        {renaming ? (
          editInput('Label name', depth)
        ) : (
          <div
            className={`group flex h-7 items-center gap-1 rounded-md pr-1 text-sm transition-colors ${
              isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60'
            }`}
            style={{ paddingLeft: 4 + depth * 14 }}
            data-label-node={node.id}
          >
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) toggleOpen(node.id);
              }}
              aria-label={hasChildren ? (open ? 'Collapse' : 'Expand') : undefined}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted ${
                hasChildren ? '' : 'invisible'
              }`}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => onFilter({ kind: 'id', id: node.id, exact: filter?.kind === 'id' ? filter.exact : false })}
              title={`${node.path}${typeof node.count_visible === 'number' ? ` — ${node.count_visible} meeting${node.count_visible === 1 ? '' : 's'} (incl. sub-labels)` : ''}`}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {isSeriesRoot ? (
                <Repeat className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden />
              ) : (
                <LabelDot color={color} />
              )}
              <span
                className={`min-w-0 flex-1 truncate ${isActive ? 'font-medium' : ''} ${
                  isSeriesRoot && !isActive ? 'text-muted-foreground' : ''
                }`}
              >
                {node.name}
              </span>
              {typeof node.count_visible === 'number' && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {node.count_visible}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // Read the anchor now — React nulls currentTarget after the handler.
                const anchor = anchorFromElement(e.currentTarget);
                setMenu((m) => (m?.id === node.id ? null : { id: node.id, anchor }));
              }}
              title="Label actions"
              aria-label={`Actions for ${node.name}`}
              data-label-menu={node.id}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
                menu?.id === node.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
              }`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {editing?.kind === 'create' && editing.parentId === node.id && editInput('New sub-label', depth + 1)}
        {hasChildren && open && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  const menuNode = menu ? nodeById.get(menu.id) ?? null : null;
  const moveNode = moveFor ? nodeById.get(moveFor.id) ?? null : null;

  return (
    <aside
      data-label-rail
      className={`flex w-60 shrink-0 flex-col rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] ${className}`}
    >
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Labels</span>
        {catalog.loaded && catalog.rows.length > 0 && (
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {catalog.rows.length}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void refreshLabelCatalog()}
          title="Refresh labels"
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          title="Hide the labels rail"
          data-label-rail-collapse
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      {filter && (
        <div className="flex flex-wrap items-center gap-1 border-b bg-primary/5 px-2 py-1.5 text-xs" data-label-breadcrumb>
          {filter.kind === 'none' ? (
            <span className="font-medium">Unlabelled</span>
          ) : crumbs.length === 0 ? (
            <span className="text-muted-foreground">Label #{filter.id}</span>
          ) : (
            crumbs.map((c, i) => (
              <span key={c.id} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted-foreground/60">›</span>}
                <button
                  type="button"
                  onClick={() => onFilter({ kind: 'id', id: c.id, exact: filter.exact })}
                  className={`rounded px-0.5 hover:bg-primary/10 ${
                    i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={c.path}
                >
                  {c.name}
                </button>
              </span>
            ))
          )}
          {filter.kind === 'id' && (
            <div className="relative" ref={exactRef}>
              <button
                type="button"
                onClick={() => setExactOpen((v) => !v)}
                className="inline-flex items-center gap-0.5 rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                title="Include meetings under sub-labels, or only this exact label"
                data-label-exact-toggle
              >
                {filter.exact ? 'exactly this label' : 'incl. sub-labels'}
                <ChevronDown className="h-3 w-3" />
              </button>
              {exactOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-md border bg-popover p-1 shadow-md">
                  {[
                    { exact: false, label: 'Including sub-labels' },
                    { exact: true, label: 'Exactly this label' },
                  ].map((o) => (
                    <button
                      key={String(o.exact)}
                      type="button"
                      onClick={() => {
                        setExactOpen(false);
                        onFilter({ kind: 'id', id: filter.id, exact: o.exact });
                      }}
                      className={`block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted ${
                        filter.exact === o.exact ? 'font-medium' : ''
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => onFilter(null)}
            title="Clear label filter"
            data-label-clear
            className="ml-auto grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <button
          type="button"
          onClick={() => onFilter(null)}
          data-label-all
          className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm ${
            !filter ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted/60'
          }`}
        >
          <span className="min-w-0 flex-1 truncate">All meetings</span>
          {catalog.total != null && (
            <span className="text-[11px] tabular-nums text-muted-foreground">{catalog.total}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onFilter({ kind: 'none' })}
          data-label-unlabelled
          className={`mb-1 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm ${
            filter?.kind === 'none' ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted/60'
          }`}
        >
          <span className="min-w-0 flex-1 truncate">Unlabelled</span>
          {catalog.unlabelled != null && (
            <span className="text-[11px] tabular-nums text-muted-foreground">{catalog.unlabelled}</span>
          )}
        </button>

        {!catalog.loaded ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : catalog.error && catalog.rows.length === 0 ? (
          <div className="px-2 py-3 text-xs text-destructive">{catalog.error}</div>
        ) : tree.length === 0 && editing?.kind !== 'create' ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No labels yet. Create one below, or from any meeting row.
          </p>
        ) : (
          tree.map((n) => renderNode(n, 0))
        )}
        {editing?.kind === 'create' && editing.parentId === null && editInput('New label (A/B/C nests)', 0)}
        {error && <p className="px-2 pt-1 text-[11px] text-destructive">{error}</p>}
      </div>

      <div className="border-t p-1.5">
        <button
          type="button"
          onClick={() => startCreate(null)}
          data-label-new
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" /> New label
        </button>
      </div>

      {menu && menuNode && (
        <div
          ref={menuRef}
          role="menu"
          data-label-menu-popover
          style={{
            position: 'fixed',
            top: menu.anchor.bottom + 4,
            left: Math.max(8, Math.min(menu.anchor.left - 120, window.innerWidth - 180)),
            width: 172,
          }}
          className="z-[60] rounded-md border bg-popover p-1 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.14)]"
        >
          <p className="truncate px-2 pb-1 pt-0.5 text-[10px] text-muted-foreground" title={menuNode.path}>
            {menuNode.path}
          </p>
          {[
            { key: 'sub', label: 'New sub-label', run: () => startCreate(menuNode.id) },
            { key: 'rename', label: 'Rename', run: () => startRename(menuNode.id) },
            {
              key: 'move',
              label: 'Move to…',
              run: () => {
                setMoveFor({ id: menuNode.id, anchor: menu.anchor });
                setMenu(null);
              },
            },
            {
              key: 'color',
              label: 'Color',
              run: () => {
                setColorFor({ id: menuNode.id, anchor: menu.anchor });
                setMenu(null);
              },
            },
          ].map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              data-label-menu-item={it.key}
              onClick={it.run}
              className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
            >
              {it.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            data-label-menu-item="delete"
            onClick={() => void doDelete(menuNode.id)}
            className="block w-full rounded px-2 py-1 text-left text-sm text-destructive hover:bg-destructive/10"
          >
            Delete
          </button>
        </div>
      )}

      {colorFor && (
        <div
          ref={colorRef}
          data-label-color-popover
          style={{
            position: 'fixed',
            top: colorFor.anchor.bottom + 4,
            left: Math.max(8, Math.min(colorFor.anchor.left - 120, window.innerWidth - 200)),
            width: 188,
          }}
          className="z-[60] rounded-md border bg-popover p-2 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.14)]"
        >
          <p className="pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Color</p>
          <div className="grid grid-cols-7 gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                data-label-color={c}
                onClick={() => void doColor(colorFor.id, c)}
                className={`h-5 w-5 rounded-full border-2 ${
                  catalog.byId.get(colorFor.id)?.color === c ? 'border-foreground' : 'border-transparent'
                } hover:scale-110`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => void doColor(colorFor.id, null)}
            className="mt-2 block w-full rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            No color (inherit parent)
          </button>
        </div>
      )}

      {moveFor && moveNode && (
        <LabelPicker
          anchor={moveFor.anchor}
          onClose={() => setMoveFor(null)}
          mode="pick"
          title={`Move "${moveNode.name}" under…`}
          allowCreate={false}
          excludeIds={new Set(subtreeIds(moveNode))}
          extraTop={
            moveNode.parent_id == null
              ? undefined
              : { label: 'Top level', hint: 'no parent', onPick: () => doMove(moveNode.id, null) }
          }
          placeholder="Search for the new parent…"
          onSelect={(label) => doMove(moveNode.id, label.id)}
          resetKey={moveNode.id}
        />
      )}
    </aside>
  );
}
