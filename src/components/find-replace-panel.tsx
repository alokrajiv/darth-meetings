'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X, ChevronUp, ChevronDown } from 'lucide-react';

interface FindReplacePanelProps {
  open: boolean;
  onClose: () => void;

  query: string;
  onQueryChange: (q: string) => void;

  replace: string;
  onReplaceChange: (r: string) => void;

  caseSensitive: boolean;
  onCaseSensitiveChange: (cs: boolean) => void;

  /** Number of matches found across the whole transcript. */
  matchCount: number;
  /** 1-based index of the currently focused match (or 0 if no matches). */
  currentIndex: number;

  onNext: () => void;
  onPrev: () => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
}

/**
 * Floating find-and-replace panel — VS-Code-style step-through flow.
 *
 * The parent owns all the state (query, replace, matches list, current
 * focused index). This component is a thin controlled UI on top of those
 * callbacks. Highlights are drawn by EditableUtterance, not here.
 */
export function FindReplacePanel({
  open,
  onClose,
  query,
  onQueryChange,
  replace,
  onReplaceChange,
  caseSensitive,
  onCaseSensitiveChange,
  matchCount,
  currentIndex,
  onNext,
  onPrev,
  onReplaceCurrent,
  onReplaceAll,
}: FindReplacePanelProps) {
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => findRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const status = matchCount === 0
    ? query
      ? 'No matches'
      : 'Type to find'
    : `${currentIndex} of ${matchCount}`;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[26rem] rounded-lg border bg-background shadow-xl">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Find &amp; replace</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <Input
            ref={findRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Find"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) onPrev();
                else onNext();
              }
            }}
          />
          <button
            type="button"
            onClick={onPrev}
            disabled={matchCount === 0}
            className="rounded p-1.5 hover:bg-muted disabled:opacity-30"
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={matchCount === 0}
            className="rounded p-1.5 hover:bg-muted disabled:opacity-30"
            title="Next match (Enter)"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={replace}
            onChange={(e) => onReplaceChange(e.target.value)}
            placeholder="Replace with"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'Enter') {
                e.preventDefault();
                onReplaceCurrent();
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={onReplaceCurrent}
            disabled={matchCount === 0}
            title="Replace current match (Enter)"
          >
            Replace
          </Button>
          <Button
            size="sm"
            onClick={onReplaceAll}
            disabled={matchCount === 0}
            title="Replace all matches"
          >
            All
          </Button>
        </div>
        <div className="flex items-center justify-between pt-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => onCaseSensitiveChange(e.target.checked)}
            />
            Match case
          </label>
          <p className="text-xs text-muted-foreground">{status}</p>
        </div>
      </div>
    </div>
  );
}
