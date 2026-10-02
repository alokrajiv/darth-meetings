'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CircleUser, LogOut, Moon, Palette, Settings, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useShellSearch } from '@/components/shell-search';
import { signOut } from '@/components/logout-button';
import { toggleTheme } from '@/components/theme-toggle';
import { usePopover } from '@/hooks/use-popover';
import { THEME_SHELL_NOTE, accountMenuItems } from '@/lib/listing-layout';

/**
 * The header's far-right account menu (README "Darth desktop shell" →
 * Layout rules): Settings, the theme row, Sign out — what used to be three
 * loose icons. Inside the shell the theme row is an inert "Theme · set in
 * Darth" (the page follows prefers-color-scheme); in the browser it toggles
 * light/dark. The signed-in e-mail heads the menu once /api/whoami answers
 * (fetched on first open, once per page load).
 */

let whoamiCache: Promise<string | null> | null = null;
function fetchEmail(): Promise<string | null> {
  whoamiCache ??= fetch('/api/whoami', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { email?: string } | null) => j?.email ?? null)
    .catch(() => {
      whoamiCache = null; // retry on the next open
      return null;
    });
  return whoamiCache;
}

const itemCls =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

export function AccountMenu({
  inDesktopShell: shellProp,
  defaultOpen = false,
}: {
  /** Defaults to the SSR-decided shell flag (ShellSearchProvider). */
  inDesktopShell?: boolean;
  /** Tests render the menu open. */
  defaultOpen?: boolean;
}) {
  const shell = useShellSearch();
  const inDesktopShell = shellProp ?? shell.inDesktopShell;
  const { open, toggle, close, ref } = usePopover(defaultOpen);
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!open || email) return;
    let live = true;
    void fetchEmail().then((e) => {
      if (live) setEmail(e);
    });
    return () => {
      live = false;
    };
  }, [open, email]);

  return (
    <div className="relative" ref={ref} data-account-menu>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        aria-label="Account"
        title="Account"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <CircleUser className="h-[18px] w-[18px]" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          {email && (
            <p className="truncate border-b px-2.5 pb-1.5 pt-1 text-xs text-muted-foreground" title={email}>
              {email}
            </p>
          )}
          {accountMenuItems(inDesktopShell).map((item) => {
            switch (item) {
              case 'settings':
                return (
                  <Link
                    key={item}
                    href="/settings"
                    role="menuitem"
                    data-account-item="settings"
                    className={itemCls}
                    onClick={close}
                  >
                    <Settings className="h-4 w-4 text-muted-foreground" />
                    Settings
                  </Link>
                );
              case 'theme-toggle':
                return (
                  <button
                    key={item}
                    type="button"
                    role="menuitem"
                    data-account-item="theme-toggle"
                    className={itemCls}
                    onClick={() => toggleTheme()}
                  >
                    <Moon className="h-4 w-4 text-muted-foreground dark:hidden" />
                    <Sun className="hidden h-4 w-4 text-muted-foreground dark:block" />
                    <span className="dark:hidden">Dark theme</span>
                    <span className="hidden dark:inline">Light theme</span>
                  </button>
                );
              case 'theme-shell':
                return (
                  <div
                    key={item}
                    role="menuitem"
                    aria-disabled="true"
                    data-account-item="theme-shell"
                    title="Darth sets the theme; this window follows it"
                    className="flex items-center gap-2.5 px-2.5 py-1.5 text-sm text-muted-foreground"
                  >
                    <Palette className="h-4 w-4" />
                    {THEME_SHELL_NOTE}
                  </div>
                );
              case 'sign-out':
                return (
                  <div key={item} className="mt-1 border-t pt-1">
                    <button
                      type="button"
                      role="menuitem"
                      data-account-item="sign-out"
                      className={itemCls}
                      onClick={() => void signOut()}
                    >
                      <LogOut className="h-4 w-4 text-muted-foreground" />
                      Sign out
                    </button>
                  </div>
                );
            }
          })}
        </div>
      )}
    </div>
  );
}
