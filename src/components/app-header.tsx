'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AudioLines, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { OfflineChip } from '@/components/offline-chip';
import { RecorderChip } from '@/components/recorder-chip';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { APP_NAV, navItemActive } from '@/lib/app-nav';

interface AppHeaderProps {
  /** Right-aligned actions slot. */
  children?: ReactNode;
  /** When set, renders an "Archive › {title}" breadcrumb after the brand. */
  breadcrumb?: { title: string };
}

/**
 * Shared sticky app shell header. Pages render it themselves (the actions
 * slot differs per page); layout.tsx stays uninvolved.
 */
export function AppHeader({ children, breadcrumb }: AppHeaderProps) {
  const pathname = usePathname();
  const { blocked } = useOfflineGate();
  return (
    <header className="sticky top-0 z-40 h-14 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1720px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        {/* Phone with the nav showing: the mark goes (the nav's Meetings is
            the same link) — the three-way control is the width budget. */}
        <Link href="/" className={`${breadcrumb ? 'flex' : 'hidden sm:flex'} shrink-0 items-center gap-2`}>
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <AudioLines className="h-4 w-4" />
          </span>
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">Darth Meetings</span>
        </Link>
        {!breadcrumb && (
          // Meetings · Recordings · Series (docs/recordings-meetings-series-
          // design.md §3, Q11) — three sibling surfaces. Phone width: a
          // segmented control; wider: plain links. Recordings and Series
          // need the server; Meetings stays live offline (cached shell →
          // offline archive).
          <nav
            aria-label="Sections"
            data-app-nav
            className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-[13px] sm:gap-1 sm:bg-transparent sm:p-0 sm:text-sm"
          >
            {APP_NAV.map((l) => {
              const active = navItemActive(l, pathname);
              const base = 'rounded-md px-2 py-1 transition-colors';
              if (l.needsServer && blocked) {
                return (
                  <span
                    key={l.href}
                    aria-disabled="true"
                    title={OFFLINE_TITLE}
                    className={`${base} cursor-not-allowed text-muted-foreground/50`}
                  >
                    {l.label}
                  </span>
                );
              }
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? 'page' : undefined}
                  data-nav={l.key}
                  className={`${base} ${
                    active
                      ? 'bg-background font-medium text-foreground shadow-sm sm:bg-muted sm:shadow-none'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        )}
        {breadcrumb && (
          <nav className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
            {/* Phone: the wordmark and "Archive ›" go; the title stays. The
                right-hand cluster is the width budget at 390 px (2026-09-21). */}
            <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 sm:block" />
            <Link href="/" className="hidden shrink-0 hover:text-foreground sm:inline">
              Archive
            </Link>
            <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 sm:block" />
            <span className="max-w-[280px] truncate font-medium text-foreground">
              {breadcrumb.title}
            </span>
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          {children}
          <OfflineChip />
          <RecorderChip />
          <span className="hidden sm:inline-flex">
            <ThemeToggle />
          </span>
        </div>
      </div>
    </header>
  );
}
