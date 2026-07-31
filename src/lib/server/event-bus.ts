import 'server-only';

/**
 * In-process pub/sub for live UI updates. The deployment is a single pm2
 * process, so a module-level listener set is sufficient — no Redis, no
 * postgres LISTEN/NOTIFY. Mutation paths publish; /api/events fans out to
 * every connected browser over SSE.
 *
 * Kept on globalThis so dev hot-reloads don't strand listeners.
 */

export interface MwEvent {
  /** What changed: notes | speakers | edits | meta | shares | status | created | deleted */
  kind: string;
  /** Which transcript (absent for archive-wide events like 'created'). */
  assemblyaiId?: string;
  at: number;
}

type Listener = (e: MwEvent) => void;

declare global {
  // eslint-disable-next-line no-var
  var __mwEventBus: Set<Listener> | undefined;
}

const listeners: Set<Listener> = globalThis.__mwEventBus ?? (globalThis.__mwEventBus = new Set());

export function publishEvent(e: Omit<MwEvent, 'at'>): void {
  const event: MwEvent = { ...e, at: Date.now() };
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      // one broken subscriber never blocks the rest
    }
  }
}

export function subscribeEvents(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
