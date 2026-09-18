'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Hourglass, Loader2, Minus, Plus, X } from 'lucide-react';
import type { LabelRef } from '@/lib/format';
import { LabelPicker, anchorFromElement, parseError, type PickerAnchor } from '@/components/label-picker';
import { OFFLINE_TITLE } from '@/lib/offline/offline-types';
import { isNetworkFailure } from '@/lib/offline/offline-fetch';

/**
 * Sticky bulk-action bar for the listing's checkbox selection
 * (docs/labels-design.md §4): "N selected · Add label ▾ · Remove label ▾ ·
 * Clear". Add/Remove open the shared LabelPicker (Remove restricted to the
 * labels the selection actually carries) and call POST /api/labels/bulk;
 * the server answers `{applied, skipped:[{id,reason}]}` and the bar
 * reports partial success ("2 read-only skipped") instead of hiding it.
 *
 * Temporary transcripts (migration 042): one more action, "Move to
 * temporary" on the main tabs or "Keep" on the Temporary tab. There is no
 * batch route for `scratch` — it is PATCH /api/transcripts/:id per row,
 * run client-side SCRATCH_CONCURRENCY at a time, with the same
 * applied/skipped summary (403 = read-only share, skipped).
 */

export interface BulkResult {
  applied: number;
  skipped: { id: string; reason: string }[];
}

export type BulkScratchAction = 'keep' | 'temporary';

const SCRATCH_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `n` in flight (order of completion irrelevant). */
async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export interface BulkLabelBarProps {
  /** Selected transcript ids (assemblyai ids). Bar hides when empty. */
  selectedIds: readonly string[];
  /** Union of labels across the selection (drives the Remove picker). */
  selectedLabels: LabelRef[];
  /** How many selected rows the caller can't edit (owner/edit only). */
  readOnlyCount: number;
  onClear: () => void;
  /** Fired after every bulk call (success or partial) so the parent refetches. */
  onApplied: (result: BulkResult, action: 'add' | 'remove', label: LabelRef) => void;
  /** Bump to open the Add picker from a keyboard shortcut (`l`). */
  openAddSignal?: number;
  /** Offline mode / network down: Add/Remove are inert (Clear stays live). */
  disabled?: boolean;
  /** Which temporary-transcript action fits the current tab; null/undefined hides it. */
  scratchAction?: BulkScratchAction | null;
  /** Fired after the per-row PATCH loop finishes (success or partial). */
  onScratchApplied?: (result: BulkResult, action: BulkScratchAction) => void;
}

