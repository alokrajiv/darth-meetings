import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { combinedGroupHash } from '@/lib/same-file';

/**
 * The gates and the owner scoping of the same-file check
 * (docs/recordings-same-file-spec.md), with the database mocked out — the
 * point is WHAT is asked and WHETHER it is asked at all.
 *
 * The end-to-end proof (two users, real Postgres, real routes, AssemblyAI
 * stubbed) lives in `tmp/same-file/same-file.check.ts`; this is the part that
 * has to keep passing in CI, on a laptop, with no cluster anywhere.
 */

mock.module('server-only', () => ({}));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Every call the lookup received: the proof that the owner is always bound. */
const lookups: Array<{ owner: string; sha256: string }> = [];
let lookupResult: unknown = null;
let lookupThrows = false;
let tablesPresent = true;

mock.module('@/db-ops/same-file', () => ({
  recordingTablesExist: async () => tablesPresent,
  findOwnRecordingBySha256: async (owner: string, sha256: string) => {
    lookups.push({ owner, sha256 });
    if (lookupThrows) throw new Error('boom');
    return lookupResult;
  },
}));
// NOTHING else is mocked on purpose: `bun test`'s `mock.module` is process
// wide, so a partial stub of a shared db-ops module leaks into every other
// file in the run. Only `@/db-ops/same-file` is replaced — the one module no
// other test imports — and nothing here ever calls a real query.

const { duplicateForUpload, identityForPart, sameFileCheckEnabled } = await import(
  '@/lib/server/same-file'
);

const MATCH = {
  meetingId: 'abc',
  title: 'Board',
  when: '2026-09-17T01:55:00Z',
  status: 'completed',
  durationSec: 4182,
  trashed: false,
};

const OWNER = 'owner-1';
const H = sha('the bytes');

beforeEach(() => {
  lookups.length = 0;
  lookupResult = MATCH;
  lookupThrows = false;
  tablesPresent = true;
  process.env.MW_SAME_FILE_CHECK = '1';
  process.env.MW_RECORDINGS_WRITE = '1';
});

afterEach(() => {
  delete process.env.MW_SAME_FILE_CHECK;
  delete process.env.MW_RECORDINGS_WRITE;
});

const ask = (opts: { dupAware?: boolean; force?: boolean; hash?: string | null } = {}) =>
  duplicateForUpload(OWNER, opts.hash === undefined ? H : opts.hash, {
    dupAware: opts.dupAware ?? true,
    force: opts.force ?? false,
  });

describe('the gates — nothing is even asked unless all of them are open', () => {
  test('all on + dupAware → the match, looked up under the CALLER', async () => {
    expect(await ask()).toEqual(MATCH);
    expect(lookups).toEqual([{ owner: OWNER, sha256: H }]);
  });

  test('MW_SAME_FILE_CHECK off → null, and no query at all', async () => {
    delete process.env.MW_SAME_FILE_CHECK;
    expect(await ask()).toBeNull();
    expect(lookups).toHaveLength(0);
    expect(await sameFileCheckEnabled()).toBe(false);
  });

  test('MW_SAME_FILE_CHECK=0 / false is off too', async () => {
    for (const value of ['0', 'false', 'FALSE', '']) {
      process.env.MW_SAME_FILE_CHECK = value;
      expect(await ask()).toBeNull();
    }
    expect(lookups).toHaveLength(0);
  });

  test('MW_RECORDINGS_WRITE off → null (the table it reads is not maintained)', async () => {
    delete process.env.MW_RECORDINGS_WRITE;
    expect(await ask()).toBeNull();
    expect(lookups).toHaveLength(0);
  });

  test('migration 044 missing → null, forced off', async () => {
    tablesPresent = false;
    expect(await ask()).toBeNull();
    expect(await sameFileCheckEnabled()).toBe(false);
    expect(lookups).toHaveLength(0);
  });

  test('a client that did not say dupAware never gets an answer', async () => {
    expect(await ask({ dupAware: false })).toBeNull();
    expect(lookups).toHaveLength(0);
  });

  test('force skips the check entirely', async () => {
    expect(await ask({ force: true })).toBeNull();
    expect(lookups).toHaveLength(0);
  });

  test('no hash yet, or a junk one, is never a query', async () => {
    for (const hash of [null, '', 'not-a-hash', `${H}0`]) {
      expect(await ask({ hash })).toBeNull();
    }
    expect(lookups).toHaveLength(0);
  });

  test('an upper-case hash is folded before it reaches the query', async () => {
    await ask({ hash: H.toUpperCase() });
    expect(lookups).toEqual([{ owner: OWNER, sha256: H }]);
  });

  test('a lookup that fails never blocks the upload', async () => {
    lookupThrows = true;
    expect(await ask()).toBeNull();
    expect(lookups).toHaveLength(1);
  });
});

describe('identityForPart — which complete can decide the identity', () => {
  const p1 = sha('one');
  const p2 = sha('two');

  test('a single file is its own hash', () => {
    expect(identityForPart({ multi: null }, p1)).toBe(p1);
    expect(identityForPart({ multi: null }, null)).toBeNull();
  });

  const multi = (index: number) => ({
    multi: { group: 'g', index, total: 2 },
  });

  test('a declared group answers the same combined hash from every part', () => {
    const ctx = { uploadGroup: { id: 'g', total: 2, partSha256: [p1, p2], parts: [] } };
    expect(identityForPart(multi(1), p1, ctx)).toBe(combinedGroupHash([p1, p2]));
    expect(identityForPart(multi(2), p2, ctx)).toBe(combinedGroupHash([p1, p2]));
  });

  test('an undeclared group waits for the last part, then combines', () => {
    const afterPart1 = {
      uploadGroup: {
        id: 'g',
        total: 2,
        parts: [{ index: 1, tempFilename: 'a', sha256: p1 }],
      },
    };
    // Part 1 itself: nothing to combine yet.
    expect(identityForPart(multi(1), p1, afterPart1)).toBeNull();
    // Part 2 (the last): part 1 has landed, so the group is knowable.
    expect(identityForPart(multi(2), p2, afterPart1)).toBe(combinedGroupHash([p1, p2]));
  });

  test('the last part with a sibling still unhashed stays null', () => {
    const ctx = { uploadGroup: { id: 'g', total: 2, parts: [{ index: 1, tempFilename: 'a' }] } };
    expect(identityForPart(multi(2), p2, ctx)).toBeNull();
    expect(identityForPart(multi(2), null, ctx)).toBeNull();
  });

  test('a declared list of the wrong length is ignored, not half-used', () => {
    const ctx = { uploadGroup: { id: 'g', total: 2, partSha256: [p1], parts: [] } };
    expect(identityForPart(multi(1), p1, ctx)).toBeNull();
  });
});
