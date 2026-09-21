'use client';

import { User } from 'lucide-react';
import { personDisplay, personHue } from '@/lib/person-display';

/**
 * Owner / organizer as a person (docs/listing-ui-redesign.md §2.6): a
 * small initials avatar with a stable per-person hue, then the first name.
 * `self` renders "You" with a primary-tinted avatar. Never an e-mail on
 * the row — it lives in the tooltip.
 */
export function PersonChip({
  email,
  name,
  self = false,
  trailing,
  className = '',
}: {
  email: string | null | undefined;
  name?: string | null;
  self?: boolean;
  /** e.g. the Editor / Read badge for shared rows. */
  trailing?: React.ReactNode;
  className?: string;
}) {
  const p = personDisplay(email, name);
  const known = !!(email || name);
  const hue = personHue((email || name || '').toLowerCase());
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}
      title={self ? 'You' : p.email ? `${p.full} · ${p.email}` : p.full}
      data-person={self ? 'self' : p.email || undefined}
    >
      {self ? (
        <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
          <User className="h-2.5 w-2.5" />
        </span>
      ) : known ? (
        <span
          className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[9px] font-semibold leading-none text-foreground/80"
          style={{ background: `oklch(from var(--muted) l 0.06 ${hue})` }}
          aria-hidden
        >
          {p.initials}
        </span>
      ) : null}
      <span className="truncate text-xs text-muted-foreground">{self ? 'You' : p.first}</span>
      {trailing}
    </span>
  );
}