export function BulkLabelBar({
  selectedIds,
  selectedLabels,
  readOnlyCount,
  onClear,
  onApplied,
  openAddSignal,
  disabled = false,
  scratchAction = null,
  onScratchApplied,
}: BulkLabelBarProps) {
  const [picker, setPicker] = useState<{ kind: 'add' | 'remove'; anchor: PickerAnchor } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const count = selectedIds.length;

  const closePicker = useCallback(() => setPicker(null), []);

  // `l` from the table → open Add.
  const lastSignal = useRef(openAddSignal);
  useEffect(() => {
    if (openAddSignal === undefined || openAddSignal === lastSignal.current) return;
    lastSignal.current = openAddSignal;
    if (count === 0 || disabled) return;
    const el = addBtnRef.current;
    if (el) setPicker({ kind: 'add', anchor: anchorFromElement(el) });
  }, [openAddSignal, count, disabled]);

  // Message auto-clears.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  const removableIds = useMemo(() => new Set(selectedLabels.map((l) => l.id)), [selectedLabels]);

  const run = useCallback(
    async (action: 'add' | 'remove', label: LabelRef) => {
      if (count === 0) return;
      setBusy(true);
      setMessage(null);
      try {
        const body =
          action === 'add'
            ? { transcriptIds: [...selectedIds], add: [label.id] }
            : { transcriptIds: [...selectedIds], remove: [label.id] };
        const res = await fetch('/api/labels/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(parseError(txt) || `Bulk ${action} failed (${res.status})`);
        }
        const data = (await res.json()) as Partial<BulkResult>;
        const result: BulkResult = {
          applied: Number(data.applied ?? 0),
          skipped: Array.isArray(data.skipped) ? data.skipped : [],
        };
        const verb = action === 'add' ? 'Added' : 'Removed';
        const prep = action === 'add' ? 'to' : 'from';
        const ro = result.skipped.filter((s) => /read|permission|forbid|403/i.test(s.reason)).length;
        const other = result.skipped.length - ro;
        let msg = `${verb} "${label.name}" ${prep} ${result.applied} meeting${result.applied === 1 ? '' : 's'}`;
        if (ro) msg += ` · ${ro} read-only skipped`;
        if (other) msg += ` · ${other} skipped`;
        setMessage(msg);
        onApplied(result, action, label);
      } catch (err) {
        setMessage(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Bulk update failed');
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [count, selectedIds, onApplied]
  );

  const runScratch = useCallback(
    async (action: BulkScratchAction) => {
      if (count === 0) return;
      setBusy(true);
      setMessage(null);
      const scratch = action === 'temporary';
      const result: BulkResult = { applied: 0, skipped: [] };
      try {
        await pool([...selectedIds], SCRATCH_CONCURRENCY, async (id) => {
          try {
            const res = await fetch(`/api/transcripts/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scratch }),
            });
            if (res.ok) {
              result.applied += 1;
              return;
            }
            const txt = await res.text().catch(() => '');
            result.skipped.push({
              id,
              reason: res.status === 403 ? 'read-only' : parseError(txt) || `${res.status}`,
            });
          } catch (err) {
            if (isNetworkFailure(err)) throw err; // stop the loop — nothing will succeed offline
            result.skipped.push({ id, reason: err instanceof Error ? err.message : 'failed' });
          }
        });
        const verb = scratch ? 'Moved' : 'Kept';
        const ro = result.skipped.filter((s) => s.reason === 'read-only').length;
        const other = result.skipped.length - ro;
        let msg = `${verb} ${result.applied} meeting${result.applied === 1 ? '' : 's'}${scratch ? ' to temporary' : ''}`;
        if (ro) msg += ` · ${ro} read-only skipped`;
        if (other) msg += ` · ${other} skipped`;
        setMessage(msg);
        onScratchApplied?.(result, action);
      } catch (err) {
        setMessage(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Bulk update failed');
        if (result.applied > 0) onScratchApplied?.(result, action);
      } finally {
        setBusy(false);
      }
    },
    [count, selectedIds, onScratchApplied]
  );

  if (count === 0) return null;

  return (
    <>
      <div
        data-bulk-bar
        className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
      >
        <div className="pointer-events-auto flex max-w-[96vw] flex-wrap items-center gap-1.5 rounded-full border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-[0_8px_24px_-4px_rgb(0_0_0/0.18),0_1px_2px_0_rgb(0_0_0/0.06)]">
          <span className="px-1 font-medium tabular-nums">
            {count} selected
          </span>
          {readOnlyCount > 0 && (
            <span
              className="text-[11px] text-muted-foreground"
              title="Labels can only be changed on meetings you own or can edit"
            >
              ({readOnlyCount} read-only)
            </span>
          )}
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button
            ref={addBtnRef}
            type="button"
            disabled={busy || disabled}
            onClick={(e) => setPicker({ kind: 'add', anchor: anchorFromElement(e.currentTarget) })}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
            title={disabled ? OFFLINE_TITLE : 'Add a label to every selected meeting (l)'}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add label
          </button>
          <button
            type="button"
            disabled={busy || disabled || selectedLabels.length === 0}
            onClick={(e) =>
              setPicker({ kind: 'remove', anchor: anchorFromElement(e.currentTarget) })
            }
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
            title={
              disabled
                ? OFFLINE_TITLE
                : selectedLabels.length === 0
                  ? 'The selected meetings carry no labels'
                  : 'Remove a label from every selected meeting'
            }
          >
            <Minus className="h-3.5 w-3.5" />
            Remove label
          </button>
          {scratchAction && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void runScratch(scratchAction)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
              data-bulk-scratch={scratchAction}
              title={
                disabled
                  ? OFFLINE_TITLE
                  : scratchAction === 'keep'
                    ? 'Keep — make every selected transcript permanent (moves them to the main list)'
                    : 'Move to temporary — out of the main list, trashed automatically after 30 days'
              }
            >
              {scratchAction === 'keep' ? <Archive className="h-3.5 w-3.5" /> : <Hourglass className="h-3.5 w-3.5" />}
              {scratchAction === 'keep' ? 'Keep' : 'Move to temporary'}
            </button>
          )}
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Clear selection (Esc)"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
          {message && (
            <span className="ml-1 max-w-[40vw] truncate text-xs text-muted-foreground" data-bulk-message>
              {message}
            </span>
          )}
        </div>
      </div>
      {picker && (
        <LabelPicker
          anchor={picker.anchor}
          onClose={closePicker}
          mode="pick"
          title={picker.kind === 'add' ? `Add label to ${count}` : `Remove label from ${count}`}
          allowCreate={picker.kind === 'add'}
          onlyIds={picker.kind === 'remove' ? removableIds : undefined}
          placeholder={picker.kind === 'add' ? 'Search or create a label…' : 'Which label to remove…'}
          onSelect={(label) => run(picker.kind, label)}
          resetKey={picker.kind}
        />
      )}
    </>
  );
}
