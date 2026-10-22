/**
 * The Meetings desktop replica — what is kept, in what shape, and how it is
 * read back offline. Text only (v1): the listing the person sees, and for
 * opened / synced meetings the transcript as speaker-named turns, the AI
 * notes + report and the page's metadata. No audio, no video, no frames.
 * (README "Offline in the Darth desktop shell".)
 *
 * Shape decisions (plans/offline/meetings-offline-design.md §0: transcript
 * JSON averages 0.9 MB, max 8.7 MB — mostly the per-word timing array):
 *  - the raw AssemblyAI JSON is NEVER stored; a meeting becomes compact turns
 *    `[speakerName, startMs, text]` with speaker names and text edits applied
 *    the way the page shows them (≈ 5–10 % of the JSON);
 *  - every doc carries a byte estimate; the newest meetings win, the oldest
 *    are evicted beyond DOC_BUDGET_BYTES, and a QUOTA answer from the shell
 *    evicts and retries (the 50 MB cap is the shell's, not ours).
 *
 * Statement builders and the compaction are pure (tested with a fake bridge
 * in __tests__/offline-replica.test.ts); reads take a ReplicaDb.
 */

import type {
  LabelRef,
  SpeakerLabel,
  StoredTranscript,
  TranscriptAccess,
  TranscriptEditMap,
  TranscriptListRow,
  TranscriptResponse,
  TranscriptSegment,
} from '@/lib/format';
import { defaultSpeakerLabel } from '@/lib/speaker-display';
import {
  SEARCH_HIT_LIMIT,
  hitFromRow,
  searchTermsOf,
  type MeetingSearchHit,
} from '@/lib/meeting-search';
import type { ReplicaDb, SqlParam, StoreStatement, TxResult } from './replica-db';

/** How many listing rows (newest first) the replica keeps. */
export const LISTING_KEEP = 100;
/** Estimated bytes all docs may take together (the shell caps the file at
 * 50 MB; FTS index + listing + SQLite overhead live in the rest). */
export const DOC_BUDGET_BYTES = 30 * 1024 * 1024;
/** One meeting's turns beyond this estimate are cut (the notes stay). */
export const DOC_MAX_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shapes

/** [speaker display name, start ms, text] */
export type ReplicaTurn = [string, number, string];

export interface ReplicaMeta {
  id: string;
  title: string | null;
  description: string | null;
  original_filename: string | null;
  status: string;
  recorded_at: string | null;
  created_at: string;
  completed_at: string | null;
  /** Seconds. */
  duration: number | null;
  language_code: string | null;
  source: 'uploaded' | 'imported';
  provider: 'gmeet' | 'teams' | null;
  access: TranscriptAccess;
  owner_email: string | null;
  owner_name: string | null;
  event_title: string | null;
  organizer: string | null;
  attendees: { email: string; name: string | null }[];
  /** Display names in order of first appearance. */
  speakers: string[];
  segments: TranscriptSegment[];
  labels: LabelRef[];
  auto_notes_at: string | null;
  auto_report_at: string | null;
  has_event: boolean;
  recorder_recording_id: string | null;
  /** Turns were cut to fit DOC_MAX_BYTES. */
  truncated?: boolean;
}

export interface ReplicaDoc {
  meta: ReplicaMeta;
  notes: string | null;
  report: string | null;
  turns: ReplicaTurn[];
}

export interface StoredReplicaDoc extends ReplicaDoc {
  savedAt: number;
  rev: string | null;
}

/** What the page has after `loadAll` (or a background fetch got from the same routes). */
export interface MeetingSources {
  row: StoredTranscript & {
    access?: TranscriptAccess;
    owner_email?: string | null;
    owner_name?: string | null;
  };
  speakerLabels?: SpeakerLabel[] | null;
  edits?: TranscriptEditMap | null;
  content?: TranscriptResponse | null;
  labels?: LabelRef[] | null;
}

// ---------------------------------------------------------------------------
// Compaction (pure)

/** When the meeting was held: recorded_at, else created_at. */
export function meetingAt(r: { recorded_at?: string | null; created_at: string }): string {
  return r.recorded_at || r.created_at;
}

/** The page's text for one utterance: the edit wins over the raw text. */
function textOf(edits: TranscriptEditMap | null | undefined, index: number, raw: string): string {
  const e = edits?.[String(index)];
  return typeof e?.text === 'string' ? e.text : raw;
}

