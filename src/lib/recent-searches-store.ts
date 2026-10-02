/**
 * Where "Recent searches" (lib/recent-searches.ts) live. Browser only.
 *
 * Inside the Darth desktop shell: the shell's local store for Meetings
 * (`window.darthDesktop.store`, one SQLite file per app — desktop
 * docs/OFFLINE.md). One row per person (`owner` = the darth user id from
 * GET /api/auth/session), so a second person signing in over the same
 * session never sees the first one's queries; the shell deletes the whole
 * store on sign-out. Small UI state only — no tokens, nothing secret.
 *
 * Anywhere else (a browser, or an older shell without the store bridge):
 * localStorage under RECENT_LS_KEY, same per-owner keying.
 *
 * Every call resolves (never throws); a broken store reads as "no recents".
 */

import { sanitizeRecentSearches, type RecentSearch } from '@/lib/recent-searches';

export const RECENT_TABLE = 'recent_searches';
export const RECENT_LS_KEY = 'darth-meetings-recent-searches';

type StoreResult = { rows?: Array<Record<string, unknown>>; error?: { code: string; message: string } };
interface DesktopStore {
  exec(sql: string, params?: unknown[]): Promise<StoreResult>;
  query(sql: string, params?: unknown[]): Promise<StoreResult>;
}

function desktopStore(): DesktopStore | null {
  if (typeof window === 'undefined') return null;
  const d = (window as unknown as { darthDesktop?: { store?: DesktopStore } }).darthDesktop;
  return d?.store && typeof d.store.query === 'function' && typeof d.store.exec === 'function' ? d.store : null;
}

let ownerPromise: Promise<string> | null = null;
/** The signed-in person's id ('' when unknown — still usable, just unkeyed). */
function owner(): Promise<string> {
  if (!ownerPromise) {
    ownerPromise = fetch('/api/auth/session', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const b = (await r.json()) as { userId?: unknown };
        return typeof b.userId === 'string' ? b.userId : '';
      })
      .catch(() => {
        ownerPromise = null; // ask again next time
        return '';
      });
  }
  return ownerPromise;
}

let tableReady: Promise<boolean> | null = null;
function ensureTable(store: DesktopStore): Promise<boolean> {
  if (!tableReady) {
    tableReady = store
      .exec(`CREATE TABLE IF NOT EXISTS ${RECENT_TABLE} (owner TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
      .then((r) => !r?.error)
      .catch(() => false)
      .then((ok) => {
        if (!ok) tableReady = null;
        return ok;
      });
  }
  return tableReady;
}

function readLocal(who: string): RecentSearch[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_LS_KEY) || '{}') as Record<string, unknown>;
    return sanitizeRecentSearches(all?.[who]);
  } catch {
    return [];
  }
}

function writeLocal(who: string, list: RecentSearch[]): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_LS_KEY) || '{}') as Record<string, unknown>;
    const next = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    next[who] = list;
    window.localStorage.setItem(RECENT_LS_KEY, JSON.stringify(next));
  } catch {
    /* private window / blocked storage: recents just are not kept */
  }
}

export async function loadRecentSearches(): Promise<RecentSearch[]> {
  const who = await owner();
  const store = desktopStore();
  if (store && (await ensureTable(store))) {
    try {
      const r = await store.query(`SELECT json FROM ${RECENT_TABLE} WHERE owner = ?`, [who]);
      const json = r?.rows?.[0]?.json;
      if (r?.error || typeof json !== 'string') return [];
      return sanitizeRecentSearches(JSON.parse(json));
    } catch {
      return [];
    }
  }
  return readLocal(who);
}

export async function saveRecentSearches(list: RecentSearch[]): Promise<void> {
  const who = await owner();
  const store = desktopStore();
  if (store && (await ensureTable(store))) {
    try {
      await store.exec(
        `INSERT INTO ${RECENT_TABLE} (owner, json, updated_at) VALUES (?, ?, ?) ` +
          `ON CONFLICT(owner) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        [who, JSON.stringify(list), Date.now()]
      );
    } catch {
      /* the store refused: recents just are not kept */
    }
    return;
  }
  writeLocal(who, list);
}
