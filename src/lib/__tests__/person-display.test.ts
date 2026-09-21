import { describe, expect, test } from 'bun:test';
import { personDisplay, personHue } from '../person-display';

describe('personDisplay', () => {
  test('dotted e-mail local part → first name + initials', () => {
    expect(personDisplay('juhi.sharma@trames.sg')).toEqual({
      full: 'Juhi Sharma',
      first: 'Juhi',
      initials: 'JS',
      email: 'juhi.sharma@trames.sg',
    });
  });
  test('underscore and hyphen separators', () => {
    expect(personDisplay('antonius_hariyanto@trames.sg').first).toBe('Antonius');
    expect(personDisplay('antonius_hariyanto@trames.sg').initials).toBe('AH');
    expect(personDisplay('kawen-koh@trames.sg').full).toBe('Kawen Koh');
  });
  test('a display name wins over the e-mail', () => {
    const p = personDisplay('jsharma@trames.sg', 'Juhi Sharma');
    expect(p.first).toBe('Juhi');
    expect(p.initials).toBe('JS');
    expect(p.email).toBe('jsharma@trames.sg');
  });
  test('single-word local part → two-letter initials', () => {
    expect(personDisplay('alok@trames.sg')).toMatchObject({ first: 'Alok', initials: 'AL' });
  });
  test('trailing digits are dropped from words', () => {
    expect(personDisplay('ben.tan2@trames.sg').full).toBe('Ben Tan');
  });
  test('nothing known', () => {
    expect(personDisplay(null)).toMatchObject({ first: '—', initials: '?' });
  });
});

describe('personHue', () => {
  test('stable and in range', () => {
    expect(personHue('a@b')).toBe(personHue('a@b'));
    const h = personHue('juhi.sharma@trames.sg');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});
