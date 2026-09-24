import { describe, expect, test } from 'bun:test';
import { personNameKey, samePerson } from '@/lib/person-identity';

describe('personNameKey', () => {
  test('folds login spellings and invisible characters', () => {
    expect(personNameKey('karnica.katiyar')).toBe('karnica katiyar');
    expect(personNameKey('Karnica  Katiyar ')).toBe('karnica katiyar');
    expect(personNameKey('shridhar.​tirthkar')).toBe('shridhar tirthkar');
    expect(personNameKey('ashey_sharma')).toBe('ashey sharma');
  });
});

describe('samePerson', () => {
  test('login vs display spelling', () => {
    expect(samePerson('karnica.katiyar', 'Karnica Katiyar')).toBe(true);
    expect(samePerson('shridhar.tirthkar', 'shridhar.​tirthkar')).toBe(true);
  });
  test('first name vs full name, spacing variants', () => {
    expect(samePerson('Ivan', 'Ivan Seow')).toBe(true);
    expect(samePerson('LiXuan', 'Li Xuan')).toBe(true);
    expect(samePerson('Ka Wen Koh', 'Kawen Koh')).toBe(true); // the prod duplicate the 2026-09-24 diagnostic found
  });
  test('different people', () => {
    expect(samePerson('Ankit Thakur', 'Ashey Sharma')).toBe(false);
    expect(samePerson('', 'Ivan')).toBe(false);
  });
});
