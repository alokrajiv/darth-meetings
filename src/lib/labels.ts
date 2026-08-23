/**
 * Labels — pure, shared client/server helpers (docs/labels-design.md §2).
 *
 * Org-wide hierarchical labels, many-to-many with transcripts. A label has a
 * display `path` ('Customers/LP Global/Weekly catch-up') and a case-folded
 * `path_key` (lower(path)). Everything here is side-effect free and safe to
 * import from React components, API routes, db-ops and the darth-cli
 * subcommand. DB access lives in src/db-ops/labels.ts, NOT here.
 *
 * Invariants the DB CHECKs enforce and these helpers mirror:
 *  - segment: 1..MAX_SEGMENT chars after trim, no '/', no leading/trailing
 *    whitespace (we trim on input, so stored names never have it)
 *  - depth: 1..MAX_DEPTH (depth = number of segments)
 *  - uniqueness: per parent, case-insensitive on `name_key` = lower(trim(name))
 */

export const MAX_DEPTH = 6;
export const MAX_SEGMENT = 60;
export const PATH_SEP = '/';
/** `?label=none` → "Unlabelled" pseudo-filter. */
export const LABEL_FILTER_NONE = 'none';

/** Minimal label reference carried on listing rows / chips. */
export interface LabelRef {
  id: number;
  name: string;
  path: string;
  color: string | null;
}

/** Flat row as returned by GET /api/labels (sorted by path_key). */
export interface LabelRow extends LabelRef {
  parent_id: number | null;
  depth: number;
  path_key: string;
  description: string | null;
  created_by_email: string;
  /** Present with ?counts=1: transcripts visible to the caller carrying this
   * label OR any descendant (subtree-inclusive). */
  count_visible?: number;
  /** Present with ?counts=1: visible transcripts carrying exactly this label. */
  count_direct?: number;
}

/** Tree node produced by buildTree — the row itself plus nested children. */
export type LabelNode<T extends TreeInput = LabelRow> = T & { children: LabelNode<T>[] };

/** What buildTree needs from a row. */
export interface TreeInput {
  id: number;
  parent_id: number | null;
  path_key: string;
}

/** Result shape of the validators. */
export type LabelValidation<T> = { ok: true; value: T } | { ok: false; error: string };

/** Thrown by the assert* helpers; routes map it to 400. */
export class LabelPathError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = 'LabelPathError';
  }
}

/** `lower(trim(s))` — the DB's `name_key` / `path_key` folding. */
export function normalizeKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Split a user-typed path into trimmed, non-empty segments. No validation
 * beyond dropping empties: 'a / b//c ' → ['a','b','c']; '/' → []; '' → [].
 * Use validatePath/assertPath when you need the segments to be legal.
 */
export function splitPath(input: string): string[] {
  if (typeof input !== 'string') return [];
  return input
    .split(PATH_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Join segments into a display path (segments are trimmed; empties dropped). */
export function joinPath(segments: readonly string[]): string {
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(PATH_SEP);
}

/** `path_key` for a display path or a segment list: lower(trim(seg)) joined by '/'. */
export function pathKeyOf(pathOrSegments: string | readonly string[]): string {
  const segs = typeof pathOrSegments === 'string' ? splitPath(pathOrSegments) : pathOrSegments;
  return joinPath(segs).toLowerCase();
}

/** Last segment of a path ('' for an empty path). */
export function leafName(path: string): string {
  const segs = splitPath(path);
  return segs.length ? segs[segs.length - 1] : '';
}

/** Parent path ('' when top-level or empty). */
export function parentPath(path: string): string {
  return joinPath(splitPath(path).slice(0, -1));
}

/** Ancestor paths from the root down, excluding the path itself:
 * 'a/b/c' → ['a','a/b']. */
export function ancestorPaths(path: string): string[] {
  const segs = splitPath(path);
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(joinPath(segs.slice(0, i)));
  return out;
}

/**
 * Validate one label segment (a `name`). Returns the trimmed name on success.
 * Rules: 1..MAX_SEGMENT chars after trim, no '/'. Leading/trailing whitespace
 * is trimmed rather than rejected (the DB stores the trimmed form).
 */
export function validateSegment(raw: string): LabelValidation<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'Label name must be a string' };
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'Label name cannot be empty' };
  if (name.includes(PATH_SEP)) return { ok: false, error: "Label name cannot contain '/'" };
  // Length in code points (DB length() counts characters, not UTF-16 units).
  if ([...name].length > MAX_SEGMENT) {
    return { ok: false, error: `Label name is longer than ${MAX_SEGMENT} characters` };
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return { ok: false, error: 'Label name cannot contain control characters' };
  }
  return { ok: true, value: name };
}

