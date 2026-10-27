/**
 * Naming every speaker by hand settles the speaker-ID pass (2026-10-27): a
 * meeting whose three speakers were all named through `set-speakers` sat
 * 30 min behind "Identifying speakers first…" waiting for a pass that had
 * nothing left to do. The decision is this pure function; the route and the
 * server wrapper only hand it the row and the labels.
 */
import { describe, expect, test } from 'bun:test';
import {
  diarizedSpeakers,
  shouldSettleSpeakerId,
  unnamedSpeakers,
} from '../speaker-id-settle';
import type { SpeakerLabel } from '../format';

const label = (originalSpeaker: string, customName: string): SpeakerLabel => ({
  originalSpeaker,
  customName,
  description: '',
});

const utterances = [
  { speaker: 'A', text: 'hello', start: 0, end: 1000 },
  { speaker: 'B', text: 'hi', start: 1000, end: 2000 },
  { speaker: 'A', text: 'so', start: 2000, end: 3000 },
  { speaker: 'C', text: 'yes', start: 3000, end: 4000 },
];

const allNamed = [label('A', 'Test Person A'), label('B', 'Test Person B'), label('C', 'Test Person C')];

describe('diarized speakers and who is still unnamed', () => {
  test('distinct labels in first-seen order', () => {
    expect(diarizedSpeakers(utterances)).toEqual(['A', 'B', 'C']);
    expect(diarizedSpeakers([])).toEqual([]);
  });

  test('a blank or whitespace name is no name', () => {
    expect(unnamedSpeakers(['A', 'B', 'C'], [label('A', 'Test Person A'), label('B', '   '), label('C', '')])).toEqual([
      'B',
      'C',
    ]);
    expect(unnamedSpeakers(['A', 'B', 'C'], allNamed)).toEqual([]);
  });

  test('a label for a speaker the meeting has no utterances of is ignored', () => {
    expect(unnamedSpeakers(['A'], [label('A', 'Test Person A'), label('Z', 'Nobody')])).toEqual([]);
  });
});

describe('shouldSettleSpeakerId', () => {
  const base = {
    rowStatus: 'completed',
    speakerIdStatus: 'running' as string | null,
    speakers: ['A', 'B', 'C'],
    labels: allNamed,
  };

  test('every speaker named while the pass runs → settle', () => {
    expect(shouldSettleSpeakerId(base)).toBe(true);
  });

  test('a pass that never ran, or errored, is settled the same way', () => {
    expect(shouldSettleSpeakerId({ ...base, speakerIdStatus: null })).toBe(true);
    expect(shouldSettleSpeakerId({ ...base, speakerIdStatus: 'error' })).toBe(true);
  });

  test('naming only some speakers changes nothing — the pass may still have work', () => {
    expect(shouldSettleSpeakerId({ ...base, labels: allNamed.slice(0, 2) })).toBe(false);
    expect(shouldSettleSpeakerId({ ...base, labels: [...allNamed.slice(0, 2), label('C', ' ')] })).toBe(false);
  });

  test('a completed pass is left alone (nothing to settle, no extra event)', () => {
    expect(shouldSettleSpeakerId({ ...base, speakerIdStatus: 'completed' })).toBe(false);
  });

  test('only a completed meeting has a pass to settle', () => {
    expect(shouldSettleSpeakerId({ ...base, rowStatus: 'processing' })).toBe(false);
    expect(shouldSettleSpeakerId({ ...base, rowStatus: 'error' })).toBe(false);
  });

  test('no diarized speakers at all is not "everyone is named"', () => {
    expect(shouldSettleSpeakerId({ ...base, speakers: [] })).toBe(false);
  });

  test('accepts any iterable of speakers (a Set from the route is fine)', () => {
    expect(shouldSettleSpeakerId({ ...base, speakers: new Set(['A', 'B', 'C']) })).toBe(true);
  });
});
