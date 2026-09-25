import { describe, expect, test } from 'bun:test';
import type { SpeakerLabel, SpeakerSuggestionMap } from '../format';
import { confirmedPersonNames, countVoices, guessCaption, speakerNameState, speakerNameStates, voiceMatchCaveat, voiceMatchLabel } from '../speaker-name-state';

// The Hypercare row (591b102e…) as it stood before Atira's last save: two
// confirmed, one transcript guess, one voice guess, one "mixed" voice guess
// and one with nothing.
const labels: SpeakerLabel[] = [
  { originalSpeaker: 'A', customName: 'Atira Sarat', description: '' },
  { originalSpeaker: 'B', customName: 'Anton', description: 'CS lead' },
  { originalSpeaker: 'D', customName: 'mixed', description: '' },
];
const suggestions: SpeakerSuggestionMap = {
  A: { name: 'Atira Sarat', source: 'voice', confidence: 0.67 },
  B: { name: 'Anton', source: 'voice', confidence: 0.76 },
  C: { name: 'Yan-Simon Saragih', source: 'context', via: 'id', confidence: 0.85, evidence: "Addressed as 'Pak Simon'" },
  D: { name: 'mixed', source: 'voice', confidence: 0.85 },
  E: { name: 'Muhammad Adji Rizqi Ramadhan', source: 'voice', confidence: 0.86 },
  G: { name: 'mixed', source: 'voice', confidence: 0.7 },
};

describe('speakerNameState', () => {
  test('confirmed label wins over any guess', () => {
    const s = speakerNameState('A', labels, suggestions);
    expect(s.status).toBe('confirmed');
    expect(s.name).toBe('Atira Sarat');
    expect(s.display).toBe('Atira Sarat');
    expect(s.suggestion).toBeNull();
    expect(speakerNameState('B', labels, suggestions).description).toBe('CS lead');
  });

  test('THE BUG: a guess with no label seeds the editor with the guess, marked as a guess', () => {
    const s = speakerNameState('C', labels, suggestions);
    expect(s.status).toBe('guess');
    expect(s.name).toBe('Yan-Simon Saragih'); // what the edit form must open with
    expect(s.display).toBe('Yan-Simon Saragih');
    expect(s.suggestion?.confidence).toBe(0.85);
    expect(s.caption).toBe("guessed from the transcript — Addressed as 'Pak Simon'");
    const v = speakerNameState('E', labels, suggestions);
    expect(v.status).toBe('guess');
    expect(v.caption).toBe('guessed — 86% voice match, a hint not proof');
  });

  test('a confirmed group label is a group, not a person', () => {
    const s = speakerNameState('D', labels, suggestions);
    expect(s.status).toBe('group');
    expect(s.name).toBe('mixed'); // the editor still shows what was typed
    expect(s.display).toBe('Several voices');
    expect(s.suggestion).toBeNull();
  });

  test('a group-word GUESS is treated as unknown — "mixed 85 %" is not a name', () => {
    const s = speakerNameState('G', labels, suggestions);
    expect(s.status).toBe('unknown');
    expect(s.name).toBe('');
    expect(s.display).toBe('Speaker G');
    expect(s.suggestion).toBeNull();
    expect(s.caption).toContain('shared-mic sample');
  });

  test('nothing known', () => {
    const s = speakerNameState('F', labels, suggestions);
    expect(s.status).toBe('unknown');
    expect(s.display).toBe('Speaker F');
    expect(s.caption).toBe('no guess — name them if you can');
    expect(speakerNameState('F', labels).status).toBe('unknown');
    expect(speakerNameState('F', [], null).name).toBe('');
  });
});

describe('aggregates', () => {
  const states = speakerNameStates(['A', 'B', 'C', 'D', 'E', 'F'], labels, suggestions);
  test('countVoices excludes group labels', () => {
    expect(countVoices(states)).toBe(5);
  });
  test('confirmedPersonNames lists confirmed people once, never the group label', () => {
    expect(confirmedPersonNames(states)).toEqual(['Atira Sarat', 'Anton']);
    const dup = speakerNameStates(['A', 'X'], [...labels, { originalSpeaker: 'X', customName: 'atira sarat', description: '' }], {});
    expect(confirmedPersonNames(dup)).toEqual(['Atira Sarat']);
  });
});

describe('voice guesses read honestly (2026-09-25, transcript 980)', () => {
  test('weak and uninvited voice matches say so', () => {
    expect(guessCaption({ name: 'Yan-Simon Saragih', confidence: 0.53, source: 'voice' })).toBe(
      'guessed — weak 53% voice match, often wrong'
    );
    expect(guessCaption({ name: 'Hitesh Ambaliya', confidence: 0.81, source: 'voice', offRoster: true })).toBe(
      'guessed — 81% voice match, but not on the invite'
    );
    expect(voiceMatchLabel({ confidence: 0.91 })).toBe('91% voice match');
    expect(voiceMatchCaveat({ confidence: 0.91 })).toBe('a hint not proof');
  });
});

test('a weak voice match the ID pass corroborated is not called weak', () => {
  expect(guessCaption({ name: 'Joey Chung', confidence: 0.69, source: 'voice', evidence: "tile 'CHUNG Joey' lit at 18:44" })).toBe(
    "guessed — 69% voice match, a hint not proof; the transcript agrees — tile 'CHUNG Joey' lit at 18:44"
  );
});
