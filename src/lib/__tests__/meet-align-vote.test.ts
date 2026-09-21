import { describe, expect, test } from 'bun:test';
import type { MeetUtterance } from '../format';
import {
  computeMeetAlignment,
  hasDensitySignal,
  windowWeight,
  DENSITY_REF_CHARS_PER_S,
  MIN_DENSITY_CHARS_PER_S,
} from '../meet-align-vote';

/**
 * The vote behind every "from the transcript" name suggestion on the People
 * card. The rule under test is that a Meet window is worth the fraction of
 * itself its named speaker actually filled (chars / span vs ~15 chars/s),
 * because the windows are caption flushes, not turns — see
 * docs/eval-meet-align-dense-windows-2026-09-22.md.
 */

const chars = (n: number) => 'x'.repeat(n);

/** A Meet window of `spanS` seconds at `density` chars/s. */
function win(speaker: string, startS: number, spanS: number, density: number): MeetUtterance {
  return {
    speaker,
    text: chars(Math.round(spanS * density)),
    start: startS * 1000,
    end: (startS + spanS) * 1000,
  };
}

function aai(speaker: string, startS: number, endS: number) {
  return { speaker, start: startS * 1000, end: endS * 1000 };
}

describe('windowWeight', () => {
  test('a window filled at the reference rate is worth all of itself', () => {
    expect(windowWeight(30_000, 30 * DENSITY_REF_CHARS_PER_S)).toBe(1);
  });

  test('faster than the reference rate is still capped at 1', () => {
    expect(windowWeight(30_000, 30 * 40)).toBe(1);
  });

  test('a half-filled window is worth half of itself', () => {
    expect(windowWeight(30_000, (30 * DENSITY_REF_CHARS_PER_S) / 2)).toBeCloseTo(0.5, 6);
  });

  test('caption noise below the floor is worth nothing', () => {
    expect(windowWeight(30_000, 30 * (MIN_DENSITY_CHARS_PER_S - 0.5))).toBe(0);
  });

  test('a zero or negative span is worth nothing', () => {
    expect(windowWeight(0, 500)).toBe(0);
    expect(windowWeight(-1000, 500)).toBe(0);
  });
});

describe('hasDensitySignal', () => {
  test('false when every window is textless — weighting would silence the row', () => {
    expect(
      hasDensitySignal([
        { speaker: 'Ada', text: '', start: 0, end: 30_000 },
        { speaker: 'Bob', text: '', start: 0, end: 30_000 },
      ])
    ).toBe(false);
  });

  test('true as soon as one window carries real text', () => {
    expect(hasDensitySignal([win('Ada', 0, 30, 10)])).toBe(true);
  });
});

describe('computeMeetAlignment', () => {
  test('turn-level windows (Teams VTT shape) vote the obvious way', () => {
    const meet = [win('Ada', 0, 20, 15), win('Bob', 20, 20, 15), win('Ada', 40, 20, 15)];
    const out = computeMeetAlignment(
      [aai('A', 0, 20), aai('B', 20, 40), aai('A', 40, 60)],
      meet
    );
    expect(out.get('A')?.name).toBe('Ada');
    expect(out.get('A')?.share).toBe(1);
    expect(out.get('B')?.name).toBe('Bob');
  });

  test('caption-flush windows: the name who actually filled them wins', () => {
    // Both names' caption streams tile the same 120 s (Meet transcribes
    // backchannels), so flat overlap is a coin toss. Ada filled her windows;
    // Bob's carry a few characters each.
    const meet: MeetUtterance[] = [];
    for (let t = 0; t < 120; t += 30) {
      meet.push(win('Ada', t, 30, 16));
      meet.push(win('Bob', t, 30, 1));
    }
    const out = computeMeetAlignment([aai('A', 0, 120)], meet);
    expect(out.get('A')?.name).toBe('Ada');
    expect(out.get('A')?.share).toBe(1);
    // 120 s of overlap, all of it worth full weight.
    expect(out.get('A')?.overlapMs).toBe(120_000);
  });

  test('flat overlap would have picked the wrong name here', () => {
    // Bob's window is longer but nearly empty (60 s flat beats Ada's 24 s);
    // Ada's are short and full, so the weighted vote flips it.
    const meet = [
      win('Bob', 0, 60, 3),
      win('Ada', 10, 8, 16),
      win('Ada', 30, 8, 16),
      win('Ada', 50, 8, 16),
    ];
    const out = computeMeetAlignment([aai('A', 0, 60)], meet);
    expect(out.get('A')?.name).toBe('Ada');
    // Bob is still on the ballot (3 c/s clears the floor), just outvoted:
    // Ada 3 x 8 s at full weight = 24 s, Bob 60 s x 0.2 = 12 s.
    expect(out.get('A')!.share).toBeCloseTo(24 / 36, 4);
  });

  test('a textless sidecar falls back to flat overlap instead of going silent', () => {
    const meet: MeetUtterance[] = [
      { speaker: 'Ada', text: '', start: 0, end: 30_000 },
      { speaker: 'Bob', text: '', start: 30_000, end: 60_000 },
    ];
    const out = computeMeetAlignment([aai('A', 0, 30), aai('B', 30, 60)], meet);
    expect(out.get('A')?.name).toBe('Ada');
    expect(out.get('A')?.overlapMs).toBe(30_000);
    expect(out.get('B')?.name).toBe('Bob');
  });

  test('weighted overlapMs is speech-equivalent time, not wall clock', () => {
    const out = computeMeetAlignment([aai('A', 0, 30)], [win('Ada', 0, 30, 7.5)]);
    expect(out.get('A')?.overlapMs).toBeCloseTo(15_000, 3); // half-filled 30 s
    expect(out.get('A')?.share).toBe(1);
  });

  test('unsorted input is handled, and a speaker with no overlap is absent', () => {
    const meet = [win('Bob', 40, 10, 15), win('Ada', 0, 10, 15)];
    const out = computeMeetAlignment([aai('B', 40, 50), aai('C', 100, 110), aai('A', 0, 10)], meet);
    expect(out.get('A')?.name).toBe('Ada');
    expect(out.get('B')?.name).toBe('Bob');
    expect(out.has('C')).toBe(false);
  });

  test('empty inputs produce no votes', () => {
    expect(computeMeetAlignment([], [win('Ada', 0, 10, 15)]).size).toBe(0);
    expect(computeMeetAlignment([aai('A', 0, 10)], []).size).toBe(0);
  });

  test('one Meet name over two AAI speakers still reports both — the pooled-room drop is the caller’s job', () => {
    const meet = [win('Room', 0, 30, 16), win('Room', 30, 30, 16)];
    const out = computeMeetAlignment([aai('A', 0, 30), aai('B', 30, 60)], meet);
    expect(out.get('A')?.name).toBe('Room');
    expect(out.get('B')?.name).toBe('Room');
  });
});
