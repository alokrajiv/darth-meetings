'use client';

/**
 * Client-side catalog of org-wide labels (GET /api/labels?counts=1), shared
 * by the rail, the row chips, the picker and the bulk bar so N mounted
 * chips don't issue N fetches. One module-level cache + subscriber set;
 * `refreshLabelCatalog()` re-pulls and fans the new rows out to every
 * subscriber (call it after any label mutation). The rows carry
 * `count_visible` / `count_direct` (visible-to-caller, subtree-inclusive
 * for the former) — see docs/labels-design.md §7.
 */

import { useCallback, useEffect, useState } from 'react';
import type { LabelRow } from '@/lib/labels';
import { OFFLINE_TITLE } from '@/lib/offline/offline-types';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';

export interface LabelCatalog {
  rows: LabelRow[];
  /** Map id → row, for effectiveColor / parent lookups. */
  byId: Map<number, LabelRow>;
  loaded: boolean;
  error: string | null;
  /** Optional extras the server may add alongside the rows. */
  unlabelled: number | null;
  total: number | null;
}

const EMPTY: LabelCatalog = {
  rows: [],
  byId: new Map(),
  loaded: false,
  error: null,
  unlabelled: null,
  total: null,
};

let current: LabelCatalog = EMPTY;
let inflight: Promise<void> | null = null;
const subscribers = new Set<(c: LabelCatalog) => void>();

function publish(next: LabelCatalog) {
  current = next;
  for (const fn of subscribers) fn(next);
}

/** Fetch (or re-fetch) the catalog. Concurrent calls share one request. */
export function refreshLabelCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/labels?counts=1', { credentials: 'include' });
      if (!res.ok) throw await offlineAwareError(res, `Failed to load labels (${res.status})`);
      const data = (await res.json()) as {
        labels?: LabelRow[];
        unlabelled?: number;
        total?: number;
      };
      const rows = Array.isArray(data.labels) ? data.labels : [];
      const byId = new Map<number, LabelRow>();
      for (const r of rows) byId.set(r.id, r);
      publish({
        rows,
        byId,
        loaded: true,
        error: null,
        unlabelled: typeof data.unlabelled === 'number' ? data.unlabelled : null,
        total: typeof data.total === 'number' ? data.total : null,
      });
    } catch (err) {
      // Offline / network down: the rows already loaded stay (degraded
      // scope); consumers render `error` as the reason.
      publish({
        ...current,
        loaded: true,
        error: isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Failed to load labels',
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Current snapshot without subscribing (for event handlers). */
export function peekLabelCatalog(): LabelCatalog {
  return current;
}

/**
 * Subscribe to the shared catalog; triggers the first fetch on mount when
 * nothing has been loaded yet. Returns the snapshot + a refresh function.
 */
export function useLabelCatalog(): LabelCatalog & { refresh: () => Promise<void> } {
  const [snap, setSnap] = useState<LabelCatalog>(current);
  useEffect(() => {
    subscribers.add(setSnap);
    // Snapshot may have moved between render and effect.
    setSnap(current);
    if (!current.loaded && !inflight) void refreshLabelCatalog();
    return () => {
      subscribers.delete(setSnap);
    };
  }, []);
  const refresh = useCallback(() => refreshLabelCatalog(), []);
  return { ...snap, refresh };
}
