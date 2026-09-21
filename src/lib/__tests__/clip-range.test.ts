/**
 * The split dialog's two handles, as arithmetic
 * (docs/recordings-phase3-clips-spec.md §UI).
 *
 * TZ-independent: `eventOverlapsWindow` compares absolute instants, and every
 * fixture below is spelled with an explicit offset.
 */
import { describe, expect, it } from 'bun:test';
import {
  eventOverlapsWindow,
  rangeBoundaries,
  rangeSummary,
  snapMs,
  utterancesIn,
  voicesIn,
  SNAP_MS,
  type RangeUtterance,
} from '@/lib/clip-range';

const UTTERANCES: RangeUtterance[] = [
  { speaker: 'A', start: 0, end: 90_000 },
  { speaker: 'B', start: 95_000, end: 400_000 },
  { speaker: 'A', start: 500_000, end: 900_000 },
  { speaker: 'C', start: 1_200_000, end: 1_500_000 },
  { speaker: 'A', start: 1_550_000, end: 1_700_000 },
  { speaker: 'C', start: 1_750_000, end: 1_990_000 },
  { speaker: 'A', start: 2_100_000, end: 2_400_000 },
  { speaker: 'B', start: 2_450_000, end: 3_500_000 },
];
const SPAN = 3_600_000;

describe('where a handle may land', () => {
  it('offers every utterance edge plus both ends of the meeting', () => {
    const b = rangeBoundaries(UTTERANCES, SPAN);
    expect(b[0]).toBe(0);
    expect(b.at(-1)).toBe(SPAN);
    expect(b).toContain(1_200_000);
    expect(b).toContain(1_990_000);
  });

  it('is sorted and free of duplicates', () => {
    const b = rangeBoundaries([{ speaker: 'A', start: 0, end: 10 }], 10);
    expect(b).toEqual([0, 10]);
  });

  it('includes the edges of a hole — a previous split cut there', () => {
    const b = rangeBoundaries([], 3_600_000, [{ fromMs: 1_200_000, toMs: 2_000_000 }]);
    expect(b).toEqual([0, 1_200_000, 2_000_000, 3_600_000]);
  });

  it('survives an empty transcript', () => {
    expect(rangeBoundaries(null, 1000)).toEqual([0, 1000]);
  });
});

describe('snapping', () => {
  const boundaries = rangeBoundaries(UTTERANCES, SPAN);

  it('pulls a near-miss onto the boundary', () => {
    expect(snapMs(1_198_000, boundaries)).toBe(1_200_000);
    expect(snapMs(1_203_500, boundaries)).toBe(1_200_000);
  });

  it('leaves a handle alone when the nearest boundary is far', () => {
    expect(snapMs(1_100_000, boundaries)).toBe(1_100_000);
  });

  it('is exact at the tolerance and free just past it', () => {
    expect(snapMs(1_200_000 + SNAP_MS, boundaries)).toBe(1_200_000);
    expect(snapMs(1_200_000 + SNAP_MS + 1, boundaries)).toBe(1_200_000 + SNAP_MS + 1);
  });

  it('rounds a fractional drop position', () => {
    expect(snapMs(1_100_000.6, boundaries)).toBe(1_100_001);
  });
});

describe('what the range contains', () => {
  it('counts the voices that overlap it', () => {
    expect(voicesIn(UTTERANCES, 1_200_000, 2_000_000)).toBe(2); // C and A
    expect(voicesIn(UTTERANCES, 0, SPAN)).toBe(3);
  });

  it('counts a voice that is mid-sentence when the window opens', () => {
    expect(voicesIn(UTTERANCES, 300_000, 350_000)).toBe(1); // B, still talking
  });

  it('counts nobody in a silence', () => {
    expect(voicesIn(UTTERANCES, 1_000_000, 1_100_000)).toBe(0);
  });

  it('counts the utterances that would move', () => {
    expect(utterancesIn(UTTERANCES, 1_200_000, 2_000_000)).toBe(3);
    expect(utterancesIn(UTTERANCES, 1_000_000, 1_100_000)).toBe(0);
  });
});

describe('the live line', () => {
  it('reads as a sentence', () => {
    expect(rangeSummary({ fromMs: 760_000, toMs: 2_465_000, voices: 3 })).toBe(
      '12:40 – 41:05 · 28m 25s · 3 voices'
    );
  });

  it('says “1 voice”, not “1 voices”', () => {
    expect(rangeSummary({ fromMs: 0, toMs: 60_000, voices: 1 })).toBe('0:00 – 1:00 · 1m 00s · 1 voice');
  });

  it('says nobody speaks rather than “0 voices”', () => {
    expect(rangeSummary({ fromMs: 0, toMs: 20_000, voices: 0 })).toContain('nobody speaks');
  });

  it('shows the hour once past it', () => {
    expect(rangeSummary({ fromMs: 3_600_000, toMs: 3_720_000, voices: 2 })).toBe(
      '1:00:00 – 1:02:00 · 2m 00s · 2 voices'
    );
  });
});

describe('the calendar events worth offering', () => {
  // 09:00–10:00 +08:00 → 01:00–02:00 UTC.
  const windowStart = Date.parse('2026-09-22T01:30:00Z');
  const windowEnd = Date.parse('2026-09-22T01:45:00Z');

  it('keeps an event that was running during the window', () => {
    expect(
      eventOverlapsWindow(
        { start: '2026-09-22T09:00:00+08:00', end: '2026-09-22T10:00:00+08:00' },
        windowStart,
        windowEnd
      )
    ).toBe(true);
  });

  it('drops one that ended before it', () => {
    expect(
      eventOverlapsWindow(
        { start: '2026-09-22T08:00:00+08:00', end: '2026-09-22T09:00:00+08:00' },
        windowStart,
        windowEnd
      )
    ).toBe(false);
  });

  it('assumes an hour for an event with no end', () => {
    expect(
      eventOverlapsWindow({ start: '2026-09-22T09:00:00+08:00', end: null }, windowStart, windowEnd)
    ).toBe(true);
    expect(
      eventOverlapsWindow({ start: '2026-09-22T07:00:00+08:00', end: null }, windowStart, windowEnd)
    ).toBe(false);
  });

  it('drops an unparseable start rather than offering it', () => {
    expect(eventOverlapsWindow({ start: 'whenever', end: null }, windowStart, windowEnd)).toBe(false);
  });
});
