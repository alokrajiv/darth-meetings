/**
 * Test-only stand-in for the Darth desktop shell's local store bridge, copied
 * from Darth Chat (test/helpers/fake-desktop-store.ts, lane OD) so the
 * Meetings replica is held to the same rules: node:sqlite under Bun with the
 * shell's text filter, authorizer, limits and QUOTA. The desktop repo is never
 * imported. `allowDataVersion: true` = shells ≥ 0.4.x that let FTS5 read its
 * internal data_version pragma; the default reproduces older shells, where
 * every FTS5 read/write is DENIED (the replica then falls back to LIKE).
 *
 * Original header:
 */
/**
 * Lane OD (SPEC §20.83): a stand-in for the Darth desktop shell's local store bridge, for tests only.
 *
 * It implements the contract of `../desktop/docs/OFFLINE.md` §3 and ARCHITECTURE.md "Local store bridge" over
 * `node:sqlite` (Bun provides it, FTS5 and `setAuthorizer` included) with the shell's rules, re-stated here — the
 * desktop repo is never imported:
 *
 *   · every call resolves to a result or `{ error: { code, message } }`, never throws;
 *   · the text: 1..64 KB, ONE statement (a trailing second one → BAD_SQL), the REJECT_SQL filter (attach / detach /
 *     vacuum / load_extension / any pragma but user_version, journal_mode, synchronous) → DENIED;
 *   · an authorizer: BEGIN/COMMIT/ROLLBACK/SAVEPOINT, ATTACH/DETACH, other pragmas, load_extension and virtual tables
 *     other than fts3/4/5 and rtree are denied;
 *   · params ≤ 1000 (null / finite number / string / boolean / bigint / Uint8Array), ≤ 16 MB;
 *   · ≤ 10 000 rows per query (more → TOO_MANY_ROWS, nothing returned); ≤ 500 statements per transaction, all or
 *     nothing (`statement <i>: …`);
 *   · a database size cap (`PRAGMA max_page_count`, set internally) → QUOTA on a write beyond; deletes still work.
 *
 * FTS5 FINDING (lane OD, 2026-10-04): FTS5 prepares `PRAGMA data_version` internally the first time it reads or
 * writes its index, and the shell's authorizer (store-bridge.js `authorize`) denies every pragma but the three — so
 * on the shell as it is, every FTS5 insert / delete / MATCH is DENIED (CREATE / DROP work). `allowDataVersion: true`
 * is the one-line fix the desktop needs (allow the read-only `data_version` pragma); the default reproduces today's
 * shell so the replica's fallback is tested against the real behaviour.
 *
 * Test seams: `calls` (every call, for "this SQL never reached the store" assertions), `failNext(code)` (the next
 * write answers that error once), `quotaPages` (a tiny cap to provoke QUOTA for real).
 */
// @ts-expect-error -- @types/node 20 has no `node:sqlite` declarations; Bun provides the module (FTS5 and setAuthorizer included).
import { DatabaseSync as RawDatabaseSync } from "node:sqlite";

/** The slice of node:sqlite's DatabaseSync this fake uses. */
type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: never[]): { changes: number | bigint; lastInsertRowid: number | bigint }; iterate(...args: never[]): Iterable<unknown>; all(...args: never[]): unknown[] };
  close(): void;
};
const DatabaseSyncCtor = RawDatabaseSync as unknown as new (file: string, o?: Record<string, unknown>) => DatabaseSync;

export type StoreParams = unknown[] | undefined;
export type StoreStatement = { sql: string; params?: unknown[] };
export type StoreErr = { error: { code: string; message: string } };
export type FakeStoreCall = { kind: "exec" | "query" | "transaction"; statements: StoreStatement[] };

