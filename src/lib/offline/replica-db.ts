/**
 * The desktop replica's DATABASE layer: the shell's store bridge
 * (`window.darthDesktop.store`, desktop docs/OFFLINE.md §3) as a small
 * never-throwing handle, the schema, `migrate()` and `ensureOwner()`.
 * No React, no Meetings rule (those live in replica.ts).
 *
 * Bridge rules this file respects: async calls that resolve to a result or
 * `{error: {code, message}}`; ONE statement per call; values only as params;
 * no BEGIN/COMMIT of our own (`transaction([...])`, ≤ 500 statements, all or
 * nothing); only the user_version pragma; fts5 allowed; 50 MB per database
 * (QUOTA beyond — deletes always work); wiped by the shell on Sign out.
 *
 * FTS5: shells ≤ 0.4 deny FTS5's internal `PRAGMA data_version` (Darth Chat
 * SPEC §20.83-8), so every FTS5 read/write fails there although CREATE works.
 * `openReplicaDb` probes once; when FTS is refused the plain `search_lite`
 * table takes the same rows and search uses LIKE.
 */

export type SqlParam = string | number | null;
export type StoreStatement = { sql: string; params?: SqlParam[] };
export type StoreErrorShape = { code: string; message: string };
type Err = { error: StoreErrorShape };

/** `window.darthDesktop.store` (only what the replica calls). */
export type DesktopStoreBridge = {
  exec(sql: string, params?: SqlParam[]): Promise<unknown>;
  query(sql: string, params?: SqlParam[]): Promise<{ rows: Record<string, unknown>[] } | Err>;
  transaction(statements: StoreStatement[]): Promise<{ results: unknown[] } | Err>;
};

type BridgeWindow = { darthDesktop?: { store?: Partial<DesktopStoreBridge> } };

/** The bridge, or null (the web, an older shell, SSR). Tests pass `win`. */
export function desktopStoreBridge(win?: unknown): DesktopStoreBridge | null {
  const w = (win ?? (typeof window === 'undefined' ? undefined : window)) as BridgeWindow | undefined;
  const s = w?.darthDesktop?.store;
  if (!s || typeof s.exec !== 'function' || typeof s.query !== 'function' || typeof s.transaction !== 'function') {
    return null;
  }
  return s as DesktopStoreBridge;
}

function isErr(v: unknown): v is Err {
  return !!v && typeof v === 'object' && 'error' in v && !!(v as Err).error;
}

export const REPLICA_VERSION = 1;
export const TX_MAX = 500;

/** Every table the replica owns (wiped on an owner change, dropped on a version change). */
export const REPLICA_TABLES = ['meta', 'meetings', 'docs', 'search', 'search_lite'] as const;

/**
 * v1 schema.
 *  meetings  the listing the person sees: the newest 100 rows of the default
 *            listing (`list_rank` 0..99), as the API served them (row_json).
 *  docs      one opened / synced meeting in compact text: meta_json (title,
 *            dates, attendees, speakers, labels…), the AI notes + report
 *            markdown, and turns_json ([[speaker, startMs, text], …]).
 *            `bytes` is the size estimate the eviction budget counts.
 *  search    fts5 over title / description / notes / content (one row per
 *            meeting: docs give all four; listing-only rows title +
 *            description). `id`, `at` unindexed.
 *  search_lite  the same columns as a plain table, used only when the shell
 *            refuses FTS5 (LIKE search).
 */
export const REPLICA_SCHEMA: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, at TEXT NOT NULL, list_rank INTEGER, row_json TEXT NOT NULL, listed_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS meetings_by_rank ON meetings (list_rank)',
  'CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, at TEXT NOT NULL, rev TEXT, saved_at INTEGER NOT NULL, bytes INTEGER NOT NULL, meta_json TEXT NOT NULL, notes TEXT, report TEXT, turns_json TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS docs_by_at ON docs (at)',
  "CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, at UNINDEXED, title, description, notes, content, tokenize = 'unicode61 remove_diacritics 2')",
  'CREATE TABLE IF NOT EXISTS search_lite (id TEXT PRIMARY KEY, at TEXT NOT NULL, title TEXT, description TEXT, notes TEXT, content TEXT)',
];

/** Statements for a fresh (0) or mismatched store version, ending in the stamp. Pure. */
export function migrationStatements(heldVersion: number): StoreStatement[] {
  const drop: StoreStatement[] =
    heldVersion === 0 ? [] : [...REPLICA_TABLES].reverse().map((t) => ({ sql: `DROP TABLE IF EXISTS ${t}` }));
  return [
    ...drop,
    ...REPLICA_SCHEMA.map((sql) => ({ sql })),
    { sql: `PRAGMA user_version = ${REPLICA_VERSION}` },
  ];
}

