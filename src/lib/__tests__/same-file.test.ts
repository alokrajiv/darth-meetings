import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  BROWSER_HASH_MAX_BYTES,
  combinedGroupHash,
  groupHashInput,
  isDuplicateAnswer,
  normalizePartSha256,
  normalizeSha256,
  partHashesInOrder,
  shouldHashInBrowser,
  uploadIdentityHash,
  wantsDuplicateAnswer,
  wantsForce,
} from '@/lib/same-file';

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const A = h('part-a');
const B = h('part-b');
const C = h('part-c');

describe('normalizeSha256', () => {
  test('accepts 64 hex, folds case, trims', () => {
    expect(normalizeSha256(A)).toBe(A);
    expect(normalizeSha256(`  ${A.toUpperCase()} `)).toBe(A);
  });

  test('rejects everything that is not a whole-file sha256', () => {
    for (const bad of [null, undefined, 42, {}, '', 'zz', A.slice(0, 63), `${A}0`, `${A} ${A}`]) {
      expect(normalizeSha256(bad)).toBeNull();
    }
  });
});

describe('combinedGroupHash — the group identity rule', () => {
  test('is sha256 of the part hashes joined by a newline, in order', () => {
    expect(groupHashInput([A, B, C])).toBe(`${A}\n${B}\n${C}`);
    expect(combinedGroupHash([A, B, C])).toBe(h(`${A}\n${B}\n${C}`));
  });

  test('order matters — a reordered group is a different recording', () => {
    expect(combinedGroupHash([A, B])).not.toBe(combinedGroupHash([B, A]));
  });

  test('case is normalized before hashing', () => {
    expect(combinedGroupHash([A.toUpperCase(), B])).toBe(combinedGroupHash([A, B]));
  });

  test('a one-part group is NOT the part itself (a group of one does not exist)', () => {
    expect(combinedGroupHash([A])).toBe(h(A));
    expect(combinedGroupHash([A])).not.toBe(A);
  });

  test('a non-hash in the list throws rather than inventing an identity', () => {
    expect(() => combinedGroupHash([A, 'nope'])).toThrow(TypeError);
    expect(() => combinedGroupHash([])).toThrow(TypeError);
  });
});

describe('uploadIdentityHash', () => {
  test('a single file is its own hash', () => {
    expect(uploadIdentityHash({ sha256: A })).toBe(A);
  });

  test('a group with declared parts is the combined hash', () => {
    expect(uploadIdentityHash({ sha256: A, partSha256: [A, B] })).toBe(combinedGroupHash([A, B]));
  });

  test('nothing knowable yet is null, not an error', () => {
    expect(uploadIdentityHash({})).toBeNull();
    expect(uploadIdentityHash({ sha256: 'junk' })).toBeNull();
    expect(uploadIdentityHash({ sha256: null, partSha256: [] })).toBeNull();
  });
});

describe('normalizePartSha256', () => {
  test('absent is undefined (fine), junk is null (a 400)', () => {
    expect(normalizePartSha256(undefined)).toBeUndefined();
    expect(normalizePartSha256(null)).toBeUndefined();
    expect(normalizePartSha256([])).toBeNull();
    expect(normalizePartSha256('abc')).toBeNull();
    expect(normalizePartSha256([A, 'nope'])).toBeNull();
    expect(normalizePartSha256(Array.from({ length: 13 }, () => A))).toBeNull();
  });

  test('a list whose length disagrees with the declared total is invalid', () => {
    expect(normalizePartSha256([A, B], 2)).toEqual([A, B]);
    expect(normalizePartSha256([A, B], 3)).toBeNull();
  });
});

describe('partHashesInOrder', () => {
  test('sorts by part index and ignores the order they landed in', () => {
    expect(
      partHashesInOrder([{ index: 2, sha256: B }, { index: 1, sha256: A }], 2)
    ).toEqual([A, B]);
  });

  test('one part still missing → null (the check waits)', () => {
    expect(partHashesInOrder([{ index: 1, sha256: A }], 2)).toBeNull();
    expect(partHashesInOrder([{ index: 1, sha256: A }, { index: 2 }], 2)).toBeNull();
    expect(partHashesInOrder([{ index: 1, sha256: A }, { index: 2, sha256: 'x' }], 2)).toBeNull();
  });
});

describe('the wire', () => {
  test('dupAware / force are opt-in and strictly boolean true', () => {
    expect(wantsDuplicateAnswer({ dupAware: true })).toBe(true);
    for (const body of [{}, null, 'x', { dupAware: 'true' }, { dupAware: 1 }]) {
      expect(wantsDuplicateAnswer(body)).toBe(false);
    }
    expect(wantsForce({ force: true })).toBe(true);
    expect(wantsForce({ force: 'yes' })).toBe(false);
  });

  test('isDuplicateAnswer only accepts a real match payload', () => {
    expect(
      isDuplicateAnswer({
        duplicate: {
          meetingId: 'abc',
          title: 'Board',
          when: '2026-09-17T01:55:00Z',
          status: 'completed',
          durationSec: 4182,
          trashed: false,
        },
      })
    ).toBe(true);
    for (const body of [null, {}, { duplicate: null }, { duplicate: {} }, { transcript: {} }]) {
      expect(isDuplicateAnswer(body)).toBe(false);
    }
  });
});

describe('shouldHashInBrowser', () => {
  test('the 200 MB cap, and never an empty file', () => {
    expect(shouldHashInBrowser(1)).toBe(true);
    expect(shouldHashInBrowser(BROWSER_HASH_MAX_BYTES)).toBe(true);
    expect(shouldHashInBrowser(BROWSER_HASH_MAX_BYTES + 1)).toBe(false);
    expect(shouldHashInBrowser(0)).toBe(false);
  });
});
