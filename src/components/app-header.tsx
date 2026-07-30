'use client';

import Link from 'next/link';
import { AudioLines, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

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
  return (
    <header className="sticky top-0 z-40 h-14 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-3 px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <AudioLines className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">Meeting Whisperer</span>
        </Link>
        {breadcrumb && (
          <nav className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            <Link href="/" className="shrink-0 hover:text-foreground">
              Archive
            </Link>
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[280px] truncate font-medium text-foreground">
              {breadcrumb.title}
            </span>
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    </header>
  );
}
