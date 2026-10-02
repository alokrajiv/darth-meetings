'use client';

import { Check } from 'lucide-react';

/**
 * The merged timeline's three layers as a checkbox list — the "Layers"
 * section of the listing's Filter popover (it used to be its own toolbar
 * dropdown). Same items, counts and semantics: the last enabled layer can't
 * untick, and tabs/search/label filter freeze the merged view to
 * archive-only (items inert, a one-line note says why).
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

interface LayerChecklistProps {
  layers: LayerDropdownPrefs;
  /** "Not imported" badge count (null until the first counts fetch lands). */
  unimportedCount: number | null;
  /** "No recording" badge count (null until the first counts fetch lands). */
  norecCount: number | null;
  /** Tabs/search/label filter active — archive-only view, controls frozen. */
  inactive: boolean;
  onToggle: (key: LayerDropdownKey) => void;
}

export function LayerChecklist({
  layers,
  unimportedCount,
  norecCount,
  inactive,
  onToggle,
}: LayerChecklistProps) {
  const label = (key: LayerDropdownKey): string =>
    key === 'archive'
      ? 'Imported'
      : key === 'unimported'
        ? `Not imported${unimportedCount != null ? ` (${unimportedCount})` : ''}`
        : `No recording${norecCount != null ? ` (${norecCount})` : ''}`;
  const enabled = LAYER_ORDER.filter((k) => layers[k]);
  const frozen = inactive;
  return (
    <div data-layers-menu>
      {LAYER_ORDER.map((key) => {
        const on = layers[key];
        const lastOn = on && enabled.length === 1;
        return (
          <button
            key={key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            disabled={lastOn || frozen}
            data-layer-item={key}
            title={
              lastOn
                ? 'At least one layer must stay on'
                : on
                  ? 'Hide these rows'
                  : 'Show these rows'
            }
            onClick={() => onToggle(key)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent ${
              on ? 'text-foreground' : 'text-muted-foreground'
            } ${lastOn || frozen ? 'opacity-60' : ''}`}
          >
            <Check className={`h-3.5 w-3.5 shrink-0 text-primary ${on ? '' : 'invisible'}`} aria-hidden />
            {label(key)}
          </button>
        );
      })}
      {inactive && (
        <p className="px-2 pb-0.5 text-[11px] text-muted-foreground">
          Layers apply on the All tab with no search or label filter.
        </p>
      )}
    </div>
  );
}
