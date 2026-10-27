/**
 * A speaker is a person (2026-10-27, phase 1): the pure rules behind the
 * email on SpeakerLabel / SpeakerSuggestion — the one name→email match, the
 * canonical spelling, the invitee candidates.
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalSpeakerName,
  inviteeCandidates,
  isEmailShape,
  matchEmailByName,
  normalizeEmail,
} from '../speaker-identity';

describe('email shape', () => {
  test('normalises and accepts addresses, refuses names and angle-bracket forms', () => {
    expect(normalizeEmail('  Test-A@Example.COM ')).toBe('test-a@example.com');
    expect(isEmailShape('test-a@example.com')).toBe(true);
    expect(isEmailShape('Test Person A')).toBe(false);
    expect(isEmailShape('Name <test-a@example.com>')).toBe(false);
    expect(isEmailShape('a@b')).toBe(false);
    expect(isEmailShape('')).toBe(false);
    expect(isEmailShape(null)).toBe(false);
  });
});

describe('matchEmailByName — one person or nobody', () => {
  const invitees = [
    { name: 'Test Person A', email: 'test-a@example.com' },
    { name: 'Test Person B', email: 'test-b@example.com' },
    { name: 'Other Person', email: 'other@example.com' },
  ];

  test('exactly one invitee with that name → its email, case- and spacing-insensitive', () => {
    expect(matchEmailByName('Test Person A', invitees)).toBe('test-a@example.com');
    expect(matchEmailByName('  test  person b ', invitees)).toBe('test-b@example.com');
    expect(matchEmailByName('test.person.a', invitees)).toBe('test-a@example.com');
  });

  test('no match → null; never the closest', () => {
    expect(matchEmailByName('Test Person C', invitees)).toBeNull();
    expect(matchEmailByName('', invitees)).toBeNull();
    expect(matchEmailByName('Test Person A', [])).toBeNull();
  });

  test('two candidates with the same name → null, never a guess', () => {
    const twins = [...invitees, { name: 'Test Person A', email: 'test-a2@example.com' }];
    expect(matchEmailByName('Test Person A', twins)).toBeNull();
  });

  test('the same person listed twice is not an ambiguity', () => {
    const dup = [...invitees, { name: 'Test Person A', email: 'TEST-A@example.com' }];
    expect(matchEmailByName('Test Person A', dup)).toBe('test-a@example.com');
  });

  test('"First Last" matches exactly one LONGER directory name; two longer names → null', () => {
    const directory = [
      { name: 'Test Person A Middle', email: 'test-a@example.com' },
      { name: 'Test Person B', email: 'test-b@example.com' },
    ];
    expect(matchEmailByName('Test Person A', directory)).toBe('test-a@example.com');
    const two = [...directory, { name: 'Test Person A Other', email: 'test-a3@example.com' }];
    expect(matchEmailByName('Test Person A', two)).toBeNull();
    // An exact match wins over longer names.
    const exactToo = [...two, { name: 'Test Person A', email: 'exact@example.com' }];
    expect(matchEmailByName('Test Person A', exactToo)).toBe('exact@example.com');
  });

  test('a one-word name never matches a longer name (too many people share a first name)', () => {
    expect(matchEmailByName('Test', [{ name: 'Test Person A', email: 'test-a@example.com' }])).toBeNull();
    // …unless it is an exact one-word name.
    expect(matchEmailByName('Test', [{ name: 'Test', email: 'test@example.com' }])).toBe('test@example.com');
  });

  test('candidates without a usable email are ignored', () => {
    expect(matchEmailByName('Test Person A', [{ name: 'Test Person A', email: null }, { name: 'Test Person A', email: 'not an email' }])).toBeNull();
  });
});

describe('canonicalSpeakerName — directory → invitee → sent → local part', () => {
  test('precedence', () => {
    const email = 'test-a@example.com';
    expect(canonicalSpeakerName({ sent: 'A Sent', directoryName: 'Directory A', inviteeName: 'Invitee A' }, email)).toBe('Directory A');
    expect(canonicalSpeakerName({ sent: 'A Sent', directoryName: null, inviteeName: 'Invitee A' }, email)).toBe('Invitee A');
    expect(canonicalSpeakerName({ sent: 'A Sent', directoryName: '  ', inviteeName: '' }, email)).toBe('A Sent');
    expect(canonicalSpeakerName({ sent: '' }, email)).toBe('test-a');
  });
});

describe('inviteeCandidates', () => {
  test('invite names first, directory names fill the gaps, nothing invented', () => {
    const out = inviteeCandidates(
      [
        { email: 'test-a@example.com', name: 'Invitee A' },
        { email: 'Test-B@example.com' },
        { email: 'test-c@example.com', name: '' },
      ],
      new Map([['test-b@example.com', 'Directory B']])
    );
    expect(out).toEqual([
      { email: 'test-a@example.com', name: 'Invitee A' },
      { email: 'Test-B@example.com', name: 'Directory B' },
      { email: 'test-c@example.com', name: null },
    ]);
    expect(inviteeCandidates(null)).toEqual([]);
  });
});
