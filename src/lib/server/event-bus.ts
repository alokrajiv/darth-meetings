import 'server-only';
import {
  createVisibilityGate,
  subscriberKeyOf,
  type VisibilityGate,
} from '@/lib/event-visibility';

/**
 * In-process pub/sub for live UI updates. The deployment is a single pm2
 * process, so a module-level listener set is sufficient — no Redis, no
 * postgres LISTEN/NOTIFY. Mutation paths publish; /api/events fans out to
 * every connected browser over SSE.
 *
 * PRIVACY GATE (tech-debt D4, 2026-09-18): a browser subscriber only
 * receives events for transcripts its user can open (owner or share —
 * db-ops/transcript-access, the same predicate every transcript route
 * uses). Events without an assemblyaiId pass. Verdicts are cached per
 * (user, id) for VISIBILITY_TTL_MS with in-flight de-duplication
 * (lib/event-visibility), so a transcription's status burst costs one
 * query per user, not one per event per tab. Delivery per subscriber is
 * serialised through a promise chain, so events still arrive in publish
 * order even though the check is async.
 *
 * Kept on globalThis so dev hot-reloads don't strand listeners or cache.
 */

export interface MwEvent {
  /** What changed: notes | speakers | edits | meta | shares | status | created | deleted | labels
   *  ('labels' = taxonomy or assignment change; assemblyaiId set for the latter) */
  kind: string;
  /** Which transcript (absent for archive-wide events like 'created'). */
  assemblyaiId?: string;
  at: number;
}

type Listener = (e: MwEvent) => void;

/** Who a subscriber is + how to ask whether they may see one transcript. */
export interface SubscriberScope {
  user: { userId: string; email: string };
  /** Owner-or-share predicate for `assemblyaiId`, as `user`. */
  canSee: (assemblyaiId: string) => Promise<boolean>;
}

interface Subscriber {
  listener: Listener;
  scope: SubscriberScope | null;
  /** Serialises gated deliveries so order survives the async check. */
  chain: Promise<void>;
}

export const VISIBILITY_TTL_MS = 3 * 60_000;

declare global {
  var __mwEventBus: Set<Subscriber> | undefined;
  var __mwEventGate: VisibilityGate | undefined;
}

const subscribers: Set<Subscriber> =
  globalThis.__mwEventBus ?? (globalThis.__mwEventBus = new Set());

// One gate for the process: the cache is keyed by user, so every tab (and
// every reconnect) of one person shares verdicts. The check itself is
// supplied per subscription (it closes over that user's identity); the
// gate only sees the opaque key, so we route the key back to the live
// subscriber's predicate here.
const checkers = new Map<string, SubscriberScope['canSee']>();
const gate: VisibilityGate =
  globalThis.__mwEventGate ??
  (globalThis.__mwEventGate = createVisibilityGate({
    ttlMs: VISIBILITY_TTL_MS,
    check: (key, id) => {
      const fn = checkers.get(key);
      // No live subscriber for the key (it unsubscribed mid-check) → deny;
      // nothing is waiting for the answer anyway.
      return fn ? fn(id) : Promise.resolve(false);
    },
  }));

function deliver(s: Subscriber, event: MwEvent): void {
  if (!s.scope || !event.assemblyaiId) {
    try {
      s.listener(event);
    } catch {
      // one broken subscriber never blocks the rest
    }
    return;
  }
  const key = subscriberKeyOf(s.scope.user);
  s.chain = s.chain
    .then(() => gate.allows(key, event))
    .then((ok) => {
      if (!ok || !subscribers.has(s)) return;
      s.listener(event);
    })
    .catch(() => {
      // a throwing listener or check never poisons the chain
    });
}

export function publishEvent(e: Omit<MwEvent, 'at'>): void {
  const event: MwEvent = { ...e, at: Date.now() };
  for (const s of subscribers) deliver(s, event);
}

/**
 * Subscribe. With `scope` (every browser/CLI stream) events carrying an
 * assemblyaiId are delivered only when `scope.canSee(id)` holds; without it
 * (in-process consumers) everything is delivered synchronously as before.
 */
export function subscribeEvents(l: Listener, scope?: SubscriberScope): () => void {
  const s: Subscriber = { listener: l, scope: scope ?? null, chain: Promise.resolve() };
  subscribers.add(s);
  if (scope) {
    const key = subscriberKeyOf(scope.user);
    // Last subscription for a user wins the checker slot — every
    // subscription for one user answers identically, so any live one is
    // fine; the slot is released with the user's last subscriber.
    checkers.set(key, scope.canSee);
  }
  return () => {
    subscribers.delete(s);
    if (scope) {
      const key = subscriberKeyOf(scope.user);
      let stillLive = false;
      for (const o of subscribers) {
        if (o.scope && subscriberKeyOf(o.scope.user) === key) {
          stillLive = true;
          checkers.set(key, o.scope.canSee);
          break;
        }
      }
      if (!stillLive) checkers.delete(key);
    }
  };
}

/**
 * Forget cached verdicts for a user (or everyone). Share changes publish
 * an id-less 'shares' event which passes the gate anyway, and the
 * recipient's next listing fetch is server-scoped — so this is only for
 * callers that want a fresh verdict immediately.
 */
export function invalidateEventVisibility(user?: { userId: string; email: string }): void {
  gate.invalidate(user ? subscriberKeyOf(user) : undefined);
}
