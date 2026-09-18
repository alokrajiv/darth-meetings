import { describe, expect, test } from 'bun:test';
import { createVisibilityGate, subscriberKeyOf } from '@/lib/event-visibility';

/**
 * D4 hole #2: /api/events fanned every {kind, assemblyaiId} to every
 * browser. The gate decides per subscriber; here the access predicate is a
 * fake keyed by (subscriber, id) so the filter is tested in isolation.
 */
function setup(ttlMs = 60_000) {
  let t = 1_000_000;
  const calls: Array<[string, string]> = [];
  const allowed = new Set<string>(['alice|a@x:t-own', 'alice|a@x:t-shared', 'bob|b@x:t-shared']);
  const gate = createVisibilityGate({
    ttlMs,
    now: () => t,
    check: async (key, id) => {
      calls.push([key, id]);
      return allowed.has(`${key}:${id}`);
    },
  });
  return { gate, calls, allowed, tick: (ms: number) => (t += ms) };
}

describe('createVisibilityGate', () => {
  test('events without an id pass without a check', async () => {
    const { gate, calls } = setup();
    expect(await gate.allows('bob|b@x', { kind: 'labels' })).toBe(true);
    expect(await gate.allows('bob|b@x', { kind: 'shares' })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('owner/share verdict decides delivery; a stranger sees nothing', async () => {
    const { gate } = setup();
    expect(await gate.allows('alice|a@x', { kind: 'notes', assemblyaiId: 't-own' })).toBe(true);
    expect(await gate.allows('bob|b@x', { kind: 'notes', assemblyaiId: 't-own' })).toBe(false);
    expect(await gate.allows('bob|b@x', { kind: 'status', assemblyaiId: 't-shared' })).toBe(true);
    expect(await gate.allows('carol|c@x', { kind: 'status', assemblyaiId: 't-shared' })).toBe(false);
  });

  test('a verdict (positive or negative) is cached per (subscriber, id) until the TTL', async () => {
    const { gate, calls, tick } = setup(5_000);
    for (let i = 0; i < 5; i++) {
      await gate.allows('bob|b@x', { kind: 'status', assemblyaiId: 't-own' });
      await gate.allows('bob|b@x', { kind: 'status', assemblyaiId: 't-shared' });
    }
    expect(calls).toHaveLength(2);
    expect(gate.size('bob|b@x')).toBe(2);
    tick(5_001);
    await gate.allows('bob|b@x', { kind: 'status', assemblyaiId: 't-own' });
    expect(calls).toHaveLength(3);
  });

  test('a burst for one id shares ONE in-flight check (no per-event DB stampede)', async () => {
    let resolve: ((ok: boolean) => void) | null = null;
    let n = 0;
    const gate = createVisibilityGate({
      ttlMs: 60_000,
      check: () =>
        new Promise<boolean>((r) => {
          n++;
          resolve = r;
        }),
    });
    const burst = Promise.all(
      Array.from({ length: 25 }, () => gate.allows('alice|a@x', { kind: 'status', assemblyaiId: 't1' }))
    );
    await Promise.resolve();
    expect(n).toBe(1);
    resolve!(true);
    expect(await burst).toEqual(Array(25).fill(true));
    expect(n).toBe(1);
  });

  test('a failing check denies without caching (retried on the next event)', async () => {
    let fail = true;
    const calls: string[] = [];
    const gate = createVisibilityGate({
      ttlMs: 60_000,
      check: async (_k, id) => {
        calls.push(id);
        if (fail) throw new Error('db down');
        return true;
      },
    });
    expect(await gate.allows('alice|a@x', { kind: 'meta', assemblyaiId: 't1' })).toBe(false);
    expect(gate.size()).toBe(0);
    fail = false;
    expect(await gate.allows('alice|a@x', { kind: 'meta', assemblyaiId: 't1' })).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('per-subscriber cap evicts the oldest verdicts', async () => {
    const gate = createVisibilityGate({ ttlMs: 60_000, maxPerSubscriber: 3, check: async () => true });
    for (const id of ['a', 'b', 'c', 'd']) await gate.allows('k', { kind: 'meta', assemblyaiId: id });
    expect(gate.size('k')).toBe(3);
  });

  test('invalidate drops one subscriber or everyone', async () => {
    const { gate } = setup();
    await gate.allows('alice|a@x', { kind: 'meta', assemblyaiId: 't-own' });
    await gate.allows('bob|b@x', { kind: 'meta', assemblyaiId: 't-own' });
    gate.invalidate('bob|b@x');
    expect(gate.size('bob|b@x')).toBe(0);
    expect(gate.size('alice|a@x')).toBe(1);
    gate.invalidate();
    expect(gate.size()).toBe(0);
  });

  test('subscriberKeyOf: one person, many tabs → one cache', () => {
    expect(subscriberKeyOf({ userId: 'u1', email: ' Alice@X ' })).toBe('u1|alice@x');
    expect(subscriberKeyOf({ userId: 'u1', email: 'alice@x' })).toBe(
      subscriberKeyOf({ userId: 'u1', email: 'ALICE@x' })
    );
  });
});
