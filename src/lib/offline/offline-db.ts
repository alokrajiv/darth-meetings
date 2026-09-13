import { IDB_NAME, IDB_VERSION, type MetaRecord, type PinRecord } from './offline-types';

/**
 * Tiny promise wrapper over IndexedDB for the offline ledger: two object
 * stores, 'pins' (keyPath id) and 'meta' (keyPath key). No library — the
 * surface we need is get/put/delete/getAll/clear and nothing else.
 *
 * Every function tolerates environments without IndexedDB (SSR, some
 * private-mode browsers) by rejecting with a plain Error the callers treat
 * as "offline support unavailable"; nothing here touches `window`.
 */

export const STORE_PINS = 'pins';
export const STORE_META = 'meta';

type StoreName = typeof STORE_PINS | typeof STORE_META;

interface StoreTypes {
  pins: PinRecord;
  meta: MetaRecord;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function idb(): IDBFactory {
  const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new Error('IndexedDB is not available');
  return f;
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb().open(IDB_NAME, IDB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PINS)) db.createObjectStore(STORE_PINS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // A later version (another tab upgrading) closes us; reopen lazily.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function withStore<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(store, mode);
  const result = requestToPromise(fn(tx.objectStore(store)));
  // A failed request rejects BOTH promises (the error bubbles request →
  // transaction); we surface the transaction's, so mark this one observed
  // or every QuotaExceededError also logs an unhandled rejection.
  result.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return result;
}

export function dbGet<S extends StoreName>(store: S, key: string): Promise<StoreTypes[S] | undefined> {
  return withStore(store, 'readonly', (s) => s.get(key) as IDBRequest<StoreTypes[S] | undefined>);
}

export function dbPut<S extends StoreName>(store: S, value: StoreTypes[S]): Promise<void> {
  return withStore(store, 'readwrite', (s) => s.put(value)).then(() => undefined);
}

export function dbDelete(store: StoreName, key: string): Promise<void> {
  return withStore(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
}

export function dbGetAll<S extends StoreName>(store: S): Promise<StoreTypes[S][]> {
  return withStore(store, 'readonly', (s) => s.getAll() as IDBRequest<StoreTypes[S][]>);
}

export function dbClear(store: StoreName): Promise<void> {
  return withStore(store, 'readwrite', (s) => s.clear()).then(() => undefined);
}

/** Convenience for the 'meta' store: get/set a single value by key. */
export async function metaGet<T = unknown>(key: string): Promise<T | undefined> {
  const row = await dbGet(STORE_META, key);
  return row?.value as T | undefined;
}

export function metaSet(key: string, value: unknown): Promise<void> {
  return dbPut(STORE_META, { key, value });
}

/** Wipe both stores (used by clearAllOffline). Missing IndexedDB → no-op. */
export async function dbClearAll(): Promise<void> {
  try {
    await dbClear(STORE_PINS);
    await dbClear(STORE_META);
  } catch {
    /* no IndexedDB → nothing to clear */
  }
}
