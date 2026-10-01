/**
 * Meeting search for the results panel (GET /api/search) — the pure half:
 * query shaping, the snippet builder and the bold-range finder, shared by
 * the route (server) and the panel (client). No React, no server imports.
 *
 * Semantics: the query splits on whitespace into TERMS; a meeting matches
 * when EVERY term occurs (case-insensitively, as a substring) in at least one
 * of its title, file name, description, AI summary or transcript text — the
 * same five fields the listing's deep search covers. The snippet is cut from
 * the first of description → summary → transcript holding a term, around the
 * earliest one, and every term occurrence in it comes back as a bold range.
 *
 * Offsets everywhere are JS string indices (UTF-16 code units) into the
 * returned text — the renderer slices that same string, so they always line
 * up; the cutter never splits a surrogate pair.
 */

import type { LabelRef } from '@/lib/format';

export const SEARCH_MIN_TERM_LEN = 2;
export const SEARCH_MAX_TERMS = 6;
export const SEARCH_MAX_TERM_LEN = 120;
export const SEARCH_HIT_LIMIT = 30;
/** Target snippet length (chars) and how much context precedes the first match. */
export const SNIPPET_LEN = 140;
export const SNIPPET_LEAD = 40;
/** The SQL window around the first match the snippet is cut from. Wider than
 * the snippet so word boundaries and whitespace collapsing have room. */
export const SQL_WINDOW_BEFORE = 120;
export const SQL_WINDOW_LEN = 400;

/** [start, end) into the text it was computed for. */
export type MatchRange = [number, number];

export type SearchField = 'title' | 'filename' | 'description' | 'notes' | 'content';

export interface SearchSnippet {
  text: string;
  /** Bold ranges into `text`, sorted, non-overlapping. */
  ranges: MatchRange[];
  /** The snippet begins at the field's first character (no leading "…"). */
  atStart: boolean;
  /** The snippet ends at the field's last character (no trailing "…"). */
  atEnd: boolean;
}

/** One panel hit, as GET /api/search serves it. */
export interface MeetingSearchHit {
  /** Route id: /transcript/<id>. */
  id: string;
  title: string | null;
  original_filename: string | null;
  /** When it was held: recorded_at, else created_at. */
  at: string;
  recorded_at: string | null;
  created_at: string;
  /** Seconds. */
  duration: number | null;
  access: 'owner' | 'edit' | 'read';
  /** Null for the caller's own meetings. */
  owner: { email: string; name: string | null } | null;
  labels: LabelRef[];
  /** Fields meetingTitleOf needs for a filename-shaped / missing title. */
  has_event: boolean;
  recorder_recording_id: string | null;
  source: 'uploaded' | 'imported';
  provider: 'gmeet' | 'teams' | null;
  matched_in: SearchField;
  snippet: SearchSnippet | null;
}

export interface MeetingSearchResponse {
  q: string;
  terms: string[];
  hits: MeetingSearchHit[];
}

/** The search a query string asks for, or null when it asks for nothing. */
export interface ShapedSearch {
  /** Terms as typed (NFC), deduped, most specific kept. */
  terms: string[];
  /** One ILIKE pattern per term (% _ \ escaped). */
  patterns: string[];
  /** Lower-cased terms, for strpos() against lower(field). */
  lowered: string[];
}