/** Turns as the page shows them (custom speaker names, edited text). Pure. */
export function turnsOf(
  content: TranscriptResponse | null | undefined,
  speakerLabels: SpeakerLabel[] | null | undefined,
  edits: TranscriptEditMap | null | undefined
): ReplicaTurn[] {
  if (!content) return [];
  const names = new Map<string, string>();
  for (const l of speakerLabels ?? []) {
    const n = l.customName?.trim();
    if (n) names.set(l.originalSpeaker, n);
  }
  const utts = content.utterances ?? [];
  if (utts.length > 0) {
    return utts.map((u, i) => [
      names.get(u.speaker) ?? defaultSpeakerLabel(u.speaker),
      Number.isFinite(u.start) ? u.start : 0,
      textOf(edits, i, u.text ?? ''),
    ]);
  }
  const text = (content.text ?? '').trim();
  return text ? [['', 0, text]] : [];
}

function utf8Bytes(s: string | null | undefined): number {
  if (!s) return 0;
  // TextEncoder is in every runtime this code meets (browser, Bun).
  return new TextEncoder().encode(s).length;
}

/** The plain text the search index holds for a doc's transcript. Pure. */
export function plainTextOf(turns: readonly ReplicaTurn[]): string {
  return turns.map(([s, , x]) => (s ? `${s}: ${x}` : x)).join('\n');
}

/** Estimated stored bytes of a doc: its columns + the indexed copy of the
 * text (the FTS table holds title/notes/content once more, plus the index). */
export function docBytes(doc: ReplicaDoc): number {
  const turnsJson = JSON.stringify(doc.turns);
  const metaJson = JSON.stringify(doc.meta);
  const notes = utf8Bytes(doc.notes) + utf8Bytes(doc.report);
  return utf8Bytes(turnsJson) + utf8Bytes(metaJson) + notes * 2 + utf8Bytes(plainTextOf(doc.turns)) * 2;
}

/** Cut the turns (from the end) until the doc fits `max`. Pure. */
export function fitDoc(doc: ReplicaDoc, max: number = DOC_MAX_BYTES): ReplicaDoc {
  if (docBytes(doc) <= max) return doc;
  let lo = 0;
  let hi = doc.turns.length;
  // Binary search the longest prefix that fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (docBytes({ ...doc, turns: doc.turns.slice(0, mid) }) <= max) lo = mid;
    else hi = mid - 1;
  }
  return { ...doc, turns: doc.turns.slice(0, lo), meta: { ...doc.meta, truncated: true } };
}

/** The page's sources → the compact doc. Pure. */
export function compactMeeting(src: MeetingSources): ReplicaDoc {
  const r = src.row;
  const ctx = r.gmeet_context ?? null;
  const turns = turnsOf(src.content, src.speakerLabels, src.edits);
  const speakers: string[] = [];
  for (const [s] of turns) if (s && !speakers.includes(s)) speakers.push(s);
  const attendees = (ctx?.attendees ?? [])
    .filter((a) => a && typeof a.email === 'string')
    .map((a) => ({ email: a.email, name: a.name ?? null }));
  const meta: ReplicaMeta = {
    id: r.assemblyai_id,
    title: r.title,
    description: r.description,
    original_filename: r.original_filename,
    status: r.status,
    recorded_at: r.recorded_at,
    created_at: r.created_at,
    completed_at: r.completed_at,
    duration: r.duration,
    language_code: r.language_code,
    source: r.source,
    provider: ctx?.provider ?? null,
    access: r.access ?? 'owner',
    owner_email: r.owner_email ?? null,
    owner_name: r.owner_name ?? null,
    event_title: ctx?.eventTitle ?? null,
    organizer: ctx?.organizerEmail ?? null,
    attendees,
    speakers,
    segments: Array.isArray(r.auto_segments) ? r.auto_segments : [],
    labels: src.labels ?? [],
    auto_notes_at: r.auto_notes_at,
    auto_report_at: r.auto_report_at,
    has_event: !!ctx?.eventId,
    recorder_recording_id: ctx?.recorder?.recordingId ?? null,
  };
  return fitDoc({ meta, notes: r.auto_notes || null, report: r.auto_report || null, turns });
}

