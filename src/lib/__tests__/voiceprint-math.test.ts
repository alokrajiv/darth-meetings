import { describe, expect, test } from 'bun:test';
import {
  aggregateSamples,
  chooseDisplayName,
  formatVerdict,
  pickSpeechByBudget,
  preferDisplayName,
  storedWeight,
  weightedMerge,
} from '@/lib/voiceprint-math';

const u = (speaker: string, secs: number, at = 0) => ({ speaker, start: at, end: at + secs * 1000 });

describe('pickSpeechByBudget', () => {
  test('takes the longest first until 90 s of speech', () => {
    const utts = [u('A', 30), u('A', 40), u('A', 25), u('A', 10), u('A', 5), u('B', 60)];
    const p = pickSpeechByBudget(utts, 'A');
    // each segment counts at most 20 s (sidecar cap): 20+20+20+10 = 70 < 90, then +5 = 75
    expect(p.utterances.map((x) => (x.end - x.start) / 1000)).toEqual([40, 30, 25, 10, 5]);
    expect(p.seconds).toBe(75);
  });
  test('stops as soon as the budget is reached', () => {
    const utts = Array.from({ length: 10 }, () => u('A', 20));
    const p = pickSpeechByBudget(utts, 'A');
    expect(p.utterances.length).toBe(5); // 5 × 20 = 100 ≥ 90
    expect(p.seconds).toBe(100);
  });
  test('caps at 12 segments of short speech', () => {
    const utts = Array.from({ length: 30 }, () => u('A', 2));
    const p = pickSpeechByBudget(utts, 'A');
    expect(p.utterances.length).toBe(12);
    expect(p.seconds).toBe(24);
  });
  test('always takes the single longest, ignores < 1.5 s, reports the longest', () => {
    expect(pickSpeechByBudget([u('A', 300)], 'A').utterances.length).toBe(1);
    const none = pickSpeechByBudget([u('A', 0.8), u('A', 1.2)], 'A');
    expect(none.utterances).toEqual([]);
    expect(none.seconds).toBe(0);
    expect(none.longestMs).toBe(1200);
  });
});

describe('weighted merge', () => {
  test('(old·W + new·w)/(W+w), renormalised', () => {
    const m = weightedMerge([1, 0], 3, [0, 1], 1);
    const n = Math.hypot(3, 1);
    expect(m[0]).toBeCloseTo(3 / n, 10);
    expect(m[1]).toBeCloseTo(1 / n, 10);
  });
  test('an empty stored weight takes the new sample', () => {
    expect(weightedMerge([1, 0], 0, [0, 2], 5)).toEqual([0, 1]);
  });
  test('legacy rows weigh their sample count', () => {
    expect(storedWeight({ weight_secs: 0, sample_count: 4 })).toBe(4);
    expect(storedWeight({ weight_secs: 250, sample_count: 4 })).toBe(250);
  });
  test('aggregate weights by seconds, capped at 180 s per sample, per personNameKey', () => {
    const [id] = aggregateSamples([
      { name: 'karnica.katiyar', embedding: [1, 0], seconds: 60 },
      { name: 'Karnica Katiyar', embedding: [0, 1], seconds: 7200 },
    ]);
    expect(id!.key).toBe('karnica katiyar');
    expect(id!.samples).toBe(2);
    expect(id!.weightSecs).toBe(240);
    expect(id!.seconds).toBe(7260);
    const n = Math.hypot(60, 180);
    expect(id!.embedding[0]).toBeCloseTo(60 / n, 10);
    expect(id!.embedding[1]).toBeCloseTo(180 / n, 10);
  });
});

describe('display name', () => {
  test('prefers a spelling with a space and capitals over a more-used login', () => {
    expect(chooseDisplayName(new Map([['karnica.katiyar', 5], ['Karnica Katiyar', 1]]))).toBe('Karnica Katiyar');
  });
  test('else the most-used spelling', () => {
    expect(chooseDisplayName(new Map([['pratiksha', 3], ['Pratiksha', 1]]))).toBe('pratiksha');
  });
  test('ties are deterministic', () => {
    expect(chooseDisplayName(new Map([['Kawen Koh', 2], ['Ka Wen Koh', 2]]))).toBe('Ka Wen Koh');
  });
  test('a stored nice name is not replaced by a login spelling', () => {
    expect(preferDisplayName('Karnica Katiyar', 'karnica.katiyar')).toBe('Karnica Katiyar');
    expect(preferDisplayName('karnica.katiyar', 'Karnica Katiyar')).toBe('Karnica Katiyar');
    expect(preferDisplayName('x', 'shridhar.​tirthkar')).toBe('shridhar.tirthkar');
  });
});

describe('formatVerdict', () => {
  test('every kind', () => {
    expect(formatVerdict('A', { kind: 'match', name: 'Yadu N M', score: 0.691 })).toBe('A=Yadu N M 0.69 ✓');
    expect(formatVerdict('B', { kind: 'below-threshold', best: { name: 'Jack Adams', score: 0.29 } })).toBe(
      'B=below-threshold(best Jack Adams 0.29)'
    );
    expect(
      formatVerdict('C', {
        kind: 'margin',
        best: { name: 'pratiksha', score: 0.51 },
        second: { name: 'karnica.katiyar', score: 0.49 },
      })
    ).toBe('C=margin(pratiksha 0.51 vs karnica.katiyar 0.49)');
    expect(formatVerdict('D', { kind: 'no-segment', longestMs: 800 })).toBe('D=no-segment(0.8s)');
  });
});
