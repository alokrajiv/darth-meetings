'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Layers } from 'lucide-react';
import { OFFLINE_TITLE } from '@/lib/offline/offline-types';

/**
 * Compact multi-select replacement for the three layer chips: one toolbar
 * trigger ("All layers" when every layer is on, else the first enabled name
 * + "+N") opening a checkbox menu with the same items, counts and semantics
 * — the last enabled layer can't untick, and tabs/search freeze the merged
 * view to archive-only (trigger disabled, summary reads "Imported").
 *
 * Pure presentation: the host (TranscriptTable) owns the state and the
 * localStorage persistence (mw:layers:v1) via `onToggle`.
 */

export type LayerDropdownKey = 'archive' | 'unimported' | 'norec';

export interface LayerDropdownPrefs {
  archive: boolean;
  unimported: boolean;
  norec: boolean;
}

const LAYER_ORDER: LayerDropdownKey[] = ['archive', 'unimported', 'norec'];

interface LayersDropdownProps {
  layers: LayerDropdownPrefs;
  /** "Not imported" badge count (null until the first counts fetch lands). */
  unimportedCount: number | null;
  /** "No recording" badge count (null until the first counts fetch lands). */
  norecCount: number | null;
  /** Tabs/search/label filter active — archive-only view, controls frozen. */
  inactive: boolean;
  /** Offline mode / network down: the trigger is disabled ("Not available offline"). */
  offline?: boolean;
  onToggle: (key: LayerDropdownKey) => void;
}

export function LayersDropdown({
  layers,
  unimportedCount,
  norecCount,
  inactive,
  offline = false,
  onToggle,
}: LayersDropdownProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Consume it: TranscriptTable's window-level Escape clears the bulk
        // row selection — closing the menu must not also nuke a selection.
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = (key: LayerDropdownKey): string =>
    key === 'archive'
      ? 'Imported'
      : key === 'unimported'
        ? `Not imported${unimportedCount != null ? ` (${unimportedCount})` : ''}`
        : `No recording${norecCount != null ? ` (${norecCount})` : ''}`;

  /** Short name for the trigger summary (no count suffix). */
  const shortLabel = (key: LayerDropdownKey): string =>
    key === 'archive' ? 'Imported' : key === 'unimported' ? 'Not imported' : 'No recording';

  const enabled = LAYER_ORDER.filter((k) => layers[k]);
  const summary = inactive
    ? 'Imported'
    : enabled.length === LAYER_ORDER.length
      ? 'All layers'
      : enabled.length === 0
        ? 'No layers' // unreachable (last layer can't untick) — belt only
        : `${shortLabel(enabled[0])}${enabled.length > 1 ? ` +${enabled.length - 1}` : ''}`;

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        disabled={inactive || offline}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-layers-trigger
        title={
          offline
            ? OFFLINE_TITLE
            : inactive
              ? 'Layers apply on the All tab with no search active'
              : 'Choose which layers the timeline shows'
        }
        className={`flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          inactive || offline ? 'opacity-50' : ''
        }`}
      >
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span data-layers-summary>{summary}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && !inactive && !offline && (
        <div
          role="menu"
          data-layers-menu
          className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Timeline layers
          </p>
          {LAYER_ORDER.map((key) => {
            const on = layers[key];
            const lastOn = on && enabled.length === 1;
            return (
              <button
                key={key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                disabled={lastOn}
                data-layer-item={key}
                title={
                  lastOn
                    ? 'At least one layer must stay on'
                    : on
                      ? 'Hide these rows'
                      : 'Show these rows'
                }
                onClick={() => onToggle(key)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-default ${
                  on ? 'text-foreground' : 'text-muted-foreground'
                } ${lastOn ? 'opacity-60' : ''}`}
              >
                <Check className={`h-3.5 w-3.5 shrink-0 text-primary ${on ? '' : 'invisible'}`} aria-hidden />
                {label(key)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