export const FAKE_LIMITS = { sqlBytes: 64 * 1024, params: 1000, paramBytes: 16 * 1024 * 1024, rows: 10_000, statements: 500 } as const;
const REJECT_SQL = /\b(?:attach|detach|vacuum)\b|\bload_extension\b|\bpragma\b(?!\s*(?:user_version|journal_mode|synchronous)\b)/i;
const ALLOWED_PRAGMAS = new Set(["user_version", "journal_mode", "synchronous"]);
const ALLOWED_VTABLES = new Set(["fts3", "fts4", "fts5", "rtree"]);
// sqlite3.h action codes.
const A = { PRAGMA: 19, TRANSACTION: 22, ATTACH: 24, DETACH: 25, CREATE_VTABLE: 29, DROP_VTABLE: 30, FUNCTION: 31, SAVEPOINT: 32 } as const;

class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function hasTrailingStatement(sql: string): boolean {
  let i = 0;
  let ended = false;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      const j = sql.indexOf("\n", i);
      i = j === -1 ? sql.length : j + 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j === -1 ? sql.length : j + 2;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (ended) {
      if (c !== ";") return true;
      i++;
      continue;
    }
    if (c === ";") {
      ended = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return false;
}

function checkSql(sql: unknown): void {
  if (typeof sql !== "string" || sql.trim() === "") throw new StoreError("BAD_SQL", "sql must be a non-empty string");
  if (Buffer.byteLength(sql, "utf8") > FAKE_LIMITS.sqlBytes) throw new StoreError("TOO_LARGE", "sql too large");
  if (REJECT_SQL.test(sql)) throw new StoreError("DENIED", "statement not allowed");
  if (hasTrailingStatement(sql)) throw new StoreError("BAD_SQL", "one statement per call (use transaction() for several)");
}

function checkParams(params: unknown): unknown[] {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) throw new StoreError("BAD_PARAMS", "params must be an array");
  if (params.length > FAKE_LIMITS.params) throw new StoreError("TOO_LARGE", "more than 1000 params");
  let bytes = 0;
  for (const v of params) {
    const ok = v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "bigint" || (typeof v === "number" && Number.isFinite(v)) || v instanceof Uint8Array;
    if (!ok) throw new StoreError("BAD_PARAMS", "a param must be null, a finite number, a string, a boolean, a bigint or a Uint8Array");
    bytes += typeof v === "string" ? Buffer.byteLength(v, "utf8") : v instanceof Uint8Array ? v.byteLength : 8;
  }
  if (bytes > FAKE_LIMITS.paramBytes) throw new StoreError("TOO_LARGE", "params too large");
  // node:sqlite binds booleans poorly: the shell's runtime takes them, so map them the way SQLite stores them.
  return params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
}

function mapError(e: unknown): { code: string; message: string } {
  if (e instanceof StoreError) return { code: e.code, message: e.message };
  const err = e as { errcode?: number; message?: string; code?: string } | null;
  const errcode = err && typeof err.errcode === "number" ? err.errcode & 0xff : null;
  const msg = String(err?.message ?? e ?? "error").slice(0, 300);
  if (errcode === 13 || /database or disk is full/i.test(msg)) return { code: "QUOTA", message: "the app's local store is full" };
  if (errcode === 23 || /not authorized|authorization denied/i.test(msg)) return { code: "DENIED", message: "statement not allowed" };
  if (errcode === 5 || errcode === 6) return { code: "BUSY", message: msg };
  return { code: "SQL_ERROR", message: msg };
}

export type FakeDesktopStore = {
  exec(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number } | StoreErr>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] } | StoreErr>;
  transaction(statements: StoreStatement[]): Promise<{ results: { changes: number; lastInsertRowid: number }[] } | StoreErr>;
  /** Every call that reached the bridge, in order. */
  calls: FakeStoreCall[];
  /** The next exec/transaction answers `{error: {code}}` without touching the db (once). */
  failNext(code: string): void;
  /** Raw access for assertions (bypasses every rule). */
  raw: DatabaseSync;
  close(): void;
};

