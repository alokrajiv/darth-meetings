/**
 * Per-subscriber visibility gate for the /api/events SSE stream (tech-debt
 * D4, 2026-09-18).
 *
 * The in-process bus fans every `{kind, assemblyaiId}` to every connected
 * browser; the ids grant nothing, but the stream was still an activity
 * oracle ("someone's transcript X just got notes"). This module decides,
 * per subscriber and per event, whether the event may be delivered:
 *   - events without an assemblyaiId pass (taxonomy/share-list nudges);
 *   - events with one are delivered only when `check(id)` — the caller's
 *     transcript access predicate (owner or share, db-ops/transcript-access)
 *     — says so. Verdicts are cached per (subscriber key, id) for `ttlMs`
 *     and an in-flight check is shared, so a burst of status events for one
 *     transcript costs one query per user, not one per event per tab.
 *
 * Pure (no DB, no server-only) so it is unit-tested in isolation; the
 * event-bus wires it to the real predicate.
 */

export interface VisibilityEvent {
  kind: string;
  assemblyaiId?: string;
}

export interface VisibilityGateOptions {
  /** Access predicate for one transcript id, as the subscriber's user. */
  check: (subscriberKey: string, assemblyaiId: string) => Promise<boolean>;
  /** How long a verdict (positive OR negative) is trusted. */
  ttlMs: number;
  /** Cap on cached ids per subscriber key (oldest entries evicted). */
  maxPerSubscriber?: number;
  now?: () => number;
}

export interface VisibilityGate {
  /** May `event` be delivered to `subscriberKey`? */
  allows(subscriberKey: string, event: VisibilityEvent): Promise<boolean>;
  /** Drop cached verdicts (all, or for one subscriber key). */
  invalidate(subscriberKey?: string): void;
  /** Cached verdict count (tests / diagnostics). */
  size(subscriberKey?: string): number;
}

interface Verdict {
  ok: boolean;
  exp: number;
}

export function createVisibilityGate(opts: VisibilityGateOptions): VisibilityGate {
  const now = opts.now ?? Date.now;
  const maxPer = opts.maxPerSubscriber ?? 2000;
  const cache = new Map<string, Map<string, Verdict>>();
  const inflight = new Map<string, Promise<boolean>>();

  const bucket = (key: string): Map<string, Verdict> => {
    let b = cache.get(key);
    if (!b) {
      b = new Map();
      cache.set(key, b);
    }
    return b;
  };

  const remember = (key: string, id: string, ok: boolean) => {
    const b = bucket(key);
    b.delete(id);
    b.set(id, { ok, exp: now() + opts.ttlMs });
    while (b.size > maxPer) {
      const oldest = b.keys().next().value;
      if (oldest === undefined) break;
      b.delete(oldest);
    }
  };

  const verdict = (key: string, id: string): Promise<boolean> => {
    const hit = bucket(key).get(id);
    if (hit && hit.exp > now()) return Promise.resolve(hit.ok);
    const ik = `${key}\t${id}`;
    const pending = inflight.get(ik);
    if (pending) return pending;
    const p = opts
      .check(key, id)
      .then(
        (ok) => {
          remember(key, id, ok);
          return ok;
        },
        () => {
          // A failed check never leaks: deny this time, retry on the next
          // event (nothing cached).
          return false;
        }
      )
      .finally(() => {
        inflight.delete(ik);
      });
    inflight.set(ik, p);
    return p;
  };

  return {
    allows(key, event) {
      const id = event.assemblyaiId;
      if (!id) return Promise.resolve(true);
      return verdict(key, id);
    },
    invalidate(key) {
      if (key === undefined) cache.clear();
      else cache.delete(key);
    },
    size(key) {
      if (key === undefined) {
        let n = 0;
        for (const b of cache.values()) n += b.size;
        return n;
      }
      return cache.get(key)?.size ?? 0;
    },
  };
}

/** Stable per-user key: two tabs of one person share verdicts. */
export function subscriberKeyOf(user: { userId: string; email: string }): string {
  return `${user.userId}|${user.email.trim().toLowerCase()}`;
}
