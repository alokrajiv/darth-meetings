import { describe, expect, test } from 'bun:test';
import { clockOf, speakingMoments } from '@/lib/speaker-moments';

const u = (speaker: string, startS: number, secs: number) => ({ speaker, start: startS * 1000, end: (startS + secs) * 1000 });

describe('speakingMoments', () => {
  const meeting = [
    u('A', 0, 5),
    u('B', 10, 40), // slice 1 longest
    u('B', 60, 8),
    u('A', 700, 3),
    u('B', 800, 20), // slice 2
    u('B', 1500, 12), // slice 3
    u('B', 1520, 30), // slice 3, longer but within a minute of nothing picked yet
    u('B', 2300, 4), // slice 4
    u('C', 2390, 10),
  ];

  test('one moment per slice of the meeting, 3 s into the utterance, chronological', () => {
    const r = speakingMoments(meeting, 'B', 4);
    expect(r.moments).toEqual([13_000, 803_000, 1_523_000, 2_302_000]);
    expect(r.lines).toBe(6);
    expect(r.talkMs).toBe(114_000);
  });

  test('tops up from the longest when slices are empty, a minute apart', () => {
    const r = speakingMoments([u('A', 0, 30), u('A', 30, 20), u('A', 100, 10), u('B', 3000, 2)], 'A', 4);
    // slice 1 holds all of A; top-up skips the 30 s one (within 60 s of 0 s)
    expect(r.moments).toEqual([3000, 103_000]);
  });

  test('only short lines: the single longest, at its middle', () => {
    const r = speakingMoments([u('A', 0, 30), u('D', 100, 1), u('D', 200, 2)], 'D');
    expect(r.moments).toEqual([201_000]);
  });

  test('unknown speaker', () => {
    expect(speakingMoments(meeting, 'Z').moments).toEqual([]);
  });

  test('clockOf', () => {
    expect(clockOf(766_000)).toBe('12:46');
    expect(clockOf(3_723_000)).toBe('1:02:03');
  });
});
