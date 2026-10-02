import { describe, expect, test } from 'bun:test';
import {
  fetchNotice,
  formatSgtClock,
  isChunkLoadError,
  noticeEtaText,
  parseNotice,
} from '../maintenance-notice';

describe('parseNotice', () => {
  test('the shape deploy.sh writes', () => {
    const n = parseNotice({
      message: '  Deploying the recorder fixes — back by 12:40 SGT ',
      since: '2026-10-02T04:20:00Z',
      eta_at: '2026-10-02T04:40:00Z',
      build: 'a41a0ba-1759378800',
    });
    expect(n).toEqual({
      message: 'Deploying the recorder fixes — back by 12:40 SGT',
      since: '2026-10-02T04:20:00.000Z',
      etaAt: '2026-10-02T04:40:00.000Z',
      build: 'a41a0ba-1759378800',
    });
  });

  test('a JSON string parses the same as the object', () => {
    const n = parseNotice('{"message":"x","since":"2026-10-02T04:20:00Z","eta_at":null}');
    expect(n?.message).toBe('x');
    expect(n?.etaAt).toBeNull();
    expect(n?.build).toBeNull();
  });

  test('no message → no notice (there is never an automatic text)', () => {
    expect(parseNotice({ since: '2026-10-02T04:20:00Z' })).toBeNull();
    expect(parseNotice({ message: '   ' })).toBeNull();
    expect(parseNotice({ message: 42 })).toBeNull();
  });

  test('junk bodies are not a notice', () => {
    expect(parseNotice('')).toBeNull();
    expect(parseNotice('<!doctype html><title>Sign in</title>')).toBeNull();
    expect(parseNotice(null)).toBeNull();
    expect(parseNotice([{ message: 'x' }])).toBeNull();
  });

  test('bad dates drop out; a missing since falls back to the message', () => {
    const n = parseNotice({ message: 'hello', since: 'yesterday-ish', eta_at: 'soon' });
    expect(n?.etaAt).toBeNull();
    expect(n?.since).toBe('msg:hello');
  });

  test('control characters are stripped and the text is capped', () => {
    const n = parseNotice({ message: `a\u0000b\u0007c${'x'.repeat(900)}` });
    expect(n?.message.startsWith('abc')).toBe(true);
    expect(n?.message.length).toBe(500);
  });
});

describe('formatSgtClock / noticeEtaText', () => {
  const now = new Date('2026-10-02T04:25:00Z'); // 12:25 SGT

  test('same SGT day → bare clock', () => {
    expect(formatSgtClock('2026-10-02T04:40:00Z', now)).toBe('12:40 SGT');
  });

  test('crossing SGT midnight shows the weekday', () => {
    // 2026-10-02T16:30Z = Sat 00:30 SGT
    expect(formatSgtClock('2026-10-02T16:30:00Z', now)).toBe('Sat 00:30 SGT');
  });

  test('garbage → null', () => {
    expect(formatSgtClock('nope', now)).toBeNull();
  });

  test('future ETA → "until ~"', () => {
    expect(noticeEtaText({ etaAt: '2026-10-02T04:40:00Z' }, now)).toBe('until ~12:40 SGT');
  });

  test('past ETA → running late', () => {
    expect(noticeEtaText({ etaAt: '2026-10-02T04:10:00Z' }, now)).toBe('expected back ~12:10 SGT — running late');
  });

  test('no ETA → null', () => {
    expect(noticeEtaText({ etaAt: null }, now)).toBeNull();
  });
});

describe('fetchNotice', () => {
  const fake = (status: number, body: string) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  test('404 → null', async () => {
    expect(await fetchNotice(fake(404, 'not found'))).toBeNull();
  });

  test('200 JSON → the notice', async () => {
    const n = await fetchNotice(fake(200, JSON.stringify({ message: 'm', since: '2026-10-02T04:20:00Z' })));
    expect(n?.message).toBe('m');
  });

  test('a network error → null', async () => {
    const boom = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await fetchNotice(boom)).toBeNull();
  });

  test('requests no-store', async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_u: string, init?: RequestInit) => {
      seen = init;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    await fetchNotice(spy);
    expect(seen?.cache).toBe('no-store');
  });
});

describe('isChunkLoadError', () => {
  test('webpack / turbopack / browser shapes', () => {
    const named = new Error('Loading chunk 123 failed.');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk app-layout failed'))).toBe(true);
    expect(isChunkLoadError(new Error('Failed to load chunk /_next/static/chunks/abc.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/y.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  test('ordinary errors are not', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('Loading chunk 1 failed')).toBe(false);
  });
});
