/**
 * The listing's ONE layout (README "Darth desktop shell" → Layout rules).
 *
 * Meetings is laid out for the Darth desktop shell's window — 900–1300 px of
 * content, the shell's title band (with its own search) above, its 64 px rail
 * on the left — and the browser mirrors that same layout at every width.
 * There is no separate wide-browser variant; the only shell/browser
 * differences are the ones this module names:
 *
 *  - the in-app search field: hidden inside the shell (the band owns search
 *    and drives the results panel); in the browser it sits at the right of
 *    the single toolbar row, compact, with the `/` shortcut.
 *  - the theme: inside the shell it follows prefers-color-scheme (Darth sets
 *    it) and the account menu says "Theme · set in Darth"; in the browser the
 *    account menu keeps the light/dark toggle.
 *
 * Pure: no React, no DOM. The components read these lists so the tests can
 * pin the composition without rendering the whole listing.
 */

/** Nothing on the listing stretches past this (content px). */
export const LISTING_MAX_CONTENT_PX = 1400;
/** The window the layout is designed for (content px, rail excluded). */
export const DESIGN_CONTENT_MIN_PX = 900;
export const DESIGN_CONTENT_MAX_PX = 1300;
/** The browser's compact search field (expands on focus). */
export const TOOLBAR_SEARCH_PX = 240;

// ---- Toolbar ---------------------------------------------------------------

export type ToolbarControl = 'tabs' | 'search' | 'filter' | 'more';

/**
 * The toolbar is ONE row at every width: scope tabs on the left (they scroll
 * horizontally when the window is narrow), then the right-hand cluster —
 * search (browser only), ONE Filter button, the ⋯ menu.
 */
export function toolbarControls(inDesktopShell: boolean): {
  left: ToolbarControl[];
  right: ToolbarControl[];
} {
  return {
    left: ['tabs'],
    right: inDesktopShell ? ['filter', 'more'] : ['search', 'filter', 'more'],
  };
}

/** The `/` shortcut (and its hint) exists only where the in-app field does —
 * inside the shell the band has ⌘L. */
export function searchShortcutEnabled(inDesktopShell: boolean): boolean {
  return !inDesktopShell;
}

export type FilterSection = 'layers' | 'labels' | 'range' | 'people' | 'hidden';

/** The Filter popover's sections, top to bottom. "Hidden" only appears when
 * something is hidden. */
export function filterSections(opts: { hiddenCount: number }): FilterSection[] {
  const out: FilterSection[] = ['layers', 'labels', 'range', 'people'];
  if (opts.hiddenCount > 0) out.push('hidden');
  return out;
}

export interface FilterBadgeInput {
  layers: { archive: boolean; unimported: boolean; norec: boolean };
  /** Layers only shape the view on the All tab with no search / label filter. */
  layersApply: boolean;
  /** 'all' = no time range. */
  rangePreset: string;
  labelFilterActive: boolean;
  /** Number of people / organizer / provider terms. */
  peopleTerms: number;
}

/**
 * The Filter button's badge: how many filters narrow what is on screen right
 * now. Layers count once when any layer is off (and only where layers apply);
 * the time range and the label filter count once each; every people /
 * organizer / provider term counts. Hidden calendar meetings never count —
 * they are a standing preference, not a filter on this view.
 */
export function filterBadgeCount(i: FilterBadgeInput): number {
  let n = 0;
  if (i.layersApply && !(i.layers.archive && i.layers.unimported && i.layers.norec)) n += 1;
  if (i.rangePreset !== 'all') n += 1;
  if (i.labelFilterActive) n += 1;
  n += Math.max(0, i.peopleTerms);
  return n;
}

export type MoreMenuItem = 'sync' | 'refresh' | 'columns';

/** The toolbar's ⋯ menu: calendar sync status + "Sync now" (only while the
 * merged calendar timeline is showing), Refresh, the column chooser. */
export function moreMenuItems(opts: { calendarSync: boolean }): MoreMenuItem[] {
  return opts.calendarSync ? ['sync', 'refresh', 'columns'] : ['refresh', 'columns'];
}

// ---- Header ----------------------------------------------------------------

export type ImportAction = 'import-meeting' | 'import-file' | 'upload-media';

/** The header's split button: the primary half imports a meeting; the
 * chevron opens the other two. */
export const IMPORT_PRIMARY: ImportAction = 'import-meeting';
export const IMPORT_MENU: readonly ImportAction[] = ['import-file', 'upload-media'];
export const IMPORT_LABELS: Record<ImportAction, string> = {
  'import-meeting': 'Import meeting',
  'import-file': 'Import from…',
  'upload-media': 'Upload media',
};

export type AccountMenuItem = 'settings' | 'theme-toggle' | 'theme-shell' | 'sign-out';

/** The account menu at the header's far right. Inside the shell the theme
 * row is an inert "Theme · set in Darth"; in the browser it is the toggle. */
export function accountMenuItems(inDesktopShell: boolean): AccountMenuItem[] {
  return ['settings', inDesktopShell ? 'theme-shell' : 'theme-toggle', 'sign-out'];
}

export const THEME_SHELL_NOTE = 'Theme · set in Darth';

/**
 * Runs in <head> before first paint (layout.tsx). Inside the shell
 * (`<html data-shell="desktop">`, set at SSR) the theme follows
 * prefers-color-scheme — Darth owns the choice — and keeps following it
 * live; a stored browser choice is ignored there. In the browser: the
 * stored choice, else the OS preference (unchanged behaviour).
 */
export const THEME_BOOT_SCRIPT =
  "try{var d=document.documentElement,m=matchMedia('(prefers-color-scheme: dark)');" +
  "if(d.getAttribute('data-shell')==='desktop'){d.classList.toggle('dark',m.matches);" +
  "m.addEventListener('change',function(e){d.classList.toggle('dark',e.matches)})}" +
  "else{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&m.matches))d.classList.add('dark')}}catch(e){}";
