import { describe, expect, test } from 'bun:test';
import { idMayOverruleVoice, mergeIdPassGuesses, mergeVoiceSuggestions } from '@/lib/speaker-id-merge';
import type { SpeakerSuggestionMap } from '@/lib/format';

const ctx = (speakers: string[], named: string[] = []) => ({
  resolve: (k: string) => k,
  named: new Set(named),
  allSpeakers: new Set(speakers),
});

describe('mergeIdPassGuesses', () => {
  test('same person under a login spelling keeps the voice match and gains evidence', () => {
    const current: SpeakerSuggestionMap = {
      A: { name: 'Karnica Katiyar', confidence: 0.93, source: 'voice' },
      B: { name: 'Ivan', confidence: 0.88, source: 'voice' },
    };
    const { merged, added, changed } = mergeIdPassGuesses(
      current,
      {
        A: { name: 'karnica.katiyar', confidence: 0.9, evidence: 'introduces herself' },
        B: { name: 'Ivan Seow', confidence: 0.95 },
      },
      ctx(['A', 'B'])
    );
    expect(merged.A).toEqual({ name: 'Karnica Katiyar', confidence: 0.93, source: 'voice', evidence: 'introduces herself' });
    expect(merged.B).toEqual(current.B);
    expect(added).toBe(0);
    expect(changed).toBe(true);
  });

  test('a confident different person overrules a voice match; a shaky one does not', () => {
    const current: SpeakerSuggestionMap = {
      A: { name: 'Ivan Seow', confidence: 0.6, source: 'voice' },
      B: { name: 'Ivan Seow', confidence: 0.6, source: 'voice' },
    };
    const { merged, added } = mergeIdPassGuesses(
      current,
      { A: { name: 'Priya Nair', confidence: 0.8, evidence: 'x' }, B: { name: 'Priya Nair', confidence: 0.5 } },
      ctx(['A', 'B'])
    );
    expect(merged.A).toMatchObject({ name: 'Priya Nair', source: 'context', via: 'id' });
    expect(merged.B.name).toBe('Ivan Seow');
    expect(added).toBe(1);
  });

  test('confirmed and unknown speakers are left alone; no change -> changed=false', () => {
    const { merged, changed } = mergeIdPassGuesses(
      {},
      { A: { name: 'Priya Nair', confidence: 0.9 }, Z: { name: 'Nobody', confidence: 0.9 } },
      ctx(['A'], ['A'])
    );
    expect(merged).toEqual({});
    expect(changed).toBe(false);
  });
});

describe('overrule thresholds (2026-09-25, transcript 980)', () => {
  test('a voice match to someone not on the invite yields to a modest guess', () => {
    const current: SpeakerSuggestionMap = {
      D: { name: 'Hitesh Ambaliya', confidence: 0.8, source: 'voice', offRoster: true },
    };
    const { merged } = mergeIdPassGuesses(current, { D: { name: 'Agung Prihatmoko', confidence: 0.55 } }, ctx(['D']));
    expect(merged.D).toMatchObject({ name: 'Agung Prihatmoko', via: 'id' });
    const low = mergeIdPassGuesses(current, { D: { name: 'Agung Prihatmoko', confidence: 0.4 } }, ctx(['D']));
    expect(low.merged.D.name).toBe('Hitesh Ambaliya');
  });

  test('a weak voice match yields at 0.6, a strong one only at 0.7', () => {
    const current: SpeakerSuggestionMap = {
      B: { name: 'Yan-Simon Saragih', confidence: 0.53, source: 'voice' },
      E: { name: 'Joey Chung', confidence: 0.82, source: 'voice' },
    };
    const { merged } = mergeIdPassGuesses(
      current,
      { B: { name: 'Dwi Adiputra', confidence: 0.62 }, E: { name: 'Li Li', confidence: 0.65 } },
      ctx(['B', 'E'])
    );
    expect(merged.B).toMatchObject({ name: 'Dwi Adiputra', via: 'id' });
    expect(merged.E.name).toBe('Joey Chung');
  });

  test('confirmed speakers stay untouched even against an off-roster voice match', () => {
    const current: SpeakerSuggestionMap = { A: { name: 'Hitesh Ambaliya', confidence: 0.9, source: 'voice', offRoster: true } };
    const { merged, changed } = mergeIdPassGuesses(current, { A: { name: 'Sharon Lee', confidence: 0.99 } }, ctx(['A'], ['A']));
    expect(merged).toEqual(current);
    expect(changed).toBe(false);
  });

  test('idMayOverruleVoice', () => {
    expect(idMayOverruleVoice({ name: 'x', confidence: 0.95, source: 'voice', offRoster: true }, 0.5)).toBe(true);
    expect(idMayOverruleVoice({ name: 'x', confidence: 0.65, source: 'voice' }, 0.6)).toBe(true);
    expect(idMayOverruleVoice({ name: 'x', confidence: 0.65, source: 'voice' }, 0.59)).toBe(false);
    expect(idMayOverruleVoice({ name: 'x', confidence: 0.75, source: 'voice' }, 0.69)).toBe(false);
    expect(idMayOverruleVoice({ name: 'x', confidence: 0.75, source: 'voice' }, 0.7)).toBe(true);
  });
});

describe('mergeVoiceSuggestions', () => {
  test('a voice re-run does not clobber the ID pass name that overruled a weak match', () => {
    const existing: SpeakerSuggestionMap = {
      D: { name: 'Agung Prihatmoko', confidence: 0.85, source: 'context', via: 'id', evidence: 'Pak Agung' },
      A: { name: 'Sharon Lee', confidence: 0.7, source: 'context', via: 'id' },
    };
    const voice: SpeakerSuggestionMap = {
      D: { name: 'Hitesh Ambaliya', confidence: 0.63, source: 'voice' },
      C: { name: 'Ivan Seow', confidence: 0.91, source: 'voice' },
    };
    const merged = mergeVoiceSuggestions(voice, existing);
    expect(merged.D.name).toBe('Agung Prihatmoko');
    expect(merged.A.name).toBe('Sharon Lee');
    expect(merged.C.name).toBe('Ivan Seow');
  });

  test('a strong voice match wins over a shaky ID guess; stale voice entries are dropped', () => {
    const existing: SpeakerSuggestionMap = {
      D: { name: 'Agung Prihatmoko', confidence: 0.65, source: 'context', via: 'id' },
      B: { name: 'Yan-Simon Saragih', confidence: 0.53, source: 'voice' },
    };
    const voice: SpeakerSuggestionMap = { D: { name: 'Hitesh Ambaliya', confidence: 0.8, source: 'voice' } };
    const merged = mergeVoiceSuggestions(voice, existing);
    expect(merged.D.name).toBe('Hitesh Ambaliya');
    expect(merged.B).toBeUndefined();
  });

  test('the ID pass agreement note carries over to the same person', () => {
    const existing: SpeakerSuggestionMap = {
      C: { name: 'Ivan Seow', confidence: 0.9, source: 'voice', evidence: 'addressed as Ivan' },
    };
    const voice: SpeakerSuggestionMap = { C: { name: 'Ivan Seow', confidence: 0.91, source: 'voice' } };
    expect(mergeVoiceSuggestions(voice, existing).C).toEqual({
      name: 'Ivan Seow',
      confidence: 0.91,
      source: 'voice',
      evidence: 'addressed as Ivan',
    });
  });
});