/** A listing row as stored: the search-only fields dropped. Pure. */
export function storableListRow(row: TranscriptListRow): TranscriptListRow {
  const { snippet: _s, matched_in: _m, ...rest } = row;
  void _s;
  void _m;
  return rest as TranscriptListRow;
}

// ---------------------------------------------------------------------------
// Statements (pure)

function searchTable(fts: boolean): string {
  return fts ? 'search' : 'search_lite';
}

/** Replace the listing: these rows (newest first, ≤ LISTING_KEEP) get ranks
 * 0..n-1; rows that fell out lose their rank and go unless a doc keeps them.
 * Listing-only meetings get a title/description search row. Pure. */
export function listingStatements(rows: readonly TranscriptListRow[], fts: boolean, now: number): StoreStatement[] {
  const t = searchTable(fts);
  const kept = rows.slice(0, LISTING_KEEP);
  const out: StoreStatement[] = [{ sql: 'UPDATE meetings SET list_rank = NULL WHERE list_rank IS NOT NULL' }];
  kept.forEach((row, i) => {
    const id = row.assemblyai_id;
    out.push({
      sql:
        'INSERT INTO meetings (id, at, list_rank, row_json, listed_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET at = excluded.at, list_rank = excluded.list_rank, row_json = excluded.row_json, listed_at = excluded.listed_at',
      params: [id, meetingAt(row), i, JSON.stringify(storableListRow(row)), now],
    });
    // A doc's search row is richer: leave it. Otherwise (re)write the title row.
    out.push({ sql: `DELETE FROM ${t} WHERE id = ? AND NOT EXISTS (SELECT 1 FROM docs WHERE docs.id = ?)`, params: [id, id] });
    out.push({
      sql: `INSERT INTO ${t} (id, at, title, description, notes, content) SELECT ?, ?, ?, ?, '', '' WHERE NOT EXISTS (SELECT 1 FROM docs WHERE docs.id = ?)`,
      params: [id, meetingAt(row), row.title ?? row.original_filename ?? '', row.description ?? '', id],
    });
  });
  // Fallen out of the listing and no doc keeps them: gone (with their search row).
  out.push({
    sql: `DELETE FROM ${t} WHERE id IN (SELECT id FROM meetings WHERE list_rank IS NULL AND id NOT IN (SELECT id FROM docs))`,
  });
  out.push({ sql: 'DELETE FROM meetings WHERE list_rank IS NULL AND id NOT IN (SELECT id FROM docs)' });
  out.push(metaSet('listing_saved_at', String(now)));
  return out;
}

