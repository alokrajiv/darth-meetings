'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Loader2, Search, User } from 'lucide-react';

export interface PickerPerson {
  id: number;
  name: string;
  email: string | null;
  slackHandle: string | null;
  team: string | null;
  role: string | null;
  source: 'trames' | 'custom';
}

export type PickerSelection =
  | { type: 'person'; person: PickerPerson }
  | { type: 'custom'; text: string };

interface UserPickerProps {
  /**
   * 'strict'  — user must pick a real person; free text is not a valid result.
   *              Used for sharing (we need an email to store).
   * 'freeform' — user can either pick a person OR commit free text.
   *              Used for speaker names (custom labels are fine).
   */
  mode: 'strict' | 'freeform';
  /** Initial text shown in the input. Empty string on first open is fine. */
  initialValue?: string;
  /** Shown when the input is empty. */
  placeholder?: string;
  /** Called when the user commits a selection (keyboard Enter or mouse click). */
  onSelect: (selection: PickerSelection) => void;
  /**
   * Optional override for custom-text commits in freeform mode. When
   * provided, this is called instead of `onSelect({type:'custom'})` so the
   * parent can launch the AddPersonDialog and promote the typed name into a
   * first-class person record.
   */
  onCustomSubmit?: (name: string) => void;
  /** Called when focus leaves without committing. freeform mode also fires
   *  onSelect({type:'custom'}) via this if the text changed. */
  onCancel?: () => void;
  /** Called on every key stroke with the current input text. Optional. */
  onTextChange?: (text: string) => void;
  /** Auto-focus the input on mount. Default true. */
  autoFocus?: boolean;
  /**
   * Open the dropdown when the input receives focus (even with an empty
   * query). Default true so the speaker editor's "click pen → see options"
   * flow feels instant. Set false in the share dialog where we want users
   * to start typing before any options appear.
   */
  openOnFocus?: boolean;
  /** Compact layout — used inside a badge editor where vertical space is tight. */
  compact?: boolean;
}

/**
 * Searchable user picker. Debounces queries to /api/users/search (200ms) and
 * renders a dropdown under the input with the matching Trames directory
 * entries. In freeform mode, when the current text doesn't match any entry
 * exactly, the top option of the dropdown becomes "Use '<text>'" — the same
 * affordance as a typical tag combobox.
 */
export function UserPicker({
  mode,
  initialValue = '',
  placeholder = 'Search…',
  onSelect,
  onCustomSubmit,
  onCancel,
  onTextChange,
  autoFocus = true,
  openOnFocus = true,
  compact = false,
}: UserPickerProps) {
  const [query, setQuery] = useState(initialValue);
  const [results, setResults] = useState<PickerPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // 0 = "Use '<text>'" row when present in freeform mode; then the people list
  const [cursor, setCursor] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  // Debounced search. Fire immediately on first open with empty query so the
  // dropdown has content the moment the user sees it.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(
          `/api/users/search?q=${encodeURIComponent(query)}&limit=20`,
          { credentials: 'include' }
        );
        if (res.ok) {
          const { people } = (await res.json()) as { people: PickerPerson[] };
          setResults(people);
        }
      } catch {
        // silent — picker is best-effort
      } finally {
        setLoading(false);
      }
    }, query.length === 0 ? 0 : 200);
    return () => clearTimeout(t);
  }, [query, open]);

  /**
   * Whether to show the "Use '<text>'" affordance at the top of the dropdown.
   * Only in freeform mode, only when the query is non-empty, and only when
   * the query doesn't already exactly match one of the candidate names.
   */
  const showCustomOption = useMemo(() => {
    if (mode !== 'freeform') return false;
    if (query.trim().length === 0) return false;
    const q = query.trim().toLowerCase();
    return !results.some((p) => p.name.toLowerCase() === q);
  }, [mode, query, results]);

  const totalOptions = results.length + (showCustomOption ? 1 : 0);

  // Clamp cursor when the option list shrinks (e.g. query changes, fewer results).
  useEffect(() => {
    if (cursor >= totalOptions) setCursor(0);
  }, [totalOptions, cursor]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const commitCustom = useCallback(
    (text: string) => {
      if (onCustomSubmit) onCustomSubmit(text);
      else onSelect({ type: 'custom', text });
    },
    [onCustomSubmit, onSelect]
  );

  const commitAt = useCallback(
    (idx: number) => {
      if (showCustomOption && idx === 0) {
        commitCustom(query.trim());
        return;
      }
      const peopleIdx = showCustomOption ? idx - 1 : idx;
      const person = results[peopleIdx];
      if (person) {
        onSelect({ type: 'person', person });
      } else if (mode === 'freeform' && query.trim().length > 0) {
        commitCustom(query.trim());
      }
    },
    [commitCustom, mode, onSelect, query, results, showCustomOption]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => (totalOptions === 0 ? 0 : (c + 1) % totalOptions));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => (totalOptions === 0 ? 0 : (c - 1 + totalOptions) % totalOptions));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && totalOptions > 0) {
        commitAt(cursor);
      } else if (mode === 'freeform' && query.trim().length > 0) {
        commitCustom(query.trim());
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      onCancel?.();
    }
  };

  const inputHeightClass = compact ? 'h-7 text-xs' : '';

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        {!compact && (
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        )}
        <Input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value;
            setQuery(v);
            onTextChange?.(v);
            setOpen(true);
            setCursor(0);
          }}
          onFocus={() => {
            if (openOnFocus) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={`${compact ? inputHeightClass : 'pl-8'}`}
        />
      </div>

      {open && (totalOptions > 0 || loading) && (
        <div className="absolute left-0 z-50 mt-1 max-h-72 w-[22rem] max-w-[min(90vw,28rem)] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md">
          {loading && results.length === 0 && (
            <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Searching…
            </div>
          )}

          {showCustomOption && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commitAt(0);
              }}
              onMouseEnter={() => setCursor(0)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                cursor === 0 ? 'bg-accent text-accent-foreground' : ''
              }`}
            >
              <span className="text-green-700 dark:text-green-400">
                Use &quot;<span className="font-medium">{query.trim()}</span>&quot;
              </span>
              <Badge variant="outline" className="ml-auto text-[10px]">
                custom
              </Badge>
            </button>
          )}

          {results.length > 0 && (
            <div className="border-t first:border-t-0">
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {mode === 'strict' ? 'People' : 'People in Trames'}
              </div>
              {results.map((p, i) => {
                const optionIdx = (showCustomOption ? 1 : 0) + i;
                const active = cursor === optionIdx;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitAt(optionIdx);
                    }}
                    onMouseEnter={() => setCursor(optionIdx)}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${
                      active ? 'bg-accent text-accent-foreground' : ''
                    }`}
                  >
                    <User className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {p.email || p.slackHandle || '—'}
                      </div>
                    </div>
                    {p.team && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {p.team}
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
