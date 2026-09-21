import { describe, expect, test } from 'bun:test';
import type { GmeetContext } from '../format';
import {
  partAnchorMs,
  partForMeetingTime,
  storedVideoParts,
  videoPartOffsets,
} from '../part-offsets';

/**
 * The detail page carried this arithmetic inline from the multi-video ship
 * (2026-08-11) until it was lifted into this module; `page.tsx` now calls
 * `storedVideoParts` / `partForMeetingTime` directly. `pageStoredParts` /
 * `pageSeek` below are the page's OLD code, frozen verbatim, so the module
 * stays held to the behaviour that shipped — the "identical to the detail
 * page today" block at the bottom is the equality that made the refactor
 * safe, and it keeps being the one that would catch a drift.
 */
function pageAnchor(g: GmeetContext | null): number | null {
  const iso =
    g?.actuals?.anchorIso ??
    g?.actuals?.recordings?.find((r) => r.fileId && r.fileId === g?.videoFileId)?.startTime ??
    g?.actuals?.recordings?.[0]?.startTime;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
}
function pageStoredParts(g: GmeetContext | null) {
  const partAnchor = pageAnchor(g);
  return (g?.videoParts ?? [])
    .map((p, i) => {
      const startMs = p.startTime ? Date.parse(p.startTime) : NaN;
      const endMs = p.endTime ? Date.parse(p.endTime) : NaN;
      return {
        partNo: i + 2,
        filename: p.filename,
        offsetSec:
          partAnchor != null && !Number.isNaN(startMs) ? (startMs - partAnchor) / 1000 : null,
        durationSec:
          !Number.isNaN(startMs) && !Number.isNaN(endMs) ? (endMs - startMs) / 1000 : null,
      };
    })
    .filter((p) => !!p.filename);
}
function pageSeek(parts: ReturnType<typeof pageStoredParts>, seconds: number) {
  let target = 1;
  let offset = 0;
  for (const p of parts) {
    if (p.offsetSec != null && seconds >= p.offsetSec && p.offsetSec > offset) {
      target = p.partNo;
      offset = p.offsetSec;
    }
  }
  return { partNo: target, offsetSec: offset, localSec: Math.max(0, seconds - offset) };
}

// A real stop-restart Meet meeting: recording started 10:00:00, stopped, and
// restarted at 10:35:10 and 11:02:00. The middle file has not been fetched.
const stopRestart: GmeetContext = {
  videoFileId: 'drive-file-1',
  actuals: {
    anchorIso: '2026-09-10T10:00:00.000Z',
    recordings: [
      { fileId: 'drive-file-1', startTime: '2026-09-10T10:00:00.000Z', endTime: '2026-09-10T10:34:00.000Z' },
      { fileId: 'drive-file-2', startTime: '2026-09-10T10:35:10.000Z', endTime: '2026-09-10T11:01:00.000Z' },
      { fileId: 'drive-file-3', startTime: '2026-09-10T11:02:00.000Z', endTime: '2026-09-10T11:40:30.000Z' },
    ],
  },
  videoParts: [
    { fileId: 'drive-file-2', startTime: '2026-09-10T10:35:10.000Z', endTime: '2026-09-10T11:01:00.000Z' },
    {
      fileId: 'drive-file-3',
      startTime: '2026-09-10T11:02:00.000Z',
      endTime: '2026-09-10T11:40:30.000Z',
      filename: 'aai-id.part3.mp4',
      bytes: 812_345_678,
    },
  ],
};

const noAnchor: GmeetContext = {
  videoParts: [{ fileId: 'f2', filename: 'aai-id.part2.mp4' }],
};

const anchorFromPrimaryRecording: GmeetContext = {
  videoFileId: 'drive-file-9',
  actuals: {
    recordings: [
      { fileId: 'drive-file-0', startTime: '2026-09-10T09:00:00.000Z' },
      { fileId: 'drive-file-9', startTime: '2026-09-10T10:00:00.000Z' },
    ],
  },
  videoParts: [
    { fileId: 'x', startTime: '2026-09-10T10:20:00.000Z', filename: 'aai-id.part2.mp4' },
  ],
};