/** Like validateSegment but throws LabelPathError. Returns the trimmed name. */
export function assertSegment(raw: string): string {
  const v = validateSegment(raw);
  if (!v.ok) throw new LabelPathError(v.error);
  return v.value;
}

/**
 * Validate a full path. Returns the cleaned segments. Rejects empty / '/'-only
 * paths, depth > MAX_DEPTH (optionally offset by `baseDepth` — the depth of
 * the parent the path will hang under), and any invalid segment.
 */
export function validatePath(raw: string, baseDepth = 0): LabelValidation<string[]> {
  const segs = splitPath(raw);
  if (segs.length === 0) return { ok: false, error: 'Label path cannot be empty' };
  if (baseDepth + segs.length > MAX_DEPTH) {
    return { ok: false, error: `Label path is deeper than ${MAX_DEPTH} levels` };
  }
  const cleaned: string[] = [];
  for (const s of segs) {
    const v = validateSegment(s);
    if (!v.ok) return { ok: false, error: `${v.error} (segment '${s}')` };
    cleaned.push(v.value);
  }
  return { ok: true, value: cleaned };
}

/** Like validatePath but throws LabelPathError. Returns the cleaned segments. */
export function assertPath(raw: string, baseDepth = 0): string[] {
  const v = validatePath(raw, baseDepth);
  if (!v.ok) throw new LabelPathError(v.error);
  return v.value;
}

/** '#rrggbb' (case-insensitive) or null. Mirrors the DB CHECK. */
export function validateColor(raw: unknown): LabelValidation<string | null> {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Color must be a string' };
  const c = raw.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return { ok: false, error: "Color must be '#rrggbb'" };
  return { ok: true, value: c.toLowerCase() };
}

/**
 * Subtree membership on path_keys. `exact=true` → only the node itself.
 * Otherwise the node OR any descendant (`ancestor + '/'` prefix). Both inputs
 * are case-folded defensively, so display paths work too.
 */
export function matchesSubtree(pathKey: string, ancestorPathKey: string, exact = false): boolean {
  const a = pathKeyOf(ancestorPathKey);
  const p = pathKeyOf(pathKey);
  if (a.length === 0) return false;
  if (p === a) return true;
  if (exact) return false;
  return p.startsWith(a + PATH_SEP);
}

/** Row shape rewritePaths needs. */
export interface RewriteInput {
  id: number;
  path: string;
}

/** One rewritten row (what the UPDATE loop in db-ops/labels.ts writes). */
export interface RewrittenPath {
  id: number;
  path: string;
  path_key: string;
  depth: number;
}

/**
 * Pure subtree rewrite for rename/move: every row whose path IS `oldPrefix`
 * or lies under it (case-insensitive) gets `oldPrefix` swapped for
 * `newPrefix`; everything else is dropped from the result. Returns the new
 * path / path_key / depth per affected row. Throws LabelPathError when any
 * resulting depth exceeds MAX_DEPTH (the caller runs this before UPDATE, in
 * the txn, so the reject is a clean 409/400 with nothing written).
 *
 * Example: rewritePaths('A/B', 'A/Bee', [{id:2,path:'A/B'},{id:3,path:'A/B/C'}])
 *   → [{id:2,path:'A/Bee',path_key:'a/bee',depth:2},
 *      {id:3,path:'A/Bee/C',path_key:'a/bee/c',depth:3}]
 */
export function rewritePaths<T extends RewriteInput>(
  oldPrefix: string,
  newPrefix: string,
  rows: readonly T[],
): RewrittenPath[] {
  const oldKey = pathKeyOf(oldPrefix);
  const newSegs = splitPath(newPrefix);
  if (oldKey.length === 0) throw new LabelPathError('Old path prefix cannot be empty');
  if (newSegs.length === 0) throw new LabelPathError('New path prefix cannot be empty');
  const oldDepth = splitPath(oldPrefix).length;
  const out: RewrittenPath[] = [];
  for (const row of rows) {
    const segs = splitPath(row.path);
    const key = pathKeyOf(segs);
    if (!matchesSubtree(key, oldKey, false)) continue;
    const rest = segs.slice(oldDepth);
    const next = [...newSegs, ...rest];
    if (next.length > MAX_DEPTH) {
      throw new LabelPathError(
        `Moving '${row.path}' would exceed the maximum depth of ${MAX_DEPTH}`,
      );
    }
    out.push({ id: row.id, path: joinPath(next), path_key: pathKeyOf(next), depth: next.length });
  }
  return out;
}