/** Every row of every table — another owner's replica, before ours is keyed. */
export function wipeStatements(fts: boolean): StoreStatement[] {
  return REPLICA_TABLES.filter((t) => fts || t !== 'search').map((t) => ({ sql: `DELETE FROM ${t}` }));
}

export const FTS_PROBE_SQL = 'SELECT rowid FROM search WHERE search MATCH ? LIMIT 1';

export type TxResult = { ok: true } | { ok: false; code: string };

export interface ReplicaDb {
  /** FTS5 works on this store (else `search_lite` + LIKE). */
  fts: boolean;
  /** The owner this handle was keyed for (null = opened offline, unverified: read only). */
  owner: string | null;
  /** Rows, or null on any failure (logged once per code). */
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[] | null>;
  /** All or nothing, after every earlier write (one promise chain). Never throws. */
  tx(statements: readonly StoreStatement[]): Promise<TxResult>;
  /** False once the bridge said UNAVAILABLE. */
  live(): boolean;
}

export type ReplicaLog = (line: string) => void;
const defaultLog: ReplicaLog = (line) => {
  if (typeof console !== 'undefined') console.warn(line);
};

/** The bridge as a ReplicaDb (exported for tests; the app uses openReplicaDb). */
export function wrapBridge(
  bridge: DesktopStoreBridge,
  opts: { fts: boolean; owner: string | null; log?: ReplicaLog }
): ReplicaDb {
  const log = opts.log ?? defaultLog;
  let off = false;
  const logged = new Set<string>();
  const note = (what: string, e: StoreErrorShape) => {
    if (e.code === 'UNAVAILABLE') off = true;
    if (logged.has(e.code)) return;
    logged.add(e.code);
    log(`[meetings-replica] ${what} failed: ${e.code}${e.message ? ` (${String(e.message).slice(0, 160)})` : ''}`);
  };
  let chain: Promise<unknown> = Promise.resolve();
  return {
    fts: opts.fts,
    owner: opts.owner,
    live: () => !off,
    async query<T>(sql: string, params?: SqlParam[]): Promise<T[] | null> {
      if (off) return null;
      try {
        const r = await bridge.query(sql, params);
        if (isErr(r)) {
          note('query', r.error);
          return null;
        }
        return Array.isArray(r?.rows) ? (r.rows as T[]) : null;
      } catch (e) {
        note('query', { code: 'IPC', message: e instanceof Error ? e.message : String(e) });
        return null;
      }
    },
    tx(statements) {
      const run = async (): Promise<TxResult> => {
        if (off) return { ok: false, code: 'UNAVAILABLE' };
        if (statements.length === 0) return { ok: true };
        for (let i = 0; i < statements.length; i += TX_MAX) {
          const group = statements.slice(i, i + TX_MAX);
          try {
            const r = await bridge.transaction(group);
            if (isErr(r)) {
              // QUOTA is expected (the caller evicts and retries): not a log line.
              if (r.error.code !== 'QUOTA') note('write', r.error);
              return { ok: false, code: r.error.code };
            }
          } catch (e) {
            note('write', { code: 'IPC', message: e instanceof Error ? e.message : String(e) });
            return { ok: false, code: 'IPC' };
          }
        }
        return { ok: true };
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
  };
}

/**
 * `migrate()` + (with an owner) `ensureOwner(owner)`, then the handle — or
 * null when the store is off (UNAVAILABLE, a failed migration). `owner` null
 * = opened without knowing who is signed in (offline): reads only; the
 * caller must not write through it.
 */
export async function openReplicaDb(
  bridge: DesktopStoreBridge,
  owner: string | null,
  log: ReplicaLog = defaultLog
): Promise<ReplicaDb | null> {
  const probe = wrapBridge(bridge, { fts: false, owner: null, log });
  const v = await probe.query<{ user_version: number }>('PRAGMA user_version');
  if (!v) return null;
  const held = Number(v[0]?.user_version ?? 0) || 0;
  if (held !== REPLICA_VERSION) {
    const r = await probe.tx(migrationStatements(held));
    if (!r.ok) return null;
  }
  let fts = true;
  try {
    const p = await bridge.query(FTS_PROBE_SQL, ['"darth"']);
    if (isErr(p)) {
      fts = false;
      log(`[meetings-replica] fts5 refused by the shell (${p.error.code}): local search uses LIKE`);
    }
  } catch {
    fts = false;
  }
  const db = wrapBridge(bridge, { fts, owner, log });
  if (owner !== null) {
    const o = await db.query<{ v: string }>('SELECT v FROM meta WHERE k = ?', ['owner']);
    if (!o) return null;
    const heldOwner = o[0]?.v ?? null;
    if (heldOwner !== owner) {
      const stmts = heldOwner !== null ? wipeStatements(fts) : [];
      stmts.push({
        sql: 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
        params: ['owner', owner],
      });
      const r = await db.tx(stmts);
      if (!r.ok) return null;
    }
  }
  return db.live() ? db : null;
}
