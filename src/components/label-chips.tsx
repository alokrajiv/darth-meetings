'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Tag, X } from 'lucide-react';
import type { LabelRef } from '@/lib/format';
import { effectiveColor } from '@/lib/labels';
import { useLabelCatalog } from '@/hooks/use-label-catalog';

/**
 * Label chips for a transcript (listing row / detail page).
 *
 * Colored dot + leaf name, full path on hover, max N visible + "+N" overflow
 * popover. Clicking a chip sets the label filter (stopPropagation so the row
 * click doesn't navigate). `onAdd` renders the ghost "+" affordance — on
 * listing rows it's hover-revealed like SeriesBadge's 'row' variant; on the
 * detail page ('full') it's always visible and labelled. The parent opens
 * the shared LabelPicker; this component owns no state beyond the overflow
 * popover. Color inheritance (null = parent's) is resolved against the
 * shared catalog.
 */

export interface LabelChipsProps {
  labels: LabelRef[] | null | undefined;
  /** Click a chip → filter by that label (listing). Omit for inert chips. */
  onFilter?: (label: LabelRef) => void;
  /** Renders the ghost "+" button; receives the click (anchor = currentTarget). */
  onAdd?: (e: React.MouseEvent<HTMLElement>) => void;
  /** Editors on the detail page get an "x" per chip. */
  onRemove?: (label: LabelRef) => void;
  max?: number;
  variant?: 'row' | 'full';
  /** Fill-and-fit the available width: chips shrink + truncate instead of
   * overflowing, keeping the "+N" badge and the add "+" visible (used by
   * the listing's width-capped Labels column). */
  fit?: boolean;
  className?: string;
}

export function labelDotColor(
  label: LabelRef,
  byId: ReadonlyMap<number, { color: string | null; parent_id: number | null }>
): string | null {
  const row = byId.get(label.id);
  if (row) return effectiveColor(row, byId);
  return label.color;
}

/** The colored dot; grey when no own/inherited color. */
export function LabelDot({ color, className = '' }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={`h-2 w-2 shrink-0 rounded-full ${color ? '' : 'bg-muted-foreground/45'} ${className}`}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

export function LabelChip({
  label,
  color,
  onClick,
  onRemove,
  size = 'sm',
  flexible = false,
}: {
  label: LabelRef;
  color: string | null;
  onClick?: (e: React.MouseEvent) => void;
  onRemove?: (label: LabelRef) => void;
  size?: 'sm' | 'md';
  /** Shrink below max-w to share a width-capped container (fit mode). */
  flexible?: boolean;
}) {
  const dot = <LabelDot color={color} />;
  const cls = `inline-flex max-w-28 ${flexible ? 'min-w-0 shrink' : 'shrink-0'} items-center gap-1 rounded-full border border-border bg-muted/40 px-2 ${
    size === 'md' ? 'py-0.5 text-xs' : 'py-0.5 text-[11px]'
  } text-foreground/80 transition-colors ${onClick ? 'hover:bg-muted cursor-pointer' : ''}`;
  const body = (
    <>
      {dot}
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <span
          role="button"
          tabIndex={-1}
          title="Remove label"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onRemove(label);
          }}
          className="-mr-1 ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="h-2.5 w-2.5" />
        </span>
      )}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        title={`${label.path} — click to filter by this label`}
        onClick={(e) => {
          e.stopPropagation();
          onClick(e);
        }}
        className={cls}
        data-label-chip={label.id}
      >
        {body}
      </button>
    );
  }
  return (
    <span title={label.path} className={cls} data-label-chip={label.id}>
      {body}
    </span>
  );
}

export function LabelChips({
  labels,
  onFilter,
  onAdd,
  onRemove,
  max = 2,
  variant = 'row',
  fit = false,
  className = '',
}: LabelChipsProps) {
  const { byId } = useLabelCatalog();
  const [moreOpen, setMoreOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        !moreBtnRef.current?.contains(e.target as Node)
      ) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    const onScroll = () => setMoreOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [moreOpen]);

  const list = labels ?? [];
  const shown = variant === 'full' ? list : list.slice(0, max);
  const rest = variant === 'full' ? [] : list.slice(max);

  if (list.length === 0 && !onAdd) return null;

  return (
    <span
      className={`${fit ? 'flex' : 'inline-flex shrink-0'} min-w-0 items-center gap-1 ${className}`}
    >
      {shown.map((l) => (
        <LabelChip
          key={l.id}
          label={l}
          color={labelDotColor(l, byId)}
          onClick={onFilter ? () => onFilter(l) : undefined}
          onRemove={onRemove}
          size={variant === 'full' ? 'md' : 'sm'}
          flexible={fit}
        />
      ))}
      {rest.length > 0 && (
        <>
          <button
            ref={moreBtnRef}
            type="button"
            title={rest.map((l) => l.path).join('\n')}
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const width = 260;
              setPos({
                top: rect.bottom + 6,
                left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
              });
              setMoreOpen((v) => !v);
            }}
            className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:bg-muted"
          >
            +{rest.length}
          </button>
          {moreOpen && pos && (
            <div
              ref={popRef}
              onClick={(e) => e.stopPropagation()}
              style={{ position: 'fixed', top: pos.top, left: pos.left, width: 260 }}
              className="z-50 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
            >
              <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                All labels
              </p>
              <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                {list.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    disabled={!onFilter}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMoreOpen(false);
                      onFilter?.(l);
                    }}
                    title={onFilter ? `Filter by ${l.path}` : l.path}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <LabelDot color={labelDotColor(l, byId)} />
                    <span className="min-w-0 flex-1 truncate">{l.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {onAdd && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdd(e);
          }}
          title={variant === 'full' ? 'Add a label (l)' : 'Add a label'}
          data-label-add
          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-dashed border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-all hover:border-primary/40 hover:text-primary ${
            variant === 'row' ? 'opacity-0 group-hover:opacity-100' : ''
          }`}
        >
          <Tag className="h-3 w-3" />
          <Plus className="h-2.5 w-2.5" />
          {variant === 'full' && <span className="ml-0.5">Label</span>}
        </button>
      )}
    </span>
  );
}
