import { describe, expect, test } from 'bun:test';
import { mergeIdPassGuesses } from '@/lib/speaker-id-merge';
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
