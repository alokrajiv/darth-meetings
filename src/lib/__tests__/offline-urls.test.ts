import { describe, expect, test } from 'bun:test';
import {
  TRANSCRIPT_API_SUFFIXES,
  estimatePinBytes,
  extractFrameUrls,
  extractStaticAssets,
  levelIncludes,
  levelRank,
  maxLevel,
  partCount,
  urlsForLevel,
  urlsToDrop,
} from '@/lib/offline/offline-urls';
import type { PlanMeeting } from '@/lib/offline/offline-types';

const ID = 'abc123';
const BASE = `/api/transcripts/${ID}`;

function meeting(parts: number, opts: { hasLocal?: boolean; isVideo?: boolean; bytes?: number } = {}): PlanMeeting {
  const hasLocal = opts.hasLocal ?? parts > 0;
  return {
    id: ID,
    title: 'Weekly sync',
    recordedAt: '2026-09-10T09:00:00.000Z',
    createdAt: '2026-09-10T10:00:00.000Z',
    durationSec: 3600,
    provider: 'gmeet',
    rev: 'r1',
    media: {
      hasLocal,
      isVideo: opts.isVideo ?? true,
      parts: Array.from({ length: parts }, (_, i) => ({
        part: i + 1,
        filename: `f${i + 1}.mp4`,
        isVideo: opts.isVideo ?? true,
        bytes: opts.bytes ?? null,
      })),
    },
  };
}

describe('level ladder', () => {
  test('ranks and inclusion', () => {
    expect(levelRank('none')).toBe(0);
    expect(levelRank('video')).toBe(3);
    expect(levelIncludes('audio', 'transcript')).toBe(true);
    expect(levelIncludes('transcript', 'audio')).toBe(false);
    expect(levelIncludes('video', 'video')).toBe(true);
    expect(maxLevel('audio', 'transcript')).toBe('audio');
    expect(maxLevel('none', 'video')).toBe('video');
  });
});

describe('urlsForLevel', () => {
  test("'none' → nothing", () => {
    expect(urlsForLevel(ID, 'none', meeting(1))).toEqual({ pages: [], api: [], media: [] });
  });

  test('transcript → document + the API set, no media', () => {
    const set = urlsForLevel(ID, 'transcript', meeting(1));
    expect(set.pages).toEqual([`/transcript/${ID}`]);
    expect(set.api).toEqual(TRANSCRIPT_API_SUFFIXES.map((s) => BASE + s));
    expect(set.api).toContain(BASE);
    expect(set.api).toContain(`${BASE}/content`);
    expect(set.api).toContain(`${BASE}/attachments`);
    expect(set.media).toEqual([]);
  });

  test('audio → audio-only variant per part', () => {
    const set = urlsForLevel(ID, 'audio', meeting(3));
    expect(set.media).toEqual([
      `${BASE}/audio?variant=audio`,
      `${BASE}/audio?variant=audio&part=2`,
      `${BASE}/audio?variant=audio&part=3`,
    ]);
  });

  test('video → audio variants AND full recordings', () => {
    const set = urlsForLevel(ID, 'video', meeting(2));
    expect(set.media).toEqual([
      `${BASE}/audio?variant=audio`,
      `${BASE}/audio?variant=audio&part=2`,
      `${BASE}/audio`,
      `${BASE}/audio?part=2`,
    ]);
  });

  test('no stored recording → no media even at video level', () => {
    const set = urlsForLevel(ID, 'video', meeting(0, { hasLocal: false }));
    expect(set.media).toEqual([]);
    expect(set.pages.length).toBe(1);
  });

  test('unknown meta → primary part only', () => {
    expect(partCount(undefined)).toBe(1);
    expect(partCount(null)).toBe(1);
    expect(urlsForLevel(ID, 'audio').media).toEqual([`${BASE}/audio?variant=audio`]);
  });

  test('frame urls from markdown join the api set, de-duplicated', () => {
    const md = `![a](${BASE}/frames/1000.jpg) and ![b](${BASE}/frames/1000.jpg) ![c](${BASE}/frames/2500.jpg)`;
    const set = urlsForLevel(ID, 'transcript', meeting(1), [md, null, undefined]);
    const frames = set.api.filter((u) => u.includes('/frames/'));
    expect(frames).toEqual([`${BASE}/frames/1000.jpg`, `${BASE}/frames/2500.jpg`]);
  });

  test('ids are URL-encoded in paths', () => {
    const set = urlsForLevel('a b/c', 'transcript');
    expect(set.pages[0]).toBe('/transcript/a%20b%2Fc');
    expect(set.api[0]).toBe('/api/transcripts/a%20b%2Fc');
  });
});

