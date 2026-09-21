/**
 * The pure halves of the Recorder-upload contracts
 * (docs/recorder-upload-ux.md §1 P1, §2.1, §2.2):
 *
 *   - `recorderMatchIsConfident` — the ONE auto-link threshold (server-side,
 *     so the tray, darth-cli and older trays all inherit it).
 *   - `groupBytesBefore` / `groupProgressBytes` — a multi-part upload's
 *     progress is about the whole recording, never the part in flight (the
 *     2026-09-21 "77% · 12.1 MB of 15 MB" on a 696 MB, 6-part upload).
 *   - `parseMultiParams` — `multi.groupBytes` validation.
 *   - `parseUploadTracks` — the tray's `tracks: {count, mixFirst}` declaration
 *     (0.3.12), which is what lets a recorder upload take the blob fast path
 *     (DEC-1, docs/recordings-blob-spec.md).
 *
 * upload-pipeline.ts is a `server-only` module that pulls db-ops in: the
 * import is stubbed so these pure functions can be tested without a
 * Postgres handle. Nothing here touches the database.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('server-only', () => ({}));

const {
  groupBytesBefore,
  groupProgressBytes,
  parseMultiParams,
  parseUploadTracks,
  recorderMatchIsConfident,
  RECORDER_AUTOLINK_MIN_OVERLAP,
  RECORDER_AUTOLINK_MIN_SCORE,
} = await import('@/lib/server/upload-pipeline');

const match = (over: Record<string, unknown> = {}) => ({
  event_key: 'abc123|2026-09-21T03:00:00Z',
  event_id: 'ev1',
  meeting_code: 'abc-defg-hij',
  occ_start: '2026-09-21T03:00:00Z',
  title: 'Alok <> Paola',
  overlap: 1,
  title_score: 1,
  score: 1,
  candidates: [],
  matched_at: '2026-09-21T03:47:00Z',
  ...over,
});

describe('recorderMatchIsConfident', () => {
  test('a perfect match links', () => {
    expect(recorderMatchIsConfident(match())).toBe(true);
  });

  test('the thresholds themselves link (0.6 / 0.5)', () => {
    expect(
      recorderMatchIsConfident(
        match({ score: RECORDER_AUTOLINK_MIN_SCORE, overlap: RECORDER_AUTOLINK_MIN_OVERLAP })
      )
    ).toBe(true);
  });

  test('a weak score stays unlinked even with enough overlap', () => {
    expect(recorderMatchIsConfident(match({ score: 0.351, overlap: 0.501 }))).toBe(false);
  });

  test('enough score but too little overlap stays unlinked', () => {
    expect(recorderMatchIsConfident(match({ score: 0.9, overlap: 0.49 }))).toBe(false);
  });

  test('no match at all', () => {
    expect(recorderMatchIsConfident(null)).toBe(false);
    expect(recorderMatchIsConfident(undefined)).toBe(false);
  });

  test('a match with no event_key cannot be resolved, so it never links', () => {
    expect(recorderMatchIsConfident(match({ event_key: '' }))).toBe(false);
    expect(recorderMatchIsConfident(match({ event_key: '   ' }))).toBe(false);
    expect(recorderMatchIsConfident({ score: 1, overlap: 1 })).toBe(false);
  });

  test('non-numeric scores never link', () => {
    expect(recorderMatchIsConfident(match({ score: Number.NaN }))).toBe(false);
    expect(recorderMatchIsConfident(match({ overlap: undefined }))).toBe(false);
  });
});

const row = (parts: Array<{ index: number; bytes?: number }>, extra = {}) => ({
  gmeet_context: {
    uploadGroup: { id: 'g1', total: 6, parts: parts.map((p) => ({ tempFilename: 'x', ...p })), ...extra },
  },
});

describe('groupBytesBefore', () => {
  test('sums the parts that already landed', () => {
    expect(groupBytesBefore(row([{ index: 1, bytes: 100 }, { index: 2, bytes: 250 }]))).toBe(350);
  });

  test('parts still in flight (and rows from older clients) count as 0', () => {
    expect(groupBytesBefore(row([{ index: 1 }, { index: 2, bytes: 250 }]))).toBe(250);
    expect(groupBytesBefore(row([{ index: 1 }]))).toBe(0);
  });

  test('a single-file upload / a missing row is 0', () => {
    expect(groupBytesBefore(null)).toBe(0);
    expect(groupBytesBefore(undefined)).toBe(0);
    expect(groupBytesBefore({ gmeet_context: null })).toBe(0);
    expect(groupBytesBefore({ gmeet_context: { eventId: 'ev1' } })).toBe(0);
  });
});

describe('groupProgressBytes', () => {
  const group = (parts: Array<{ index: number; bytes?: number }>, bytesTotal?: number) => ({
    id: 'g1',
    total: 6,
    ...(bytesTotal ? { bytesTotal } : {}),
    parts: parts.map((p) => ({ tempFilename: 'x', ...p })),
  });

  test('a single-file upload passes its own bytes through', () => {
    expect(groupProgressBytes(null, 12_000)).toBe(12_000);
    expect(groupProgressBytes(undefined, 0)).toBe(0);
  });

  test('landed parts + the part in flight', () => {
    expect(
      groupProgressBytes(group([{ index: 1, bytes: 100 }, { index: 2, bytes: 200 }], 1_000), 50)
    ).toBe(350);
  });

  test('never overshoots the declared total', () => {
    expect(groupProgressBytes(group([{ index: 1, bytes: 900 }], 1_000), 500)).toBe(1_000);
  });

  test('the last part landing reads exactly the declared total', () => {
    const all = [1, 2, 3, 4, 5, 6].map((index) => ({ index, bytes: 100 }));
    expect(groupProgressBytes(group(all, 696_000_000))).toBe(696_000_000);
  });

  test('an older client that declared no total just gets the sum', () => {
    const all = [1, 2].map((index) => ({ index, bytes: 100 }));
    expect(groupProgressBytes(group(all))).toBe(200);
    expect(groupProgressBytes(group(all), 40)).toBe(240);
  });
});

describe('parseMultiParams groupBytes', () => {
  const base = { group: 'aaaaaaaa-bbbb', index: 1, total: 6 };

  test('absent is fine', () => {
    expect(parseMultiParams(base)?.groupBytes).toBeUndefined();
    expect(parseMultiParams({ ...base, groupBytes: null })?.groupBytes).toBeUndefined();
    expect(parseMultiParams({ ...base, groupBytes: '' })?.groupBytes).toBeUndefined();
  });

  test('a positive integer (number or string) rides along', () => {
    expect(parseMultiParams({ ...base, groupBytes: 696_000_000 })?.groupBytes).toBe(696_000_000);
    expect(parseMultiParams({ ...base, groupBytes: '696000000' })?.groupBytes).toBe(696_000_000);
  });

  test('present but nonsense is a 400 (a wrong total lies in the listing)', () => {
    expect(parseMultiParams({ ...base, groupBytes: 0 })).toBeNull();
    expect(parseMultiParams({ ...base, groupBytes: -1 })).toBeNull();
    expect(parseMultiParams({ ...base, groupBytes: 1.5 })).toBeNull();
    expect(parseMultiParams({ ...base, groupBytes: 'abc' })).toBeNull();
    expect(parseMultiParams({ ...base, groupBytes: 1e30 })).toBeNull();
  });

  test('the rest of the group params are unchanged', () => {
    expect(parseMultiParams({ ...base, comment: ' room mic ' })).toEqual({
      group: 'aaaaaaaa-bbbb',
      index: 1,
      total: 6,
      comment: 'room mic',
      groupBytes: undefined,
    });
    expect(parseMultiParams({ group: 'zz', index: 1, total: 2 })).toBeNull();
    expect(parseMultiParams({})).toBeUndefined();
  });
});

describe('parseUploadTracks (the tray\'s track declaration)', () => {
  test('absent is absent — every client but the tray, and every tray before 0.3.12', () => {
    expect(parseUploadTracks(undefined)).toBeUndefined();
    expect(parseUploadTracks(null)).toBeUndefined();
  });

  test('a well-formed declaration comes through as it was said', () => {
    expect(parseUploadTracks({ count: 3, mixFirst: true })).toEqual({ count: 3, mixFirst: true });
    expect(parseUploadTracks({ count: 2, mixFirst: false })).toEqual({ count: 2, mixFirst: false });
    // The count is informational: a client that does not know says 0 (or nothing).
    expect(parseUploadTracks({ mixFirst: true })).toEqual({ count: 0, mixFirst: true });
    expect(parseUploadTracks({ count: 0, mixFirst: false })).toEqual({ count: 0, mixFirst: false });
  });

  test('junk is null (a 400), never a silently dropped promise', () => {
    // mixFirst is the load-bearing half: it must be a real boolean.
    expect(parseUploadTracks({ count: 3 })).toBeNull();
    expect(parseUploadTracks({ count: 3, mixFirst: 'true' })).toBeNull();
    expect(parseUploadTracks({ count: 3, mixFirst: 1 })).toBeNull();
    // ...and a count that is not a plausible track count.
    expect(parseUploadTracks({ count: -1, mixFirst: true })).toBeNull();
    expect(parseUploadTracks({ count: 1.5, mixFirst: true })).toBeNull();
    expect(parseUploadTracks({ count: '3', mixFirst: true })).toBeNull();
    expect(parseUploadTracks({ count: 1e9, mixFirst: true })).toBeNull();
    // Not an object at all.
    expect(parseUploadTracks(true)).toBeNull();
    expect(parseUploadTracks('mixFirst')).toBeNull();
    expect(parseUploadTracks([{ count: 3, mixFirst: true }])).toBeNull();
  });
});
