/**
 * "Open in Darth" (family contract C1): the decision table and chat's
 * "did it open?" verdict, with fake UA / visibility facts.
 */
import { describe, expect, test } from 'bun:test';
import {
  DARTH_DESKTOP_DOWNLOAD_URL,
  OPEN_IN_APP_TIMEOUT_MS,
  OPEN_IN_DARTH_LABELS,
  appOpenVerdict,
  decideOpenInDarth,
  deepLinkFor,
  isMobileUa,
} from '../open-in-darth';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const EDGE_WIN = `${CHROME_WIN} Edg/140.0.0.0`;
const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_OLD =
  'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const shell = (ua: string) => `${ua} DarthDesktop/0.4.8`;

const page = { pathname: '/transcript/abc123', search: '?t=42', hash: '#u-7' };

describe('deepLinkFor', () => {
  test('darth://meetings + pathname + search + hash', () => {
    expect(deepLinkFor('/transcript/abc123', '?t=42', '#u-7')).toBe('darth://meetings/transcript/abc123?t=42#u-7');
    expect(deepLinkFor('/m/0b9c6a4e-1f2d-4c3b-9a8e-7d6c5b4a3f21')).toBe(
      'darth://meetings/m/0b9c6a4e-1f2d-4c3b-9a8e-7d6c5b4a3f21'
    );
    expect(deepLinkFor('/settings')).toBe('darth://meetings/settings');
  });
  test('the listing root keeps its slash and its query', () => {
    expect(deepLinkFor('/', '?label=ops%2Fq3&exact=1')).toBe('darth://meetings/?label=ops%2Fq3&exact=1');
    expect(deepLinkFor('')).toBe('darth://meetings/');
  });
  test('empty "?" / "#" are dropped; missing leading characters are added', () => {
    expect(deepLinkFor('/', '?', '#')).toBe('darth://meetings/');
    expect(deepLinkFor('settings', 'a=1', 'x')).toBe('darth://meetings/settings?a=1#x');
  });
  test('never asks for a new window', () => {
    expect(deepLinkFor('/', '?q=x')).not.toContain('window=new');
  });
});

describe('isMobileUa', () => {
  test('phones and tablets', () => {
    expect(isMobileUa(IPHONE)).toBe(true);
    expect(isMobileUa(IPAD_OLD)).toBe(true);
    expect(isMobileUa(ANDROID)).toBe(true);
    expect(isMobileUa(ANDROID_TABLET)).toBe(true);
    // iPadOS 13+ Safari: a desktop Mac UA with a touch screen.
    expect(isMobileUa(SAFARI_MAC, 5)).toBe(true);
  });
  test('desktops', () => {
    expect(isMobileUa(CHROME_MAC)).toBe(false);
    expect(isMobileUa(SAFARI_MAC, 0)).toBe(false);
    expect(isMobileUa(CHROME_WIN, 10)).toBe(false); // a touch-screen Windows laptop is still a desktop
    expect(isMobileUa(CHROME_LINUX)).toBe(false);
  });
});

describe('decideOpenInDarth — shown', () => {
  test.each([
    ['Chrome on a Mac', CHROME_MAC, 'mac'],
    ['Safari on a Mac', SAFARI_MAC, 'mac'],
    ['Chrome on Windows', CHROME_WIN, 'win'],
    ['Edge on Windows', EDGE_WIN, 'win'],
    ['Chrome on Linux', CHROME_LINUX, 'linux'],
    ['Firefox on Linux', FIREFOX_LINUX, 'linux'],
  ] as const)('%s', (_name, ua, os) => {
    expect(decideOpenInDarth({ ua, webdriver: false, ...page })).toEqual({
      kind: 'show',
      href: 'darth://meetings/transcript/abc123?t=42#u-7',
      os,
    });
  });
  test('search and hash are optional', () => {
    expect(decideOpenInDarth({ ua: CHROME_MAC, pathname: '/settings' })).toEqual({
      kind: 'show',
      href: 'darth://meetings/settings',
      os: 'mac',
    });
  });
});

describe('decideOpenInDarth — skipped', () => {
  test('inside the shell, on every OS (a darth:// nav from a shell view is dropped anyway)', () => {
    for (const ua of [CHROME_MAC, CHROME_WIN, CHROME_LINUX]) {
      expect(decideOpenInDarth({ ua: shell(ua), ...page })).toEqual({ kind: 'skip', why: 'in-shell' });
    }
  });
  test('an automated browser', () => {
    expect(decideOpenInDarth({ ua: CHROME_MAC, webdriver: true, ...page })).toEqual({
      kind: 'skip',
      why: 'automation',
    });
  });
  test('the shell wins over webdriver (most absolute refusal first)', () => {
    expect(decideOpenInDarth({ ua: shell(CHROME_MAC), webdriver: true, ...page })).toEqual({
      kind: 'skip',
      why: 'in-shell',
    });
  });
  test('phones and tablets — the shell does not exist there', () => {
    for (const ua of [IPHONE, IPAD_OLD, ANDROID, ANDROID_TABLET]) {
      expect(decideOpenInDarth({ ua, ...page })).toEqual({ kind: 'skip', why: 'unsupported-platform' });
    }
    expect(decideOpenInDarth({ ua: SAFARI_MAC, maxTouchPoints: 5, ...page })).toEqual({
      kind: 'skip',
      why: 'unsupported-platform',
    });
  });
  test('an empty or unrecognised UA', () => {
    expect(decideOpenInDarth({ ua: '', ...page })).toEqual({ kind: 'skip', why: 'unsupported-platform' });
    expect(decideOpenInDarth({ ua: 'curl/8.7.1', ...page })).toEqual({ kind: 'skip', why: 'unsupported-platform' });
    expect(decideOpenInDarth({ ua: undefined as unknown as string, ...page })).toEqual({
      kind: 'skip',
      why: 'unsupported-platform',
    });
  });
});

describe('appOpenVerdict (copied from chat)', () => {
  test('still visible and never left = the shell is not there', () => {
    expect(appOpenVerdict({ visibility: 'visible', leftPage: false })).toBe('not-opened');
  });
  test('hidden, or any pagehide/blur, = the shell took over', () => {
    expect(appOpenVerdict({ visibility: 'hidden', leftPage: false })).toBe('opened');
    expect(appOpenVerdict({ visibility: 'visible', leftPage: true })).toBe('opened');
    expect(appOpenVerdict({ visibility: 'hidden', leftPage: true })).toBe('opened');
    expect(appOpenVerdict({ visibility: 'prerender', leftPage: false })).toBe('opened');
  });
  test('the wait is the usual 1.5 s', () => {
    expect(OPEN_IN_APP_TIMEOUT_MS).toBe(1500);
  });
});

describe('copy and the download page', () => {
  test('the contract wording', () => {
    expect(OPEN_IN_DARTH_LABELS.button).toBe('Open in Darth');
    expect(`${OPEN_IN_DARTH_LABELS.notOpened} — ${OPEN_IN_DARTH_LABELS.install}`).toBe(
      "Darth didn't open — install it"
    );
  });
  test('the desktop download page from desktop/docs/DISTRIBUTION.md', () => {
    expect(DARTH_DESKTOP_DOWNLOAD_URL).toBe('https://cli.darth-internal.trames.io/darth-desktop/index.html');
  });
});