export function metaSet(k: string, v: string): StoreStatement {
  return { sql: 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', params: [k, v] };
}

/** Write one doc (and its search row). Pure. */
export function docStatements(doc: ReplicaDoc, rev: string | null, fts: boolean, now: number): StoreStatement[] {
  const t = searchTable(fts);
  const id = doc.meta.id;
  const at = meetingAt(doc.meta);
  return [
    {
      sql:
        'INSERT INTO docs (id, at, rev, saved_at, bytes, meta_json, notes, report, turns_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET at = excluded.at, rev = excluded.rev, saved_at = excluded.saved_at, bytes = excluded.bytes, ' +
        'meta_json = excluded.meta_json, notes = excluded.notes, report = excluded.report, turns_json = excluded.turns_json',
      params: [id, at, rev, now, docBytes(doc), JSON.stringify(doc.meta), doc.notes, doc.report, JSON.stringify(doc.turns)],
    },
    { sql: `DELETE FROM ${t} WHERE id = ?`, params: [id] },
    {
      sql: `INSERT INTO ${t} (id, at, title, description, notes, content) VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        at,
        doc.meta.title ?? doc.meta.original_filename ?? '',
        doc.meta.description ?? '',
        [doc.notes, doc.report].filter(Boolean).join('\n\n'),
        plainTextOf(doc.turns),
      ],
    },
  ];
}

/** Drop these docs; a meeting still in the listing keeps a title search row. Pure. */
export function evictStatements(ids: readonly string[], fts: boolean): StoreStatement[] {
  const t = searchTable(fts);
  const out: StoreStatement[] = [];
  for (const id of ids) {
    out.push({ sql: 'DELETE FROM docs WHERE id = ?', params: [id] });
    out.push({ sql: `DELETE FROM ${t} WHERE id = ?`, params: [id] });
    out.push({
      sql:
        `INSERT INTO ${t} (id, at, title, description, notes, content) ` +
        "SELECT id, at, COALESCE(json_extract(row_json, '$.title'), json_extract(row_json, '$.original_filename'), ''), " +
        "COALESCE(json_extract(row_json, '$.description'), ''), '', '' FROM meetings WHERE id = ?",
      params: [id],
    });
    out.push({ sql: 'DELETE FROM meetings WHERE id = ? AND list_rank IS NULL', params: [id] });
  }
  return out;
}

/**
 * Which docs to evict so the total fits `budget` (+ `incoming` bytes about to
 * be written): the OLDEST meetings first, never `keepId`. Pure.
 */
export function pickEvictions(
  docs: readonly { id: string; at: string; bytes: number }[],
  budget: number,
  incoming = 0,
  keepId: string | null = null
): string[] {
  let total = incoming + docs.reduce((n, d) => n + (Number(d.bytes) || 0), 0);
  if (total <= budget) return [];
  const oldestFirst = [...docs].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const out: string[] = [];
  for (const d of oldestFirst) {
    if (total <= budget) break;
    if (d.id === keepId) continue;
    out.push(d.id);
    total -= Number(d.bytes) || 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes (through a ReplicaDb)

async function docSizes(db: ReplicaDb): Promise<{ id: string; at: string; bytes: number }[] | null> {
  return db.query<{ id: string; at: string; bytes: number }>('SELECT id, at, bytes FROM docs');
}

/** Save the listing (newest first). Resolves whether it landed. */
export async function saveListing(db: ReplicaDb, rows: readonly TranscriptListRow[], now = Date.now()): Promise<boolean> {
  if (db.owner === null) return false;
  const r = await db.tx(listingStatements(rows, db.fts, now));
  if (r.ok || r.code !== 'QUOTA') return r.ok;
  // Full: make room from the oldest docs, once.
  const sizes = await docSizes(db);
  const evict = sizes ? pickEvictions(sizes, 0).slice(0, Math.max(1, Math.ceil(sizes.length / 4))) : [];
  if (evict.length === 0) return false;
  await db.tx(evictStatements(evict, db.fts));
  return (await db.tx(listingStatements(rows, db.fts, now))).ok;
}

/**
 * Save one meeting: evict the oldest docs beyond the budget first, then
 * write; on QUOTA evict a quarter of the rest (oldest first, never this one)
 * and retry; still full → keep the notes and drop the turns. Resolves the
 * outcome code ('ok', 'QUOTA', or the store's error code).
 */
export async function saveDoc(
  db: ReplicaDb,
  doc: ReplicaDoc,
  rev: string | null,
  opts: { now?: number; budget?: number } = {}
): Promise<'ok' | string> {
  if (db.owner === null) return 'NO_OWNER';
  const now = opts.now ?? Date.now();
  const budget = opts.budget ?? DOC_BUDGET_BYTES;
  const id = doc.meta.id;
  const sizes = (await docSizes(db)) ?? [];
  const others = sizes.filter((d) => d.id !== id);
  const pre = pickEvictions(others, budget, docBytes(doc));
  if (pre.length) await db.tx(evictStatements(pre, db.fts));

  let r: TxResult = await db.tx(docStatements(doc, rev, db.fts, now));
  if (r.ok) return 'ok';
  if (r.code !== 'QUOTA') return r.code;
  const left = others.filter((d) => !pre.includes(d.id));
  const more = pickEvictions(left, 0, 0, id).slice(0, Math.max(1, Math.ceil(left.length / 4)));
  if (more.length) {
    await db.tx(evictStatements(more, db.fts));
    r = await db.tx(docStatements(doc, rev, db.fts, now));
    if (r.ok) return 'ok';
    if (r.code !== 'QUOTA') return r.code;
  }
  const notesOnly: ReplicaDoc = { ...doc, turns: [], meta: { ...doc.meta, truncated: true } };
  r = await db.tx(docStatements(notesOnly, rev, db.fts, now));
  return r.ok ? 'ok' : r.code;
}

/** Stored revs by meeting id (the background sync compares them with the plan's). */
export async function storedRevs(db: ReplicaDb): Promise<Map<string, string | null>> {
  const rows = (await db.query<{ id: string; rev: string | null }>('SELECT id, rev FROM docs')) ?? [];
  return new Map(rows.map((r) => [r.id, r.rev ?? null]));
}

export async function setDocRev(db: ReplicaDb, id: string, rev: string): Promise<void> {
  if (db.owner === null) return;
  await db.tx([{ sql: 'UPDATE docs SET rev = ? WHERE id = ?', params: [rev, id] }]);
}

// ---------------------------------------------------------------------------
// Reads

export interface StoredListing {
  rows: TranscriptListRow[];
  /** Ids with a stored doc (openable offline). */
  saved: Set<string>;
  /** When the listing was last written (ms), or null. */
  savedAt: number | null;
}

function parseJson<T>(s: unknown): T | null {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export async function readListing(db: ReplicaDb): Promise<StoredListing | null> {
  const rows = await db.query<{ row_json: string }>(
    'SELECT row_json FROM meetings WHERE list_rank IS NOT NULL ORDER BY list_rank LIMIT ?',
    [LISTING_KEEP]
  );
  if (!rows) return null;
  const docs = (await db.query<{ id: string }>('SELECT id FROM docs')) ?? [];
  const at = await db.query<{ v: string }>('SELECT v FROM meta WHERE k = ?', ['listing_saved_at']);
  const savedAt = at?.[0]?.v ? Number(at[0].v) : null;
  return {
    rows: rows.map((r) => parseJson<TranscriptListRow>(r.row_json)).filter((r): r is TranscriptListRow => !!r),
    saved: new Set(docs.map((d) => d.id)),
    savedAt: savedAt !== null && Number.isFinite(savedAt) ? savedAt : null,
  };
}

export async function readDoc(db: ReplicaDb, id: string): Promise<StoredReplicaDoc | null> {
  const rows = await db.query<{
    meta_json: string;
    notes: string | null;
    report: string | null;
    turns_json: string;
    saved_at: number;
    rev: string | null;
  }>('SELECT meta_json, notes, report, turns_json, saved_at, rev FROM docs WHERE id = ?', [id]);
  const r = rows?.[0];
  if (!r) return null;
  const meta = parseJson<ReplicaMeta>(r.meta_json);
  if (!meta) return null;
  return {
    meta,
    notes: r.notes ?? null,
    report: r.report ?? null,
    turns: parseJson<ReplicaTurn[]>(r.turns_json) ?? [],
    savedAt: Number(r.saved_at) || 0,
    rev: r.rev ?? null,
  };
}

/** A listing row for one meeting (the reader's fallback when no doc is stored). */
export async function readListRow(db: ReplicaDb, id: string): Promise<TranscriptListRow | null> {
  const rows = await db.query<{ row_json: string }>('SELECT row_json FROM meetings WHERE id = ?', [id]);
  return parseJson<TranscriptListRow>(rows?.[0]?.row_json);
}

// ---------------------------------------------------------------------------
// Search

/** Terms → an FTS5 MATCH expression: each term a quoted prefix, all ANDed. Pure. */
export function ftsQueryOf(terms: readonly string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

/** LIKE pattern for a term (% _ \ escaped; ESCAPE '\'). Pure. */
function likeOf(term: string): string {
  return `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

const WIN_BEFORE = 120;
const WIN_LEN = 400;

/** The SQL that answers a local search: one row per meeting with the windows
 * the snippet is cut from (description → notes → content, first-term match). */
export function searchSql(terms: readonly string[], fts: boolean): { sql: string; params: SqlParam[] } {
  const first = terms[0]!.toLowerCase();
  const win = (col: string) =>
    `instr(lower(${col}), ?) AS ${col}_pos, ` +
    `CASE WHEN instr(lower(${col}), ?) > 0 THEN substr(${col}, max(1, instr(lower(${col}), ?) - ${WIN_BEFORE}), ${WIN_LEN}) END AS ${col}_win, ` +
    `length(${col}) AS ${col}_len`;
  const cols = `id, at, title, ${win('description')}, ${win('notes')}, ${win('content')}`;
  const winParams: SqlParam[] = [first, first, first, first, first, first, first, first, first];
  if (fts) {
    return {
      sql: `SELECT ${cols} FROM search WHERE search MATCH ? ORDER BY at DESC LIMIT ?`,
      params: [...winParams, ftsQueryOf(terms), SEARCH_HIT_LIMIT],
    };
  }
  const where = terms
    .map(
      () =>
        "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')"
    )
    .join(' AND ');
  const likeParams = terms.flatMap((t) => {
    const p = likeOf(t);
    return [p, p, p, p];
  });
  return {
    sql: `SELECT ${cols} FROM search_lite WHERE ${where} ORDER BY at DESC LIMIT ?`,
    params: [...winParams, ...likeParams, SEARCH_HIT_LIMIT],
  };
}

type SearchRow = {
  id: string;
  at: string;
  title: string | null;
} & Record<`${'description' | 'notes' | 'content'}_${'pos' | 'win' | 'len'}`, number | string | null>;

export interface LocalSearchResult {
  terms: string[];
  hits: MeetingSearchHit[];
  /** Ids whose full text is stored (a hit without it can only show its title). */
  saved: Set<string>;
}

/**
 * Search the replica: the panel's semantics (every term, in title /
 * description / AI notes / transcript), answered from FTS5 (token-prefix
 * match) or LIKE on an older shell. Hits are shaped like GET /api/search's
 * so the panel renders them unchanged. Null on a store failure.
 */
export async function searchReplica(db: ReplicaDb, q: string): Promise<LocalSearchResult | null> {
  const terms = searchTermsOf(q);
  if (terms.length === 0) return { terms, hits: [], saved: new Set() };
  const { sql, params } = searchSql(terms, db.fts);
  const rows = await db.query<SearchRow>(sql, params);
  if (!rows) return null;
  if (rows.length === 0) return { terms, hits: [], saved: new Set() };
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(', ');
  const listRows =
    (await db.query<{ id: string; row_json: string }>(`SELECT id, row_json FROM meetings WHERE id IN (${marks})`, ids)) ?? [];
  const docRows =
    (await db.query<{ id: string; meta_json: string }>(`SELECT id, meta_json FROM docs WHERE id IN (${marks})`, ids)) ?? [];
  const lists = new Map(listRows.map((r) => [r.id, parseJson<TranscriptListRow>(r.row_json)]));
  const metas = new Map(docRows.map((r) => [r.id, parseJson<ReplicaMeta>(r.meta_json)]));
  const hits: MeetingSearchHit[] = [];
  for (const r of rows) {
    const l = lists.get(r.id) ?? null;
    const m = metas.get(r.id) ?? null;
    const field = (['description', 'notes', 'content'] as const).find((f) => Number(r[`${f}_pos`]) > 0) ?? null;
    const pos = field ? Number(r[`${field}_pos`]) : null;
    const len = field ? Number(r[`${field}_len`]) : null;
    const winStart = pos !== null ? Math.max(1, pos - WIN_BEFORE) : null;
    hits.push(
      hitFromRow(
        {
          id: r.id,
          user_id: l?.user_id ?? '',
          title: m?.title ?? l?.title ?? null,
          original_filename: m?.original_filename ?? l?.original_filename ?? null,
          recorded_at: m?.recorded_at ?? l?.recorded_at ?? null,
          created_at: m?.created_at ?? l?.created_at ?? r.at,
          duration: m?.duration ?? l?.duration ?? null,
          access: m?.access ?? l?.access ?? null,
          labels: m?.labels?.length ? m.labels : (l?.labels ?? []),
          has_event: m?.has_event ?? l?.has_event ?? false,
          recorder_recording_id: m?.recorder_recording_id ?? l?.recorder_recording_id ?? null,
          source: m?.source ?? l?.source ?? null,
          provider: m?.provider ?? l?.provider ?? null,
          snip_field: field,
          snip_window: field ? String(r[`${field}_win`] ?? '') : null,
          snip_window_start: winStart,
          snip_at_end: winStart !== null && len !== null ? winStart - 1 + WIN_LEN >= len : null,
        },
        terms,
        (m?.owner_email ?? l?.owner_email)
          ? { email: (m?.owner_email ?? l?.owner_email)!, name: m?.owner_name ?? l?.owner_name ?? null }
          : null
      )
    );
  }
  return { terms, hits, saved: new Set(docRows.map((d) => d.id)) };
}