describe('urlsToDrop', () => {
  test('video → audio drops only the full recordings', () => {
    const d = urlsToDrop(ID, 'video', 'audio', meeting(2));
    expect(d.pages).toEqual([]);
    expect(d.api).toEqual([]);
    expect(d.media).toEqual([`${BASE}/audio`, `${BASE}/audio?part=2`]);
  });
  test('audio → none drops everything', () => {
    const d = urlsToDrop(ID, 'audio', 'none', meeting(1));
    expect(d.pages).toEqual([`/transcript/${ID}`]);
    expect(d.api.length).toBe(TRANSCRIPT_API_SUFFIXES.length);
    expect(d.media).toEqual([`${BASE}/audio?variant=audio`]);
  });
  test('upgrade drops nothing', () => {
    const d = urlsToDrop(ID, 'transcript', 'video', meeting(1));
    expect(d).toEqual({ pages: [], api: [], media: [] });
  });
});

describe('extractFrameUrls', () => {
  test('only this meeting’s frames count', () => {
    const md = `![x](/api/transcripts/${ID}/frames/12.jpg) ![y](/api/transcripts/other/frames/13.jpg)`;
    expect(extractFrameUrls(md, ID)).toEqual([`${BASE}/frames/12.jpg`]);
  });
  test('empty / no frames', () => {
    expect(extractFrameUrls('', ID)).toEqual([]);
    expect(extractFrameUrls('plain text [3:00](t:180000)', ID)).toEqual([]);
  });
  test('absolute origin prefix is tolerated', () => {
    const md = `![x](https://meetings.darth-internal.trames.io/api/transcripts/${ID}/frames/99.jpg)`;
    expect(extractFrameUrls(md, ID)).toEqual([`${BASE}/frames/99.jpg`]);
  });
});

describe('extractStaticAssets', () => {
  const html = `
    <html><head>
      <link rel="stylesheet" href="/_next/static/css/app-1a2b.css" data-precedence="next"/>
      <link rel="preload" as="script" href="/_next/static/chunks/main-app-9f8e.js"/>
      <script src="/_next/static/chunks/webpack-0011.js" async=""></script>
      <script src='/_next/static/chunks/polyfills-2233.js?v=1'></script>
    </head><body>
      <script>self.__next_f.push([1,"3:I[\\"static/chunks/app/transcript/%5Bid%5D/page-aa11.js\\",[\\"static/chunks/app/layout-bb22.js\\"]]\\n"])</script>
      <script>(self.__next_f=self.__next_f||[]).push([0])</script>
      <img src="/api/transcripts/${ID}/frames/1.jpg"/>
      <a href="/settings">x</a>
    </body></html>`;

  test('collects script/link/inline-quoted chunk paths, de-duplicated, in order', () => {
    expect(extractStaticAssets(html)).toEqual([
      '/_next/static/css/app-1a2b.css',
      '/_next/static/chunks/main-app-9f8e.js',
      '/_next/static/chunks/webpack-0011.js',
      '/_next/static/chunks/polyfills-2233.js?v=1',
      '/_next/static/chunks/app/transcript/%5Bid%5D/page-aa11.js',
      '/_next/static/chunks/app/layout-bb22.js',
    ]);
  });

  test('ignores non-static urls and empty input', () => {
    expect(extractStaticAssets('')).toEqual([]);
    expect(extractStaticAssets('<script src="/api/x.js"></script><a href="/_next/image?url=x">i</a>')).toEqual([]);
  });

  test('strips anchors, decodes &amp;', () => {
    expect(extractStaticAssets('<script src="/_next/static/chunks/a.js?x=1&amp;y=2#frag"></script>')).toEqual([
      '/_next/static/chunks/a.js?x=1&y=2',
    ]);
  });
});

describe('estimatePinBytes', () => {
  const c = { transcript: 1024 * 1024, audioPerSec: 8 * 1024 };
  test('ladder sums', () => {
    const m = meeting(2, { bytes: 500 });
    expect(estimatePinBytes('none', m, c)).toBe(0);
    expect(estimatePinBytes('transcript', m, c)).toBe(c.transcript);
    expect(estimatePinBytes('audio', m, c)).toBe(c.transcript + 3600 * c.audioPerSec);
    expect(estimatePinBytes('video', m, c)).toBe(c.transcript + 3600 * c.audioPerSec + 1000);
  });
  test('unknown duration / bytes count as zero', () => {
    expect(estimatePinBytes('video', { durationSec: null, media: null }, c)).toBe(c.transcript);
  });
});
