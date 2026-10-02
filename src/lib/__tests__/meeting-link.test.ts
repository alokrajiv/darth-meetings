/**
 * "Copy link" (lib/meeting-link.ts): the permanent /m/<uuid> link with the
 * /transcript/<id> fallback, the ⌘⇧C matcher, and the clipboard write's
 * fallbacks (navigator stubbed — no DOM here).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { copyText, isCopyLinkShortcut, meetingLinkPath, meetingLinkUrl } from '../meeting-link';

const UUID = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b';

describe('meetingLinkPath / meetingLinkUrl', () => {
  test('a ledger uuid → /m/<uuid> (lower-cased)', () => {
    expect(meetingLinkPath({ meetingUuid: UUID, transcriptId: 'gmeet-abc' })).toBe(`/m/${UUID}`);
    expect(meetingLinkPath({ meetingUuid: UUID.toUpperCase(), transcriptId: 'x' })).toBe(`/m/${UUID}`);
  });
  test('no / malformed uuid → /transcript/<id>, encoded', () => {
    expect(meetingLinkPath({ meetingUuid: null, transcriptId: 'gmeet-abc' })).toBe('/transcript/gmeet-abc');
    expect(meetingLinkPath({ transcriptId: 'a b/c' })).toBe('/transcript/a%20b%2Fc');
    expect(meetingLinkPath({ meetingUuid: 'not-a-uuid', transcriptId: 'id1' })).toBe('/transcript/id1');
    expect(meetingLinkPath({ meetingUuid: `${UUID}/../x`, transcriptId: 'id1' })).toBe('/transcript/id1');
  });
  test('absolute on the origin, trailing slash dropped', () => {
    expect(meetingLinkUrl('https://meetings.darth-internal.trames.io/', { meetingUuid: UUID, transcriptId: 'x' })).toBe(
      `https://meetings.darth-internal.trames.io/m/${UUID}`
    );
  });
});

describe('isCopyLinkShortcut', () => {
  const k = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
    key: 'C',
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    ...over,
  });
  test('⌘⇧C and Ctrl+Shift+C', () => {
    expect(isCopyLinkShortcut(k({ metaKey: true }))).toBe(true);
    expect(isCopyLinkShortcut(k({ ctrlKey: true, key: 'c' }))).toBe(true);
  });
  test('plain copy, ⌥, or another key is not it', () => {
    expect(isCopyLinkShortcut(k({ metaKey: true, shiftKey: false }))).toBe(false);
    expect(isCopyLinkShortcut(k({ metaKey: true, altKey: true }))).toBe(false);
    expect(isCopyLinkShortcut(k({ shiftKey: true }))).toBe(false);
    expect(isCopyLinkShortcut(k({ metaKey: true, key: 'v' }))).toBe(false);
  });
});

describe('copyText', () => {
  const g = globalThis as unknown as { navigator?: unknown; ClipboardItem?: unknown };
  const saved = { navigator: g.navigator, ClipboardItem: g.ClipboardItem };
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true, writable: true });
    g.ClipboardItem = saved.ClipboardItem;
  });
  const setNavigator = (clipboard: unknown) =>
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true });

  test('a string goes to writeText', async () => {
    const wrote: string[] = [];
    setNavigator({ writeText: async (t: string) => void wrote.push(t) });
    expect(await copyText('https://x/m/1')).toBe(true);
    expect(wrote).toEqual(['https://x/m/1']);
  });

  test('a pending value uses a ClipboardItem when there is one (claimed inside the click)', async () => {
    const items: unknown[] = [];
    g.ClipboardItem = class {
      constructor(public data: Record<string, Promise<Blob>>) {}
    };
    setNavigator({ write: async (arr: unknown[]) => void items.push(...arr), writeText: async () => {} });
    expect(await copyText(Promise.resolve('https://x/m/2'))).toBe(true);
    const blob = await (items[0] as { data: Record<string, Promise<Blob>> }).data['text/plain'];
    expect(await blob!.text()).toBe('https://x/m/2');
  });

  test('no ClipboardItem → the value is awaited and written as text', async () => {
    g.ClipboardItem = undefined;
    const wrote: string[] = [];
    setNavigator({ writeText: async (t: string) => void wrote.push(t) });
    expect(await copyText(Promise.resolve('https://x/transcript/a'))).toBe(true);
    expect(wrote).toEqual(['https://x/transcript/a']);
  });

  test('a failing lookup copies nothing', async () => {
    g.ClipboardItem = undefined;
    setNavigator({ writeText: async () => {} });
    expect(await copyText(Promise.reject(new Error('nope')))).toBe(false);
  });
});