describe('partAnchorMs', () => {
  test('prefers the Meet snapshot anchor', () => {
    expect(partAnchorMs(stopRestart)).toBe(Date.parse('2026-09-10T10:00:00.000Z'));
  });

  test('falls back to the recording whose file IS the primary, not the first one', () => {
    expect(partAnchorMs(anchorFromPrimaryRecording)).toBe(Date.parse('2026-09-10T10:00:00.000Z'));
  });

  test('falls back to the first listed recording when the primary is unknown', () => {
    const g: GmeetContext = {
      actuals: { recordings: [{ fileId: 'a', startTime: '2026-09-10T08:30:00.000Z' }] },
    };
    expect(partAnchorMs(g)).toBe(Date.parse('2026-09-10T08:30:00.000Z'));
  });

  test('null for a row with no Meet facts, and for an unparseable stamp', () => {
    expect(partAnchorMs(null)).toBeNull();
    expect(partAnchorMs(undefined)).toBeNull();
    expect(partAnchorMs({})).toBeNull();
    expect(partAnchorMs({ actuals: { anchorIso: 'not-a-date' } })).toBeNull();
  });
});

describe('videoPartOffsets / storedVideoParts', () => {
  test('part numbers are array positions + 2 and survive an unfetched part', () => {
    expect(videoPartOffsets(stopRestart).map((p) => p.partNo)).toEqual([2, 3]);
    // Part 2's bytes are missing, so the player only offers part 3 — and it
    // is still called part 3, because /audio?part=N indexes videoParts[N-2].
    expect(storedVideoParts(stopRestart).map((p) => p.partNo)).toEqual([3]);
  });

  test('offsets are the wall-clock delta from the anchor, in seconds', () => {
    expect(videoPartOffsets(stopRestart).map((p) => p.offsetSec)).toEqual([2110, 3720]);
    expect(videoPartOffsets(stopRestart).map((p) => p.durationSec)).toEqual([1550, 2310]);
  });

  test('no anchor or no startTime ⇒ null offset, never 0', () => {
    expect(storedVideoParts(noAnchor)[0]?.offsetSec).toBeNull();
    expect(storedVideoParts(noAnchor)[0]?.durationSec).toBeNull();
  });

  test('a row with no videoParts has none', () => {
    expect(storedVideoParts(null)).toEqual([]);
    expect(storedVideoParts({})).toEqual([]);
  });
});

describe('partForMeetingTime', () => {
  const parts = storedVideoParts(stopRestart);

  test('before the first stored part, the primary plays', () => {
    expect(partForMeetingTime(parts, 0)).toEqual({ partNo: 1, offsetSec: 0, localSec: 0 });
    expect(partForMeetingTime(parts, 3719)).toEqual({ partNo: 1, offsetSec: 0, localSec: 3719 });
  });

  test('the boundary belongs to the part that starts there', () => {
    expect(partForMeetingTime(parts, 3720)).toEqual({ partNo: 3, offsetSec: 3720, localSec: 0 });
    expect(partForMeetingTime(parts, 4000)).toEqual({ partNo: 3, offsetSec: 3720, localSec: 280 });
  });

  test('a part with a null or zero offset never steals from the primary', () => {
    expect(partForMeetingTime(storedVideoParts(noAnchor), 500).partNo).toBe(1);
  });
});

describe('identical to the detail page before the refactor', () => {
  const fixtures: Array<[string, GmeetContext | null]> = [
    ['stop-restart with an unfetched middle', stopRestart],
    ['no anchor at all', noAnchor],
    ['anchor from the primary recording', anchorFromPrimaryRecording],
    ['no Meet facts', null],
    ['empty context', {}],
  ];

  for (const [name, g] of fixtures) {
    test(name, () => {
      expect(storedVideoParts(g)).toEqual(pageStoredParts(g) as never);
      for (const seconds of [0, 1, 1200, 2109, 2110, 3719, 3720, 9999]) {
        expect(partForMeetingTime(storedVideoParts(g), seconds)).toEqual(
          pageSeek(pageStoredParts(g), seconds)
        );
      }
    });
  }
});
