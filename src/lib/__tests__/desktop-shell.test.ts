/**
 * Darth desktop shell detection (README "Darth desktop shell"): the
 * `DarthDesktop/<ver>` UA token decides `data-shell` / `data-shell-os` and
 * the `inDesktopShell` prop at SSR.
 */
import { describe, expect, test } from 'bun:test';
import { desktopShellOf, desktopShellOsOf, isInDesktopShell } from '../desktop-shell';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const shell = (ua: string) => `${ua} DarthDesktop/0.4.2`;

describe('isInDesktopShell', () => {
  test('the token, on any OS', () => {
    expect(isInDesktopShell(shell(CHROME_MAC))).toBe(true);
    expect(isInDesktopShell(shell(CHROME_WIN))).toBe(true);
    expect(isInDesktopShell(shell(CHROME_LINUX))).toBe(true);
  });
  test('a plain browser, an empty / missing UA, a lookalike without the slash', () => {
    expect(isInDesktopShell(CHROME_MAC)).toBe(false);
    expect(isInDesktopShell('')).toBe(false);
    expect(isInDesktopShell(null)).toBe(false);
    expect(isInDesktopShell(undefined)).toBe(false);
    expect(isInDesktopShell(`${CHROME_MAC} DarthDesktop`)).toBe(false);
  });
});

describe('desktopShellOsOf', () => {
  test('mac / win / linux / unknown', () => {
    expect(desktopShellOsOf(CHROME_MAC)).toBe('mac');
    expect(desktopShellOsOf(CHROME_WIN)).toBe('win');
    expect(desktopShellOsOf(CHROME_LINUX)).toBe('linux');
    expect(desktopShellOsOf('DarthDesktop/1.0')).toBeNull();
  });
});

describe('desktopShellOf', () => {
  test('inside the shell → {shell, os}', () => {
    expect(desktopShellOf(shell(CHROME_MAC))).toEqual({ shell: 'desktop', os: 'mac' });
    expect(desktopShellOf(shell(CHROME_WIN))).toEqual({ shell: 'desktop', os: 'win' });
    expect(desktopShellOf('DarthDesktop/1.0')).toEqual({ shell: 'desktop', os: null });
  });
  test('outside → null (the layout renders no data-shell at all)', () => {
    expect(desktopShellOf(CHROME_MAC)).toBeNull();
    expect(desktopShellOf(null)).toBeNull();
  });
});
