/**
 * "Open in Darth" — the web → desktop shell button (family contract C1,
 * `darth/plans/holocrons-shell-synergy/README.md`). In a desktop browser the
 * header offers a ghost button that hands the CURRENT page to the Darth
 * desktop shell through its deep-link scheme:
 *
 *   darth://meetings + location.pathname + location.search + location.hash
 *
 * (no `?window=new` — the shell shows it in the Meetings view). Never shown
 * inside the shell (a `darth://` navigation from a shell view is dropped
 * anyway), never to an automated browser, never on a phone or tablet (the
 * shell only exists for macOS / Windows / Linux).
 *
 * Pure functions only — no React, no "use client", no DOM reads of its own:
 * every decision takes the facts as arguments, so the whole rule is unit
 * tested without a browser (src/lib/__tests__/open-in-darth.test.ts). The
 * component (components/open-in-darth.tsx) reads navigator / location /
 * document and feeds them in. Helper names follow Darth Chat's
 * `src/lib/client/open-in-app.ts` (`isInDesktopShell`, `desktopShellOsOf`,
 * `appOpenVerdict`, `OPEN_IN_APP_TIMEOUT_MS`) so a later shared package is a
 * rename, not a redesign; the first two already live in ./desktop-shell.
 *
 * Custom schemes give NO feedback when the app is missing, so the only
 * heuristic is chat's: try it, wait OPEN_IN_APP_TIMEOUT_MS, and if the page
 * is still in front and never left, the shell did not take over → the button
 * becomes "Darth didn't open — install it" (DARTH_DESKTOP_DOWNLOAD_URL).
 * One attempt per page load.
 */
import { desktopShellOsOf, isInDesktopShell, type DesktopShellOs } from './desktop-shell';

export { desktopShellOsOf, isInDesktopShell };
export type { DesktopShellOs };

/** The shell's deep-link scheme and this app's id in its registry
 * (desktop `src/registry.js` APPS, `src/urls.js` deepLinkToHttps). */
export const DARTH_DEEP_LINK_SCHEME = 'darth';
export const MEETINGS_APP_ID = 'meetings';

/**
 * The desktop download page — `darth/desktop/docs/DISTRIBUTION.md`, "The
 * download page" / "Layout on .6": the shared static host serves the
 * rendered landing at `/darth-desktop/` and it picks the right installer for
 * the visitor's OS. Tailnet-only, like this app. `index.html` explicitly:
 * the site's catch-all `try_files $uri =404` serves no directory index, so
 * the bare folder URL 404s until the nginx line in DISTRIBUTION.md is added
 * (checked 2026-10-13: `/darth-desktop/` 404, `/darth-desktop/index.html` 200).
 */
export const DARTH_DESKTOP_DOWNLOAD_URL = 'https://cli.darth-internal.trames.io/darth-desktop/index.html';

// ---------------------------------------------------------------- platform

/**
 * True for a phone or tablet UA. Needed before `desktopShellOsOf`, which is
 * written for UAs already known to be the shell's: an iPhone UA says
 * "like Mac OS X" and an Android UA says "Linux". iPadOS 13+ Safari reports
 * a desktop "Macintosh" UA and is told apart from a real Mac only by its
 * touch screen (`maxTouchPoints > 1`, chat's `appPlatformFor` rule). Pure.
 */
export function isMobileUa(ua: string, maxTouchPoints = 0): boolean {
  if (/\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(ua)) return true;
  if (/\bMacintosh\b/.test(ua) && maxTouchPoints > 1) return true;
  return false;
}

// ---------------------------------------------------------------- decision

/** Everything the decision needs; the component reads these off `navigator` / `location`. */
export interface OpenInDarthFacts {
  /** navigator.userAgent */
  ua: string;
  /** navigator.webdriver — an automated browser never gets the button */
  webdriver?: boolean;
  /** navigator.maxTouchPoints (tells an iPad from a Mac) */
  maxTouchPoints?: number;
  /** location.pathname */
  pathname: string;
  /** location.search, '' when there is none */
  search?: string;
  /** location.hash, '' when there is none */
  hash?: string;
}

/** Why nothing is shown, so a caller (and a test) can tell the cases apart. */
export type OpenInDarthSkip = 'in-shell' | 'automation' | 'unsupported-platform';

export type OpenInDarthDecision =
  | { kind: 'show'; href: string; os: DesktopShellOs }
  | { kind: 'skip'; why: OpenInDarthSkip };

/** `darth://meetings/<path>?<query>#<hash>` for the given page. Pure. */
export function deepLinkFor(pathname: string, search = '', hash = ''): string {
  const path = pathname ? (pathname.startsWith('/') ? pathname : `/${pathname}`) : '/';
  const q = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : '';
  const h = hash && hash !== '#' ? (hash.startsWith('#') ? hash : `#${hash}`) : '';
  return `${DARTH_DEEP_LINK_SCHEME}://${MEETINGS_APP_ID}${path}${q}${h}`;
}

/** The whole C1 rule in one pure function; the cheapest, most absolute refusals first. */
export function decideOpenInDarth(f: OpenInDarthFacts): OpenInDarthDecision {
  const ua = typeof f.ua === 'string' ? f.ua : '';
  if (isInDesktopShell(ua)) return { kind: 'skip', why: 'in-shell' };
  if (f.webdriver) return { kind: 'skip', why: 'automation' };
  if (!ua || isMobileUa(ua, f.maxTouchPoints ?? 0)) return { kind: 'skip', why: 'unsupported-platform' };
  const os = desktopShellOsOf(ua);
  if (!os) return { kind: 'skip', why: 'unsupported-platform' };
  return { kind: 'show', href: deepLinkFor(f.pathname, f.search ?? '', f.hash ?? ''), os };
}

// ---------------------------------------------------------------- "did it open?"

/** How long to wait after the scheme navigation before deciding the shell is not there (chat's value). */
export const OPEN_IN_APP_TIMEOUT_MS = 4000; // was 1500 (chat's); 4 s so Chrome's own "Open Darth?" prompt is not mistaken for "not installed" (2026-10-15)

/** What the page looked like when the timer fired. */
export interface AppOpenProbe {
  /** document.visibilityState at the moment the timer fired */
  visibility: string;
  /** a `pagehide`, `blur` or `visibilitychange`-to-hidden fired since the attempt */
  leftPage: boolean;
}

/**
 * The verdict of the OPEN_IN_APP_TIMEOUT_MS timer (copied from chat). A
 * handover to the shell backgrounds or blurs this page, so anything but
 * "still visible and never left" means the shell took over. Pure.
 */
export function appOpenVerdict(p: AppOpenProbe): 'opened' | 'not-opened' {
  if (p.leftPage) return 'opened';
  return p.visibility === 'visible' ? 'not-opened' : 'opened';
}

// ---------------------------------------------------------------- copy

/** Every word the button says (literal chrome: no lore, no emoji). */
export const OPEN_IN_DARTH_LABELS = {
  button: 'Open in Darth',
  buttonTitle: 'Open this page in the Darth desktop app',
  notOpened: "Darth didn't open",
  install: 'install it',
} as const;

/** data-testids for the browser rig. */
export const OPEN_IN_DARTH_TESTID = {
  button: 'open-in-darth',
  missing: 'open-in-darth-missing',
} as const;
