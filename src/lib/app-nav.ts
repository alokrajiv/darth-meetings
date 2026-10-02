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
}

export const APP_NAV: readonly AppNavItem[] = [
  { key: 'meetings', href: '/', label: 'Meetings' },
  { key: 'recordings', href: '/recordings', label: 'Recordings' },
  { key: 'series', href: '/series', label: 'Series' },
];

/** Is this nav item the current surface? Meetings owns `/` only. */
export function navItemActive(item: AppNavItem, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (item.href === '/') return pathname === '/';
  // A single recording's page (`/recording/<id>`, design P7) belongs to Recordings.
  if (item.key === 'recordings' && pathname.startsWith('/recording/')) return true;
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
