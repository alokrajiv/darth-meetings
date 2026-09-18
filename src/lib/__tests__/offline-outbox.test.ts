import { describe, expect, test } from 'bun:test';
import { COALESCE_MS, isOutboxKind, keysToDrop, outboxKey, rowsOverCap, shouldCoalesce } from '@/lib/offline/offline-outbox';
import { IDB_VERSION, OUTBOX_BATCH, OUTBOX_MAX_ROWS, type OutboxRecord } from '@/lib/offline/offline-types';

function rec(kind: OutboxRecord['kind'], id: string, atMs: number): OutboxRecord {
  return { key: outboxKey(kind, id, atMs), kind, transcriptId: id, at: new Date(atMs).toISOString() };
}

describe('offline outbox — pure parts', () => {
  test('schema version carries the outbox store', () => {
    expect(IDB_VERSION).toBeGreaterThanOrEqual(2);
    expect(OUTBOX_BATCH).toBe(200);
    expect(OUTBOX_MAX_ROWS).toBeGreaterThan(OUTBOX_BATCH);
  });

  test('outboxKey is stable and unique per (kind, meeting, ms)', () => {
    expect(outboxKey('view', 'abc', 1_700_000_000_000)).toBe('view:abc:1700000000000');
    expect(outboxKey('view', 'abc', 1)).not.toBe(outboxKey('play', 'abc', 1));
    expect(outboxKey('view', 'abc', 1)).not.toBe(outboxKey('view', 'abd', 1));
  });

  test('isOutboxKind accepts the three read kinds only (edits stay out)', () => {
    expect(isOutboxKind('view')).toBe(true);
    expect(isOutboxKind('play')).toBe(true);
    expect(isOutboxKind('seek')).toBe(true);
    expect(isOutboxKind('edit_text')).toBe(false);
    expect(isOutboxKind(undefined)).toBe(false);
  });

  test('shouldCoalesce: views/plays 10 min, seeks 30 s, first event never coalesced', () => {
    const t0 = 1_700_000_000_000;
    expect(shouldCoalesce('view', null, t0)).toBe(false);
    expect(shouldCoalesce('view', undefined, t0)).toBe(false);
    expect(shouldCoalesce('view', t0, t0 + COALESCE_MS.view - 1)).toBe(true);
    expect(shouldCoalesce('view', t0, t0 + COALESCE_MS.view)).toBe(false);
    expect(shouldCoalesce('seek', t0, t0 + 29_999)).toBe(true);
    expect(shouldCoalesce('seek', t0, t0 + 30_000)).toBe(false);
    expect(COALESCE_MS.view).toBe(10 * 60_000); // mirrors the server's VIEW_THROTTLE_MS
  });

  test('keysToDrop: accepted AND rejected keys are dropped locally, deduped', () => {
    const drop = keysToDrop({
      accepted: ['a', 'b', 'b'],
      rejected: [{ key: 'c', reason: 'no-access' }, { key: 'a', reason: 'dup' }],
      inserted: 2,
    });
    expect(drop.sort()).toEqual(['a', 'b', 'c']);
  });

  test('keysToDrop tolerates a partial / malformed response', () => {
    expect(keysToDrop({ accepted: [], rejected: [], inserted: 0 })).toEqual([]);
    expect(keysToDrop({ accepted: undefined, rejected: undefined, inserted: 0 } as never)).toEqual([]);
  });

  test('rowsOverCap evicts the oldest first and nothing under the cap', () => {
    const t0 = 1_700_000_000_000;
    const rows = [rec('view', 'c', t0 + 3), rec('view', 'a', t0 + 1), rec('play', 'b', t0 + 2)];
    expect(rowsOverCap(rows, 3)).toEqual([]);
    expect(rowsOverCap(rows, 2).map((r) => r.transcriptId)).toEqual(['a']);
    expect(rowsOverCap(rows, 1).map((r) => r.transcriptId)).toEqual(['a', 'b']);
    expect(rows[0]!.transcriptId).toBe('c'); // input untouched
  });
});