/** A fresh in-memory store with the shell's rules. `maxPages` caps the db (page_size 4096) to provoke QUOTA. */
export function createFakeDesktopStore(o: { maxPages?: number; file?: string; allowDataVersion?: boolean } = {}): FakeDesktopStore {
  const db = new DatabaseSyncCtor(o.file ?? ":memory:", { enableForeignKeyConstraints: true });
  let internal = false;
  const runInternal = (sql: string) => {
    internal = true;
    try {
      db.exec(sql);
    } finally {
      internal = false;
    }
  };
  if (o.maxPages) runInternal(`PRAGMA max_page_count = ${o.maxPages}`);
  const setAuth = (db as unknown as { setAuthorizer?: (fn: (action: number, a1: string | null, a2: string | null) => number) => void }).setAuthorizer;
  if (typeof setAuth !== "function") throw new Error("node:sqlite without setAuthorizer: the fake bridge refuses to open (fail closed, like the shell)");
  setAuth.call(db, (action, a1, a2) => {
    if (internal) return 0;
    switch (action) {
      case A.ATTACH:
      case A.DETACH:
      case A.TRANSACTION:
      case A.SAVEPOINT:
        return 1;
      case A.PRAGMA: {
        const name = String(a1 ?? "").toLowerCase();
        if (o.allowDataVersion && name === "data_version" && a2 == null) return 0;
        if (!ALLOWED_PRAGMAS.has(name)) return 1;
        if (name === "journal_mode" && a2 != null && String(a2).toLowerCase() !== "wal") return 1;
        return 0;
      }
      case A.FUNCTION:
        return ["load_extension", "fts3_tokenizer"].includes(String(a2 ?? "").toLowerCase()) ? 1 : 0;
      case A.CREATE_VTABLE:
      case A.DROP_VTABLE:
        return ALLOWED_VTABLES.has(String(a2 ?? "").toLowerCase()) ? 0 : 1;
      default:
        return 0;
    }
  });

  const calls: FakeStoreCall[] = [];
  let failCode: string | null = null;
  const takeFail = (): StoreErr | null => {
    if (!failCode) return null;
    const code = failCode;
    failCode = null;
    return { error: { code, message: `injected ${code}` } };
  };

  const execOne = (sql: string, params: unknown) => {
    checkSql(sql);
    const args = checkParams(params) as never[];
    const r = db.prepare(sql).run(...args);
    return { changes: Number(r.changes) || 0, lastInsertRowid: Number(r.lastInsertRowid) };
  };

  return {
    calls,
    raw: db,
    failNext(code) {
      failCode = code;
    },
    close() {
      db.close();
    },
    async exec(sql, params) {
      calls.push({ kind: "exec", statements: [{ sql, params }] });
      const f = takeFail();
      if (f) return f;
      try {
        return execOne(sql, params);
      } catch (e) {
        return { error: mapError(e) };
      }
    },
    async query(sql, params) {
      calls.push({ kind: "query", statements: [{ sql, params }] });
      try {
        checkSql(sql);
        const args = checkParams(params) as never[];
        const rows: Record<string, unknown>[] = [];
        for (const r of db.prepare(sql).iterate(...args)) {
          if (rows.length >= FAKE_LIMITS.rows) return { error: { code: "TOO_MANY_ROWS", message: "more than 10000 rows; page with LIMIT/OFFSET" } };
          rows.push({ ...(r as Record<string, unknown>) });
        }
        return { rows };
      } catch (e) {
        return { error: mapError(e) };
      }
    },
    async transaction(statements) {
      calls.push({ kind: "transaction", statements: Array.isArray(statements) ? statements : [] });
      if (!Array.isArray(statements) || statements.length === 0) return { error: { code: "BAD_REQUEST", message: "statements must be a non-empty array" } };
      if (statements.length > FAKE_LIMITS.statements) return { error: { code: "TOO_LARGE", message: "more than 500 statements" } };
      const f = takeFail();
      if (f) return f;
      const results: { changes: number; lastInsertRowid: number }[] = [];
      let i = 0;
      try {
        runInternal("BEGIN IMMEDIATE");
      } catch (e) {
        return { error: mapError(e) };
      }
      try {
        for (; i < statements.length; i++) results.push(execOne(statements[i]!.sql, statements[i]!.params));
        runInternal("COMMIT");
        return { results };
      } catch (e) {
        try {
          runInternal("ROLLBACK");
        } catch {
          /* nothing open */
        }
        const m = mapError(e);
        return { error: { code: m.code, message: `statement ${i}: ${m.message}` } };
      }
    },
  };
}
