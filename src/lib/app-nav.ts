/**
 * The app's three top-level surfaces — Meetings · Recordings · Series
 * (docs/recordings-meetings-series-design.md §3, Q11). A recording is not a
 * kind of meeting row, so Recordings is a sibling of Meetings, not a tab of
 * its listing. Pure: no React, no server imports.
 */

export interface AppNavItem {
  key: 'meetings' | 'recordings' | 'series';
  href: string;
  label: string;
  /** Needs the server: rendered disabled while offline/blocked. Meetings
   * stays live offline (cached shell → offline archive). */
  needsServer: boolean;
}

export const APP_NAV: readonly AppNavItem[] = [
  { key: 'meetings', href: '/', label: 'Meetings', needsServer: false },
  { key: 'recordings', href: '/recordings', label: 'Recordings', needsServer: true },
  { key: 'series', href: '/series', label: 'Series', needsServer: true },
];

/** Is this nav item the current surface? Meetings owns `/` only. */
export function navItemActive(item: AppNavItem, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (item.href === '/') return pathname === '/';
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * The old listing tabs `?tab=recordings` / `?tab=scratch` are their own
 * surface now (P6): links and bookmarks to them land on /recordings — the
 * Temporary section for scratch. Anything else stays on the listing.
 */
export function legacyTabRedirect(search: string): string | null {
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'recordings') return '/recordings';
  if (tab === 'scratch' || tab === 'temporary') return '/recordings#temporary';
  return null;
}
