import { STORE_OUTBOX, dbCount, dbDeleteMany, dbGetAll, dbPut } from './offline-db';
import {
  OUTBOX_BATCH,
  OUTBOX_MAX_ROWS,
  OUTBOX_SYNC_TAG,
  OUTBOX_URL,
  type OutboxFlushRequest,
  type OutboxFlushResponse,
  type OutboxKind,
  type OutboxRecord,
} from './offline-types';

/**
 * Offline activity outbox (tech-debt B1). While the device cannot reach the
 * server, the meeting page is served from the caches and nothing on the
 * server learns the meeting was opened or played — the activity bar and
 * last_accessed stay blind. This module records those reads locally with
 * their ORIGINAL timestamps and replays them once the connection is back:
 *
 *   recordOfflineActivity('view' | 'play' | 'seek', id)  → IndexedDB 'outbox'
 *   flushOutbox()  → POST /api/offline/outbox in batches, drop what the
 *                    server acknowledged (accepted or refused for good),
 *                    keep the rest for the next reconnect.
 *
 * Rules:
 *   - read-only: content edits are never queued (they would conflict with
 *     colleagues' changes — offline stays a reading mode);
 *   - coalesced per (kind, meeting) so a scrub through a recording does not
 *     produce a hundred rows (COALESCE_MS);
 *   - idempotent end to end: every row carries a `key` the server dedupes
 *     on, so a flush that lost its response is safe to repeat;
 *   - bounded: OUTBOX_MAX_ROWS, oldest dropped first;
 *   - wiped with the rest of the ledger on sign-out / account switch
 *     (dbClearAll) — a queued view is the previous user's, never replayed
 *     under a new session.
 *
 * Chrome's Background Sync is registered after every write so the worker
 * (public/sw.js, 'sync' event, same wire format) can flush with the tab
 * closed; browsers without it simply flush on the next page load.
 */

/** Minimum spacing between two queued events of the same kind for one meeting. */
export const COALESCE_MS: Record<OutboxKind, number> = {
  // Mirrors the server's own view throttle (transcript-activity VIEW_THROTTLE_MS).
  view: 10 * 60_000,
  play: 10 * 60_000,
  seek: 30_000,
};

const KINDS: readonly OutboxKind[] = ['view', 'play', 'seek'];

export function isOutboxKind(v: unknown): v is OutboxKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/** Stable idempotency key for one event. Pure — used by the tests and the worker. */
export function outboxKey(kind: OutboxKind, transcriptId: string, atMs: number): string {
  return `${kind}:${transcriptId}:${atMs}`;
}

/** true when a new event at `nowMs` falls inside the coalescing window of the last queued one. */
export function shouldCoalesce(kind: OutboxKind, lastAtMs: number | null | undefined, nowMs: number): boolean {
  if (lastAtMs === null || lastAtMs === undefined) return false;
  return nowMs - lastAtMs < COALESCE_MS[kind];
}

/**
 * Split the flush response into keys to delete locally. Accepted AND
 * rejected rows are dropped: "rejected" means the server will never take
 * them (no access, malformed) — retrying would only fail the same way.
 */
export function keysToDrop(res: OutboxFlushResponse): string[] {
  const out = new Set<string>();
  for (const k of res.accepted ?? []) if (typeof k === 'string') out.add(k);
  for (const r of res.rejected ?? []) if (r && typeof r.key === 'string') out.add(r.key);
  return [...out];
}

