/**
 * The Darth desktop shell (Electron, repo `darth/desktop`) — detection.
 *
 * The shell appends `DarthDesktop/<version>` to a plain Chrome User-Agent;
 * that token is the whole contract (same as Darth Chat,
 * `src/lib/client/open-in-app.ts` there). The root layout reads the REQUEST's
 * UA at SSR time, sets `<html data-shell="desktop" data-shell-os="…">` and
 * hands `inDesktopShell` down as a prop, so the first paint is already right
 * and server and client never disagree (no hydration flash). Pure: no React,
 * no server imports.
 */

export const DESKTOP_SHELL_UA_TOKEN = 'DarthDesktop/';
export const DESKTOP_SHELL_VALUE = 'desktop';

export type DesktopShellOs = 'mac' | 'win' | 'linux';
export interface DesktopShell {
  shell: typeof DESKTOP_SHELL_VALUE;
  os: DesktopShellOs | null;
}

/** True when the UA is the Darth desktop shell's, on any OS. */
export function isInDesktopShell(ua: string | null | undefined): boolean {
  return typeof ua === 'string' && ua.includes(DESKTOP_SHELL_UA_TOKEN);
}

/** The desktop OS a (Chrome) UA names, or null. Windows first (no Windows UA
 * says Macintosh); Linux last because Android says Linux too (the shell never
 * runs there). */
export function desktopShellOsOf(ua: string): DesktopShellOs | null {
  if (/\bWindows\b/.test(ua)) return 'win';
  if (/\bMacintosh\b|\bMac OS X\b/.test(ua)) return 'mac';
  if (/\bLinux\b|\bX11\b|\bCrOS\b/.test(ua)) return 'linux';
  return null;
}

/** `{shell: 'desktop', os}` inside the shell; null in a browser. */
export function desktopShellOf(ua: string | null | undefined): DesktopShell | null {
  if (!ua || !isInDesktopShell(ua)) return null;
  return { shell: DESKTOP_SHELL_VALUE, os: desktopShellOsOf(ua) };
}