const EDGE_PUNCT_START = /^["'“”‘’(«[{]+/u;
const EDGE_PUNCT_END = /["'“”‘’)»\]},.;:!?]+$/u;

function codePointLength(s: string): number {
  return Array.from(s).length;
}

/** Cut to `max` code points without splitting a surrogate pair. */
function clipCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

/**
 * Query → terms. Whitespace splits; quotes and edge punctuation are dropped
 * (`"budget,"` → `budget`); NUL bytes (Postgres rejects them) are stripped;
 * terms shorter than SEARCH_MIN_TERM_LEN code points are ignored; duplicates
 * (case-insensitively) collapse; a term contained in another one is dropped
 * (under AND it adds nothing: `rev review` = `review`); at most
 * SEARCH_MAX_TERMS terms of at most SEARCH_MAX_TERM_LEN code points. Pure.
 */
export function searchTermsOf(q: string): string[] {
  const clean = String(q ?? '').replace(/\u0000/g, '').normalize('NFC');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of clean.split(/\s+/u)) {
    const t = clipCodePoints(raw.replace(EDGE_PUNCT_START, '').replace(EDGE_PUNCT_END, ''), SEARCH_MAX_TERM_LEN);
    if (codePointLength(t) < SEARCH_MIN_TERM_LEN) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  const lower = out.map((t) => t.toLowerCase());
  const kept = out.filter((_, i) => !lower.some((o, j) => j !== i && o.length > lower[i]!.length && o.includes(lower[i]!)));
  return kept.slice(0, SEARCH_MAX_TERMS);
}

/** ILIKE pattern for one term: `%term%` with % _ and \ escaped. Pure. */
export function likePatternOf(term: string): string {
  return `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/** The query shaped for SQL, or null when no usable term is left. Pure. */
export function shapeMeetingSearch(q: string): ShapedSearch | null {
  const terms = searchTermsOf(q);
  if (terms.length === 0) return null;
  return { terms, patterns: terms.map(likePatternOf), lowered: terms.map((t) => t.toLowerCase()) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every occurrence of any term in `text`, case-insensitively, as sorted
 * non-overlapping [start, end) ranges (overlapping / touching ones merged).
 * Matching runs on `text` itself (regex `iu`), never on a lower-cased copy,
 * so offsets stay valid even where lower-casing would change a length. Pure.
 */
export function matchRanges(text: string, terms: readonly string[]): MatchRange[] {
  const usable = terms.filter((t) => t.length > 0);
  if (!text || usable.length === 0) return [];
  // One pass per term, so overlapping terms (`abcd` + `cdef`) both count.
  const raw: MatchRange[] = [];
  for (const term of usable) {
    const re = new RegExp(escapeRegExp(term), 'giu');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      raw.push([m.index, m.index + m[0].length]);
    }
  }
  raw.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: MatchRange[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** `text` as plain / bold parts along `ranges` (out-of-range parts clamped). Pure. */
export function splitByRanges(text: string, ranges: readonly MatchRange[]): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [s0, e0] of ranges) {
    const s = Math.max(at, Math.min(s0, text.length));
    const e = Math.max(s, Math.min(e0, text.length));
    if (s > at) out.push({ text: text.slice(at, s), match: false });
    if (e > s) out.push({ text: text.slice(s, e), match: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Nudge an index off the middle of a surrogate pair (forward or back). */
function safeIndex(s: string, i: number, dir: 1 | -1): number {
  if (i <= 0 || i >= s.length) return Math.max(0, Math.min(i, s.length));
  return isLowSurrogate(s.charCodeAt(i)) ? i + dir : i;
}

/**
 * Cut a ~SNIPPET_LEN-char snippet out of `window` (a slice of a field, as the
 * SQL returns it) around the first term match: SNIPPET_LEAD chars of context
 * before it, whitespace collapsed, both edges moved to a word boundary when
 * one is near (else a hard, surrogate-safe cut — CJK text has no spaces).
 * `windowAtStart` / `windowAtEnd` say whether the window itself touches the
 * field's start / end; the result's atStart / atEnd say the same of the
 * snippet (the renderer draws "…" where they are false). Bold ranges are
 * computed on the final text. Pure.
 */
export function buildSnippet(
  window: string,
  terms: readonly string[],
  opts: { windowAtStart: boolean; windowAtEnd: boolean; len?: number; lead?: number }
): SearchSnippet {
  const len = opts.len ?? SNIPPET_LEN;
  const lead = opts.lead ?? SNIPPET_LEAD;
  // Collapse whitespace first (transcripts are full of newlines); a leading
  // run only matters when the window is the field's start.
  let norm = window.replace(/\s+/gu, ' ');
  const windowAtStart = opts.windowAtStart;
  if (windowAtStart) norm = norm.replace(/^ /, '');
  const windowAtEnd = opts.windowAtEnd;
  if (windowAtEnd) norm = norm.replace(/ $/, '');

  const first = matchRanges(norm, terms)[0] ?? null;
  const matchStart = first ? first[0] : 0;
  const matchEnd = first ? first[1] : 0;

  let start = Math.max(0, matchStart - lead);
  if (start > 0) {
    // Begin after the first space at/after `start` that precedes the match.
    const sp = norm.indexOf(' ', start);
    if (sp >= 0 && sp < matchStart) start = sp + 1;
    else start = safeIndex(norm, start, 1);
  } else if (!windowAtStart) {
    // The window itself starts mid-field: drop the partial first word when a
    // space precedes the match.
    const sp = norm.indexOf(' ');
    if (sp >= 0 && sp < matchStart) start = sp + 1;
  }

  let end = Math.min(norm.length, Math.max(start + len, matchEnd));
  if (end < norm.length) {
    // End at the last space inside the budget that still keeps the match.
    const sp = norm.lastIndexOf(' ', end);
    if (sp > matchEnd && sp > start) end = sp;
    else end = safeIndex(norm, end, -1);
  }

  const text = norm.slice(start, end).replace(/^ +| +$/g, '');
  return {
    text,
    ranges: matchRanges(text, terms),
    atStart: windowAtStart && start === 0,
    atEnd: windowAtEnd && end >= norm.length,
  };
}

/** The raw row GET /api/search's query returns (db-ops/meeting-search.ts). */
export interface MeetingSearchRawRow {
  id: string;
  user_id: string;
  title: string | null;
  original_filename: string | null;
  recorded_at: string | Date | null;
  created_at: string | Date;
  duration: number | string | null;
  access: 'owner' | 'edit' | 'read' | null;
  labels: LabelRef[] | null;
  has_event: boolean | null;
  recorder_recording_id: string | null;
  source: 'uploaded' | 'imported' | null;
  provider: 'gmeet' | 'teams' | null;
  /** The body field the window was cut from, or null (title/filename-only hit). */
  snip_field: 'description' | 'notes' | 'content' | null;
  snip_window: string | null;
  snip_window_start: number | null;
  snip_at_end: boolean | null;
}

function iso(v: string | Date | null): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Raw SQL row → panel hit: the snippet built from the window, `matched_in`
 * = the snippet's field, else title / filename by which one holds a term.
 * A filename-only hit gets the filename as its snippet so the bold match is
 * visible (the row's title never shows a filename). Pure.
 */
export function hitFromRow(
  row: MeetingSearchRawRow,
  terms: readonly string[],
  owner: { email: string; name: string | null } | null
): MeetingSearchHit {
  let matched_in: SearchField;
  let snippet: SearchSnippet | null = null;
  if (row.snip_field && row.snip_window !== null) {
    matched_in = row.snip_field;
    snippet = buildSnippet(row.snip_window, terms, {
      windowAtStart: (row.snip_window_start ?? 1) <= 1,
      windowAtEnd: row.snip_at_end === true,
    });
  } else if (row.title && matchRanges(row.title, terms).length > 0) {
    matched_in = 'title';
  } else if (row.original_filename && matchRanges(row.original_filename, terms).length > 0) {
    matched_in = 'filename';
    const text = row.original_filename;
    snippet = { text, ranges: matchRanges(text, terms), atStart: true, atEnd: true };
  } else {
    matched_in = 'title';
  }
  const created = iso(row.created_at) ?? '';
  const recorded = iso(row.recorded_at);
  const dur = row.duration === null || row.duration === undefined ? null : Number(row.duration);
  return {
    id: row.id,
    title: row.title,
    original_filename: row.original_filename,
    at: recorded ?? created,
    recorded_at: recorded,
    created_at: created,
    duration: dur !== null && Number.isFinite(dur) ? dur : null,
    access: row.access ?? 'read',
    owner: row.access === 'owner' ? null : owner,
    labels: row.labels ?? [],
    has_event: row.has_event === true,
    recorder_recording_id: row.recorder_recording_id,
    source: row.source ?? 'uploaded',
    provider: row.provider,
    matched_in,
    snippet,
  };
}

/** Short words for where a hit matched, for the row's meta line. */
export const MATCHED_IN_LABEL: Record<SearchField, string> = {
  title: 'title',
  filename: 'file name',
  description: 'description',
  notes: 'AI notes',
  content: 'transcript',
};
