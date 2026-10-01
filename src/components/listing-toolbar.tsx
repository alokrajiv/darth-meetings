'use client';

import type { ReactNode, Ref } from 'react';
import { Ellipsis, Filter, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePopover } from '@/hooks/use-popover';
import { searchShortcutEnabled, toolbarControls } from '@/lib/listing-layout';

/**
 * The listing toolbar — ONE row at every width (README "Darth desktop shell"
 * → Layout rules; lib/listing-layout `toolbarControls`). Left: the scope
 * tabs, which scroll horizontally when the window is too narrow instead of
 * wrapping. Right, never shrinking: the compact search field (browser only —
 * inside the shell the title band owns search), ONE Filter button with a
 * count badge, the ⋯ menu. Pure layout: the host passes each piece in.
 */
export function ListingToolbar({
  inDesktopShell,
  tabs,
  search,
  filter,
  more,
}: {
  inDesktopShell: boolean;
  tabs: ReactNode;
  /** Rendered only outside the shell. */
  search: ReactNode;
  filter: ReactNode;
  more: ReactNode;
}) {
  const { left, right } = toolbarControls(inDesktopShell);
  const slot = { tabs, search, filter, more } as const;
  return (
    <div
      data-listing-toolbar
      data-toolbar-mode={inDesktopShell ? 'shell' : 'browser'}
      className="mb-3 flex flex-nowrap items-end gap-3 border-b"
    >
      <div
        data-toolbar-left
        className="flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {left.map((k) => (
          <div key={k} className="flex shrink-0 items-center whitespace-nowrap">
            {slot[k]}
          </div>
        ))}
      </div>
      <div data-toolbar-right className="flex shrink-0 flex-nowrap items-center gap-1.5 pb-1.5">
        {right.map((k) => (
          <div key={k} data-toolbar-control={k} className="flex items-center">
            {slot[k]}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The browser's compact search field: 240 px, wider while focused, `/` hint. */
export function ToolbarSearch({
  inputRef,
  value,
  onChange,
  disabled = false,
  disabledTitle,
  inDesktopShell = false,
}: {
  inputRef?: Ref<HTMLInputElement>;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  disabledTitle?: string;
  inDesktopShell?: boolean;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        data-testid="meetings-search-input"
        placeholder="Search meetings…"
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        className="peer h-8 w-[240px] pl-8 pr-8 transition-[width] duration-150 focus:w-[320px]"
      />
      {searchShortcutEnabled(inDesktopShell) && (
        <kbd
          data-search-shortcut
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground peer-focus:hidden"
        >
          /
        </kbd>
      )}
    </div>
  );
}

/** ONE Filter button + its popover; the host passes the sections. */
export function FilterPopover({
  count,
  disabled = false,
  disabledTitle,
  defaultOpen = false,
  onClearAll,
  children,
}: {
  count: number;
  disabled?: boolean;
  disabledTitle?: string;
  defaultOpen?: boolean;
  onClearAll?: () => void;
  children: ReactNode;
}) {
  const { open, toggle, ref } = usePopover(defaultOpen);
  return (
    <div className="relative" ref={ref}>
      <Button
        variant={count > 0 ? 'secondary' : 'outline'}
        size="sm"
        className="h-8 gap-1.5 px-2.5"
        disabled={disabled}
        title={disabled ? disabledTitle : 'Layers, labels, time range, people'}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-filter-button
        onClick={toggle}
      >
        <Filter className="h-3.5 w-3.5" />
        <span className="text-xs">Filter</span>
        {count > 0 && (
          <span
            data-filter-badge
            className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground tabular-nums"
          >
            {count}
          </span>
        )}
      </Button>
      {open && !disabled && (
        <div
          role="dialog"
          aria-label="Filters"
          data-filter-popover
          className="absolute right-0 top-full z-50 mt-1.5 max-h-[min(75vh,640px)] w-80 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          {children}
          {onClearAll && (
            <div className="mt-1 flex justify-end border-t px-2 pb-1 pt-1.5">
              <button
                type="button"
                disabled={count === 0}
                onClick={onClearAll}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One titled block inside the Filter popover / ⋯ menu. */
export function ToolbarSection({
  id,
  title,
  aside,
  children,
  first = false,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  first?: boolean;
}) {
  return (
    <section data-toolbar-section={id} className={first ? 'px-1 pb-1.5' : 'border-t px-1 pb-1.5 pt-1'}>
      <div className="flex items-center justify-between gap-2 px-1 pb-1 pt-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The toolbar's ⋯ menu (sync status/action, refresh, columns). */
export function MoreMenu({
  defaultOpen = false,
  children,
}: {
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { open, toggle, ref } = usePopover(defaultOpen);
  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        title="Sync, refresh, columns"
        aria-label="More listing options"
        aria-expanded={open}
        aria-haspopup="menu"
        data-more-button
        onClick={toggle}
      >
        <Ellipsis className="h-4 w-4" />
      </Button>
      {open && (
        <div
          role="menu"
          data-more-menu
          className="absolute right-0 top-full z-50 mt-1.5 max-h-[min(75vh,640px)] w-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          {children}
        </div>
      )}
    </div>
  );
}
