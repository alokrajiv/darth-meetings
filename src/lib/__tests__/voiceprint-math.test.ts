import { describe, expect, test } from 'bun:test';
import {
  aggregateSamples,
  chooseDisplayName,
  decideVoiceMatch,
  formatVerdict,
  pickSpeechByBudget,
  preferDisplayName,
  resolveMarginByRoster,
  storedWeight,
  weightedMerge,
} from '@/lib/voiceprint-math';
import { samePerson } from '@/lib/person-identity';

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

describe('resolveMarginByRoster', () => {
  const same = (a: string, b: string) => a.toLowerCase().split(' ')[0] === b.toLowerCase().split(' ')[0];
  const yadu = { name: 'Yadu N M', score: 0.77 };
  const rival = { name: 'Pratiksha Mali', score: 0.72 };
  test('the candidate on the call wins over one who was not (transcript 973)', () => {
    expect(resolveMarginByRoster(yadu, rival, ['Alok Rajiv', 'Yadu N M'], same)).toEqual(yadu);
  });
  test('the runner-up wins when only IT is on the call', () => {
    expect(resolveMarginByRoster(yadu, rival, ['Pratiksha'], same)).toEqual(rival);
  });
  test('both on the roster → still ambiguous', () => {
    expect(resolveMarginByRoster(yadu, rival, ['Yadu', 'Pratiksha Mali'], same)).toBeNull();
  });
  test('neither on the roster, or no roster → still ambiguous', () => {
    expect(resolveMarginByRoster(yadu, rival, ['Ivan Seow'], same)).toBeNull();
    expect(resolveMarginByRoster(yadu, rival, [], same)).toBeNull();
  });
  test('formatVerdict shows the roster decision', () => {
    expect(formatVerdict('A', { kind: 'match', name: 'Yadu N M', score: 0.77, rosterOver: rival })).toBe(
      'A=Yadu N M 0.77 ✓ (on the call; over Pratiksha Mali 0.72)'
    );
  });
});


describe('decideVoiceMatch — the invite gate (2026-09-25, transcript 980)', () => {
  const roster = ['Alok Rajiv', 'Ivan Seow', 'PRIHATMOKO Agung', 'ADIPUTRA Dwi', 'SHE Ivan', 'CHUNG Joey', 'LI Li', 'LEE Sharon (EXT)', 'DING Wick (EXT)'];
  const opts = { threshold: 0.5, margin: 0.05, roster, samePerson };
  const c = (name: string, score: number) => ({ name, score });

  test('the prod verdicts of row 980, re-decided', () => {
    // A=margin(iman.sani 0.54 vs Huiyee Lim 0.51): neither invited
    const a = decideVoiceMatch(c('iman.sani', 0.54), c('Huiyee Lim', 0.51), opts);
    expect(a.suggestion).toBeNull();
    expect(formatVerdict('A', a.verdict)).toBe('A=off-roster(iman.sani 0.54 vs Huiyee Lim 0.51, neither invited)');
    // B=Yan-Simon Saragih 0.53 — not invited, weak → not surfaced
    const b = decideVoiceMatch(c('Yan-Simon Saragih', 0.53), c('Someone Else', 0.4), opts);
    expect(b.suggestion).toBeNull();
    expect(formatVerdict('B', b.verdict)).toBe('B=off-roster(Yan-Simon Saragih 0.53, not invited)');
    // C=Ivan Seow 0.91 — invited
    const cc = decideVoiceMatch(c('Ivan Seow', 0.91), c('Ivan She', 0.3), opts);
    expect(cc.suggestion).toEqual({ name: 'Ivan Seow', score: 0.91 });
    // D=Hitesh Ambaliya 0.63 — not invited
    expect(decideVoiceMatch(c('Hitesh Ambaliya', 0.63), undefined, opts).suggestion).toBeNull();
    // E=Joey Chung 0.69 — "CHUNG Joey" on the invite
    expect(decideVoiceMatch(c('Joey Chung', 0.69), c('X Y', 0.4), opts).suggestion).toEqual({ name: 'Joey Chung', score: 0.69 });
  });

  test('a strong match to an uninvited person survives, flagged', () => {
    const d = decideVoiceMatch(c('Hitesh Ambaliya', 0.82), c('X Y', 0.5), opts);
    expect(d.suggestion).toEqual({ name: 'Hitesh Ambaliya', score: 0.82, offRoster: true });
    expect(formatVerdict('D', d.verdict)).toBe('D=Hitesh Ambaliya 0.82 ✓ (not on the invite)');
  });

  test('no informative roster (owner only / none): no gate', () => {
    expect(decideVoiceMatch(c('Hitesh Ambaliya', 0.55), undefined, { ...opts, roster: ['Alok Rajiv'] }).suggestion).toEqual({
      name: 'Hitesh Ambaliya',
      score: 0.55,
    });
    const m = decideVoiceMatch(c('iman.sani', 0.54), c('Huiyee Lim', 0.51), { ...opts, roster: [] });
    expect(m.verdict.kind).toBe('margin');
  });

  test('below threshold and roster tie-break keep working', () => {
    expect(decideVoiceMatch(c('Ivan Seow', 0.45), undefined, opts).verdict.kind).toBe('below-threshold');
    const t = decideVoiceMatch(c('Huiyee Lim', 0.62), c('Ivan Seow', 0.6), opts);
    expect(t.suggestion).toEqual({ name: 'Ivan Seow', score: 0.6 });
  });
});
