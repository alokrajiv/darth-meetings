import { describe, expect, test } from 'bun:test';
import { groupLabelDisplay, isGroupLabel, speakerNameKind } from '../speaker-name-kind';

describe('speakerNameKind', () => {
  test('the labels people actually typed for a shared mic are groups', () => {
    for (const n of [
      'mixed',
      'Mixed',
      'mixed voices',
      'Mixed speakers',
      'room mic',
      'shared mic',
      'Room',
      'several people',
      'Multiple speakers',
      'everyone',
      'crosstalk',
      'background noise',
      'unknown',
      'Unknown speaker',
      'unclear',
      'inaudible',
      'n/a',
      'tbd',
      '?',
      '???',
      'voices',
      'Speaker C',
      'speaker 12',
      '—',
    ]) {
      expect(speakerNameKind(n)).toBe('group');
      expect(isGroupLabel(n)).toBe(true);
    }
  });

  test('lower-case and short names are still people', () => {
    for (const n of ['pratiksha', 'rick', 'laz', 'Anton', 'Luna', 'Ping Ping', 'Yan-Simon Saragih', 'Muhammad Adji Rizqi Ramadhan', 'Ka Wen Koh', 'Mixed Martial Arts Guy']) {
      expect(speakerNameKind(n)).toBe('person');
      expect(isGroupLabel(n)).toBe(false);
    }
  });

  test('a group word next to a real name is a person label', () => {
    expect(speakerNameKind('mixed - Atira and Anton')).toBe('person');
    expect(speakerNameKind('Room 4 - Daniel')).toBe('person');
  });

  test('empty', () => {
    expect(speakerNameKind('')).toBe('empty');
    expect(speakerNameKind('   ')).toBe('empty');
    expect(speakerNameKind(null)).toBe('empty');
    expect(speakerNameKind(undefined)).toBe('empty');
  });
});

describe('groupLabelDisplay', () => {
  test('says what the label means', () => {
    expect(groupLabelDisplay('mixed')).toBe('Several voices');
    expect(groupLabelDisplay('room mic')).toBe('Several voices · shared mic');
    expect(groupLabelDisplay('shared mic')).toBe('Several voices · shared mic');
    expect(groupLabelDisplay('unknown')).toBe('Unidentified voice');
    expect(groupLabelDisplay('background noise')).toBe('Background sound');
  });
});
