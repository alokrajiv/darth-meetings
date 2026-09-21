import { describe, expect, test } from 'bun:test';
import { clock24, dayLabel, safeDate, usesEventRange, whenLine } from '../when';

// Local-time constructors: the helpers format in local time, so the tests
// build dates the same way and never depend on the machine's zone.
const d = (y: number, m: number, day: number, h: number, min: number) => new Date(y, m - 1, day, h, min);

describe('clock24 / dayLabel', () => {
  test('24-hour, zero-padded', () => {
    expect(clock24(d(2026, 9, 21, 16, 30))).toBe('16:30');
    expect(clock24(d(2026, 9, 21, 9, 5))).toBe('09:05');
    expect(clock24(d(2026, 9, 21, 0, 0))).toBe('00:00');
  });
  test('day-of-week first, year always', () => {
    expect(dayLabel(d(2026, 9, 21, 16, 30))).toBe('Mon 21 Sep 2026');
    expect(dayLabel(d(2025, 1, 3, 0, 0))).toBe('Fri 3 Jan 2025');
  });
});

describe('whenLine', () => {
  test('calendar range when linked and on the same day as the curated date', () => {
    const held = d(2026, 9, 21, 16, 30);
    const input = { held, eventStart: d(2026, 9, 21, 16, 30), eventEnd: d(2026, 9, 21, 17, 30) };
    expect(whenLine(input)).toBe('Mon 21 Sep 2026 · 16:30–17:30');
    expect(usesEventRange(input)).toBe(true);
  });
  test('curated moment when the event disagrees (recorded_at set by hand) or is missing', () => {
    const held = d(2026, 9, 22, 10, 0);
    const input = { held, eventStart: d(2026, 9, 21, 16, 30), eventEnd: d(2026, 9, 21, 17, 30) };
    expect(whenLine(input)).toBe('Tue 22 Sep 2026 · 10:00');
    expect(usesEventRange(input)).toBe(false);
    expect(whenLine({ held })).toBe('Tue 22 Sep 2026 · 10:00');
  });
  test('an event spanning midnight falls back to the curated moment', () => {
    const held = d(2026, 9, 21, 23, 30);
    expect(whenLine({ held, eventStart: held, eventEnd: d(2026, 9, 22, 0, 30) })).toBe('Mon 21 Sep 2026 · 23:30');
  });
});

describe('safeDate', () => {
  test('null on garbage', () => {
    expect(safeDate(null)).toBeNull();
    expect(safeDate('not a date')).toBeNull();
    expect(safeDate('2026-09-21T08:30:00Z')?.toISOString()).toBe('2026-09-21T08:30:00.000Z');
  });
});