/**
 * Nest flat rows (GET /api/labels) into a tree by parent_id. Siblings are
 * ordered by path_key (case-insensitive, what the rail shows). Rows whose
 * parent is missing from the input are promoted to the root rather than
 * dropped, so a partial list still renders. Input is not mutated.
 */
export function buildTree<T extends TreeInput>(rows: readonly T[]): LabelNode<T>[] {
  const nodes = new Map<number, LabelNode<T>>();
  for (const r of rows) nodes.set(r.id, { ...r, children: [] });
  const roots: LabelNode<T>[] = [];
  const sorted = [...nodes.values()].sort((a, b) =>
    a.path_key < b.path_key ? -1 : a.path_key > b.path_key ? 1 : a.id - b.id,
  );
  for (const n of sorted) {
    const parent = n.parent_id == null ? undefined : nodes.get(n.parent_id);
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** Depth-first flatten of a tree (pre-order) — inverse of buildTree. */
export function flattenTree<T extends TreeInput>(nodes: readonly LabelNode<T>[]): LabelNode<T>[] {
  const out: LabelNode<T>[] = [];
  const walk = (list: readonly LabelNode<T>[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Ids of a node and all its descendants. */
export function subtreeIds<T extends TreeInput>(node: LabelNode<T>): number[] {
  return flattenTree([node]).map((n) => n.id);
}

/**
 * Picker search: does `query` match a label path? Segment-aware — 'cust/lp'
 * matches 'Customers/LP Global/QBR' (each query segment must be a substring
 * of some path segment, in order). Plain text (no '/') matches anywhere in
 * the path. Case-insensitive. Empty query matches everything.
 */
export function matchesLabelQuery(path: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const pk = pathKeyOf(path);
  if (!q.includes(PATH_SEP)) return pk.includes(q);
  const qSegs = splitPath(q);
  const pSegs = splitPath(pk);
  let i = 0;
  for (const ps of pSegs) {
    if (i < qSegs.length && ps.includes(qSegs[i])) i++;
  }
  return i === qSegs.length;
}

/** Effective chip color: own color, else nearest ancestor's, else null. */
export function effectiveColor(
  label: { color: string | null; parent_id: number | null },
  byId: ReadonlyMap<number, { color: string | null; parent_id: number | null }>,
): string | null {
  let cur: { color: string | null; parent_id: number | null } | undefined = label;
  let guard = 0;
  while (cur && guard++ <= MAX_DEPTH) {
    if (cur.color) return cur.color;
    cur = cur.parent_id == null ? undefined : byId.get(cur.parent_id);
  }
  return null;
}

/** Parsed `?label=` / `&exact=` listing filter. */
export type LabelFilter =
  | { kind: 'none' }
  | { kind: 'id'; id: number; exact: boolean };

/**
 * Parse the listing query params. Returns null when no (valid) label filter
 * is present — routes must then leave the SQL untouched so the legacy
 * listing stays byte-identical. `label=none` → Unlabelled; `label=<int>`
 * (+ `exact=1|true`) → that label, subtree-inclusive unless exact.
 */
export function parseLabelFilter(label: string | null | undefined, exact?: string | null): LabelFilter | null {
  if (label == null) return null;
  const l = label.trim().toLowerCase();
  if (!l) return null;
  if (l === LABEL_FILTER_NONE) return { kind: 'none' };
  if (!/^\d{1,9}$/.test(l)) return null;
  const id = Number(l);
  if (!Number.isInteger(id) || id <= 0) return null;
  const e = (exact ?? '').trim().toLowerCase();
  return { kind: 'id', id, exact: e === '1' || e === 'true' || e === 'yes' };
}

/** Build the `label`/`exact` query params back from a filter (URL state). */
export function labelFilterToParams(f: LabelFilter | null): Record<string, string> {
  if (!f) return {};
  if (f.kind === 'none') return { label: LABEL_FILTER_NONE };
  return f.exact ? { label: String(f.id), exact: '1' } : { label: String(f.id) };
}

/**
 * Filesystem-safe directory segment for the CLI export mirror
 * (`<dir>/<label path>/...`). Keeps case and inner spaces (the export is
 * meant to read like the rail); replaces path separators and characters
 * illegal on Windows/macOS with '-', collapses whitespace, strips trailing
 * dots/spaces, caps at 120 chars, and never returns '' / '.' / '..'.
 */
export function slugifyForExport(segment: string): string {
  let s = (segment ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (s.length > 120) s = s.slice(0, 120).replace(/[. ]+$/g, '');
  if (!s || s === '.' || s === '..') return '_';
  return s;
}

/** Export-safe directory segments for a label path: splitPath + slugify. */
export function exportPathSegments(path: string): string[] {
  return splitPath(path).map(slugifyForExport);
}
