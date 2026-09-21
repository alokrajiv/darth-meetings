'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Ellipsis, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The ONE menu idiom of the listing (docs/listing-ui-redesign.md §2.7):
 * a hover-revealed "⋯" on every row, or a small labelled trigger
 * ("Add recording ▾") when the menu IS the row's action. Fixed-position
 * popover (escapes the table's overflow-hidden), closes on outside click,
 * Escape or any scroll — same idiom as SeriesBadge and the old gear.
 *
 * Every click stops propagation: rows are clickable.
 */

export interface RowMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  /** One muted line under the label — the "why", never a paragraph. */
  hint?: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  busy?: boolean;
}

export interface RowMenuSection {
  key: string;
  heading?: string;
  items: RowMenuItem[];
}

export interface RowMenuProps {
  sections: RowMenuSection[];
  /** 'dots' (default) = hover-revealed ⋯ icon; a string = a visible outline
   * button with that label and a chevron. */
  trigger?: 'dots' | string;
  triggerIcon?: React.ReactNode;
  /** Kept visible (not hover-only) — for dots on touch-first surfaces. */
  alwaysVisible?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  ariaLabel?: string;
  width?: number;
  /** Header line inside the popover (the row's title, a question, …). */
  header?: React.ReactNode;
  /** Error to show under the items (set by the host after a failed action). */
  error?: string | null;
  /** The whole menu is busy (host is running an item). */
  busy?: boolean;
  className?: string;
  /** Test hook. */
  dataAttr?: string;
}

export function RowMenu({
  sections,
  trigger = 'dots',
  triggerIcon,
  alwaysVisible = false,
  disabled = false,
  disabledTitle,
  ariaLabel,
  width = 272,
  header,
  error,
  busy = false,
  className = '',
  dataAttr,
}: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = () => close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      close();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Right-align under the trigger; clamp inside the viewport.
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setPos({ top: rect.bottom + 6, left });
    setOpen(true);
  };

  const isDots = trigger === 'dots';
  const items = sections.flatMap((s) => s.items);
  if (items.length === 0) return null;

  return (
    <>
      {isDots ? (
        <Button
          ref={btnRef}
          size="sm"
          variant="ghost"
          aria-label={ariaLabel ?? 'More'}
          aria-expanded={open}
          aria-haspopup="menu"
          title={disabled ? disabledTitle : ariaLabel ?? 'More'}
          disabled={disabled}
          data-row-menu={dataAttr ?? ''}
          onClick={toggle}
          className={`h-7 w-7 p-0 text-muted-foreground transition-opacity hover:text-foreground ${
            alwaysVisible || open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          } ${className}`}
        >
          <Ellipsis className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          ref={btnRef}
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-haspopup="menu"
          title={disabled ? disabledTitle : undefined}
          disabled={disabled}
          data-row-menu={dataAttr ?? ''}
          onClick={toggle}
          className={`h-7 gap-1 px-2.5 text-xs font-medium ${className}`}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : triggerIcon}
          {trigger}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      )}
      {open && pos && (
        <div
          ref={popRef}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width }}
          className="z-50 rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          {header && <div className="px-2 pb-1.5 pt-1 text-xs">{header}</div>}
          {sections.map((s, si) => (
            <div key={s.key} className={si > 0 ? 'mt-1 border-t pt-1' : ''}>
              {s.heading && (
                <p className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {s.heading}
                </p>
              )}
              {s.items.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled || it.busy || busy}
                  title={it.title}
                  data-row-menu-item={it.key}
                  onClick={() => {
                    const r = it.onSelect();
                    if (r && typeof (r as Promise<void>).then === 'function') {
                      void (r as Promise<void>).finally(close);
                    } else {
                      close();
                    }
                  }}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
                    it.danger ? 'text-destructive hover:bg-destructive/10' : ''
                  }`}
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">
                    {it.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : it.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{it.label}</span>
                    {it.hint && (
                      <span className="block text-[11px] leading-snug text-muted-foreground">{it.hint}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {error && <p className="px-2 pb-1 pt-1.5 text-xs text-destructive">{error}</p>}
        </div>
      )}
    </>
  );
}