/** Oldest-first eviction list to stay under `max`. */
export function rowsOverCap(rows: OutboxRecord[], max: number): OutboxRecord[] {
  if (rows.length <= max) return [];
  const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.slice(0, rows.length - max);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function idbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

/** Last queued timestamp per `${kind}:${transcriptId}`, seeded from the store once. */
let lastAt: Map<string, number> | null = null;
let seeding: Promise<Map<string, number>> | null = null;

async function seedLastAt(): Promise<Map<string, number>> {
  if (lastAt) return lastAt;
  if (!seeding) {
    seeding = dbGetAll(STORE_OUTBOX)
      .then((rows) => {
        const m = new Map<string, number>();
        for (const r of rows) {
          const k = `${r.kind}:${r.transcriptId}`;
          const t = Date.parse(r.at);
          if (!Number.isFinite(t)) continue;
          const cur = m.get(k);
          if (cur === undefined || t > cur) m.set(k, t);
        }
        lastAt = m;
        return m;
      })
      .catch(() => {
        lastAt = new Map();
        return lastAt;
      });
  }
  return seeding;
}

/**
 * Queue one offline read. Returns true when a row was written (false when
 * coalesced, unsupported, or the store failed — never throws: activity is
 * observability, not load-bearing).
 */
export async function recordOfflineActivity(
  kind: OutboxKind,
  transcriptId: string,
  meta?: OutboxRecord['meta']
): Promise<boolean> {
  if (!idbAvailable() || !transcriptId) return false;
  try {
    const m = await seedLastAt();
    const now = Date.now();
    const ck = `${kind}:${transcriptId}`;
    if (shouldCoalesce(kind, m.get(ck), now)) return false;
    const rec: OutboxRecord = {
      key: outboxKey(kind, transcriptId, now),
      kind,
      transcriptId,
      at: new Date(now).toISOString(),
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    };
    await dbPut(STORE_OUTBOX, rec);
    m.set(ck, now);
    void enforceCap();
    void requestBackgroundSync();
    return true;
  } catch (err) {
    console.warn('[offline-outbox] record failed', kind, transcriptId, err);
    return false;
  }
}

async function enforceCap(): Promise<void> {
  try {
    const n = await dbCount(STORE_OUTBOX);
    if (n <= OUTBOX_MAX_ROWS) return;
    const rows = await dbGetAll(STORE_OUTBOX);
    const evict = rowsOverCap(rows, OUTBOX_MAX_ROWS);
    await dbDeleteMany(STORE_OUTBOX, evict.map((r) => r.key));
  } catch {
    /* best effort */
  }
}

/** Rows waiting for a connection (settings card). */
export async function outboxCount(): Promise<number> {
  if (!idbAvailable()) return 0;
  try {
    return await dbCount(STORE_OUTBOX);
  } catch {
    return 0;
  }
}

/**
 * Ask the worker to flush when the network returns even if the tab is gone
 * (Chrome/Edge only; a missing API is silently ignored).
 */
export async function requestBackgroundSync(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sync = (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
    if (!sync) return;
    await sync.register(OUTBOX_SYNC_TAG);
  } catch {
    /* permission denied / unsupported — the page flushes on its own */
  }
}

// ---------------------------------------------------------------------------
// Flushing
// ---------------------------------------------------------------------------

export interface FlushResult {
  /** Rows the server acknowledged (accepted + rejected) and we deleted. */
  drained: number;
  /** Rows still queued afterwards (network/5xx mid-way, or nothing to do). */
  remaining: number;
  /** Why the flush stopped early, if it did. */
  stopped?: string;
}

let inflight: Promise<FlushResult> | null = null;

/**
 * Send everything queued, oldest first, OUTBOX_BATCH rows per call.
 * Single-flight. Stops (keeping the rest) on a network failure, a 5xx or
 * a 401/403 — the session probe deals with a dead session, and the next
 * reconnect retries. A 400 means the whole batch is unusable by this
 * build's contract; those rows are dropped rather than retried forever.
 */
export function flushOutbox(reason = 'flush'): Promise<FlushResult> {
  if (inflight) return inflight;
  inflight = flushOnce(reason).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function flushOnce(reason: string): Promise<FlushResult> {
  if (!idbAvailable()) return { drained: 0, remaining: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { drained: 0, remaining: 0, stopped: 'offline' };
  let rows: OutboxRecord[];
  try {
    rows = await dbGetAll(STORE_OUTBOX);
  } catch {
    return { drained: 0, remaining: 0, stopped: 'idb' };
  }
  if (rows.length === 0) return { drained: 0, remaining: 0 };
  rows.sort((a, b) => a.at.localeCompare(b.at));

  let drained = 0;
  for (let i = 0; i < rows.length; i += OUTBOX_BATCH) {
    const batch = rows.slice(i, i + OUTBOX_BATCH);
    const body: OutboxFlushRequest = { events: batch };
    let res: Response;
    try {
      // cache:'no-store' → the worker passes it straight to the network (it
      // never intercepts POST anyway, but the intent is explicit).
      res = await fetch(OUTBOX_URL, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { drained, remaining: rows.length - drained, stopped: 'network' };
    }
    if (res.status === 400) {
      // Contract mismatch — drop the batch so the queue can never wedge.
      console.warn(`[offline-outbox] ${reason}: server rejected a batch of ${batch.length} (400) — dropped`);
      await dbDeleteMany(STORE_OUTBOX, batch.map((r) => r.key)).catch(() => undefined);
      drained += batch.length;
      continue;
    }
    if (!res.ok) {
      return { drained, remaining: rows.length - drained, stopped: `http-${res.status}` };
    }
    let parsed: OutboxFlushResponse | null = null;
    try {
      parsed = (await res.json()) as OutboxFlushResponse;
    } catch {
      parsed = null;
    }
    if (!parsed) return { drained, remaining: rows.length - drained, stopped: 'bad-response' };
    const drop = keysToDrop(parsed);
    await dbDeleteMany(STORE_OUTBOX, drop).catch(() => undefined);
    drained += drop.length;
    if (parsed.rejected?.length) {
      console.info(`[offline-outbox] ${reason}: ${parsed.rejected.length} event(s) refused`, parsed.rejected.slice(0, 5));
    }
  }
  // The coalescing map stays as-is: what was sent still counts as "recent".
  return { drained, remaining: Math.max(0, rows.length - drained) };
}
