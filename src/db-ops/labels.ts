import 'server-only';
import type postgres from 'postgres';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { resolveDisplayName } from '@/db-ops/transcript-activity';
import { hideUnseenSeriesLabels } from '@/lib/label-visibility';
import { SERIES_LABEL_ROOT } from '@/lib/series-label-name';
import {
  LabelPathError,
  assertPath,
  assertSegment,
  joinPath,
  normalizeKey,
  pathKeyOf,
  rewritePaths,
  validateColor,
  type LabelRef,
  type LabelRow,
} from '@/lib/labels';

/**
 * Org-wide hierarchical labels (docs/labels-design.md §2/§3/§7).
 *
 * Path storage is parent_id + materialized path/path_key; rename/move/delete
 * recompute or drop the subtree in ONE transaction here (no triggers). The
 * materialized columns stay consistent with parent_id only because every
 * writer follows one locking protocol under READ COMMITTED:
 *   - rename/move/delete take `SELECT … FOR UPDATE` on the root row FIRST and
 *     work from that (fresh, post-lock) row, then lock the subtree in a new
 *     statement (new snapshot → sees children committed by whoever we waited
 *     on);
 *   - create walks/reads every parent segment `FOR SHARE`, so it blocks behind
 *     an in-flight rename/move of that parent and uses the post-commit path,
 *     and a rename/move that starts later blocks until the child is committed
 *     and therefore rewrites it too (a plain FK KEY SHARE would not conflict
 *     with the rename's non-key UPDATE — that was the original hole);
 *   - move locks root + new parent in ascending id order, and all three
 *     mutations retry once-or-twice on a PG deadlock (40P01) so the remaining
 *     multi-row orderings never surface as a 500.
 * The taxonomy itself has no ACL (same model as series): anyone authenticated can
 * create/rename/move/recolor/delete. Assignments are gated per transcript by
 * the routes (owner|edit via resolveAccess) — this module only knows how to
 * write them.
 *
 * Visibility for counts = the listing's rule: own rows + rows shared with the
 * caller's email, `deleted_at IS NULL`.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

type Sql = typeof sql;
type Tx = postgres.TransactionSql;

/** Thrown for 404s (label / parent missing). */
export class LabelNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(message = 'Label not found') {
    super(message);
    this.name = 'LabelNotFoundError';
  }
}

/** Thrown for 409s: cycle, duplicate sibling, depth overflow, children w/o cascade. */
export class LabelConflictError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = 'LabelConflictError';
  }
}

/** Full DB row (what the routes return as `label`). */
export interface LabelDbRow extends LabelRow {
  name_key: string;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LabelActor {
  userId: string;
  email: string;
}

export type AssignmentHow = 'manual' | 'cli' | 'bulk' | 'rule';

/** One label as carried by GET /api/transcripts/:id/labels. */
export interface AssignedLabel extends LabelRef {
  how: AssignmentHow;
  added_by_email: string;
  added_at: string;
}

/** Escape a literal for use inside a LIKE pattern (backslash escape char). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Fresh fragment per use site (postgres.js fragments are single-use). */
const LABEL_COLS = () => sql`
  l.id, l.parent_id, l.name, l.name_key, l.path, l.path_key, l.depth, l.color,
  l.description, l.created_by, l.created_by_email, l.updated_by,
  l.created_at::text AS created_at, l.updated_at::text AS updated_at
`;

function toRef(r: { id: number; name: string; path: string; color: string | null }): LabelRef {
  return { id: r.id, name: r.name, path: r.path, color: r.color };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLabel(id: number, tx: Tx | Sql = sql): Promise<LabelDbRow | null> {
  const rows = await tx<LabelDbRow[]>`
    SELECT ${LABEL_COLS()} FROM ${sql(SCHEMA)}.labels l WHERE l.id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * Read one label row under a row lock. `'update'` serialises against every
 * other mutation of that row; `'share'` (used by create for its parents)
 * blocks behind an in-flight FOR UPDATE and blocks later ones until we
 * commit. Under READ COMMITTED the lock wait re-evaluates the row, so the
 * returned row is the post-wait version — callers must derive everything
 * (path, name_key, parent_id) from THIS row, never from a pre-lock read.
 */
async function lockLabel(tx: Tx, id: number, mode: 'update' | 'share'): Promise<LabelDbRow | null> {
  const rows =
    mode === 'update'
      ? await tx<LabelDbRow[]>`
          SELECT ${LABEL_COLS()} FROM ${sql(SCHEMA)}.labels l WHERE l.id = ${id} FOR UPDATE
        `
      : await tx<LabelDbRow[]>`
          SELECT ${LABEL_COLS()} FROM ${sql(SCHEMA)}.labels l WHERE l.id = ${id} FOR SHARE
        `;
  return rows[0] ?? null;
}

const DEADLOCK_RETRIES = 3;

/**
 * Run `fn` (one sql.begin) and retry on a Postgres deadlock (40P01). Two
 * opposite moves (C under P, P under C) or a subtree rename racing a move of
 * two of its rows can still pick opposite lock orders; PG aborts one, we
 * re-run it on fresh state (it then usually 409s on the cycle, which is the
 * right answer) instead of surfacing a 500.
 */
async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== '40P01' || attempt >= DEADLOCK_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 20 * attempt));
    }
  }
}

export async function getLabelByPath(path: string): Promise<LabelDbRow | null> {
  const key = pathKeyOf(path);
  if (!key) return null;
  const rows = await sql<LabelDbRow[]>`
    SELECT ${LABEL_COLS()} FROM ${sql(SCHEMA)}.labels l WHERE l.path_key = ${key}
  `;
  return rows[0] ?? null;
}

/**
 * Flat catalog sorted by path_key (no counts), scoped to the caller.
 *
 * PRIVACY GATE (tech-debt D4, 2026-09-18): `Series/*` auto-labels mirror
 * series titles (= meeting titles), so a series node is served only when
 * the caller holds a visible transcript (own + shared, not trashed) carrying
 * it or a descendant — lib/label-visibility is THE predicate; this query is
 * its SQL twin (subtree-inclusive prefix compare on path_key). Hand-made
 * labels remain the org taxonomy everyone sees.
 */
export async function listLabels(caller: { userId: string; email: string }): Promise<LabelDbRow[]> {
  const normEmail = caller.email.trim().toLowerCase();
  const seriesRoot = SERIES_LABEL_ROOT.toLowerCase();
  return sql<LabelDbRow[]>`
    WITH vis AS MATERIALIZED (
      SELECT t.id
      FROM ${sql(SCHEMA)}.transcripts t
      LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
        ON s.transcript_id = t.id AND s.shared_with_email = ${normEmail}
      WHERE (t.user_id = ${caller.userId} OR s.id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND NOT t.scratch
    ),
    vis_keys AS MATERIALIZED (
      SELECT DISTINCT l2.path_key
      FROM ${sql(SCHEMA)}.transcript_labels tl
      JOIN vis ON vis.id = tl.transcript_id
      JOIN ${sql(SCHEMA)}.labels l2 ON l2.id = tl.label_id
      WHERE l2.path_key = ${seriesRoot} OR left(l2.path_key, ${seriesRoot.length + 1}) = ${`${seriesRoot}/`}
    )
    SELECT ${LABEL_COLS()} FROM ${sql(SCHEMA)}.labels l
    WHERE NOT (l.path_key = ${seriesRoot} OR left(l.path_key, ${seriesRoot.length + 1}) = ${`${seriesRoot}/`})
       OR EXISTS (
         SELECT 1 FROM vis_keys vk
         WHERE vk.path_key = l.path_key
            OR left(vk.path_key, length(l.path_key) + 1) = l.path_key || '/'
       )
    ORDER BY l.path_key
  `;
}

export interface LabelCatalogWithCounts {
  labels: LabelDbRow[];
  /** Visible (to the caller) non-deleted transcripts with no label at all. */
  unlabelled: number;
  /** Visible non-deleted transcripts, period. */
  total: number;
}

/**
 * Catalog + per-label counts scoped to the transcripts the caller can see
 * (own + shared, not trashed). `count_visible` is subtree-inclusive
 * (distinct transcripts carrying the label or any descendant), `count_direct`
 * is exactly-this-label. One query; the visible set is materialized once.
 * Subtree membership uses a prefix compare on path_key (no LIKE escaping
 * needed for per-row patterns).
 */
export async function listLabelsWithCounts(
  userId: string,
  email: string
): Promise<LabelCatalogWithCounts> {
  const normEmail = email.trim().toLowerCase();
  const rows = await sql<
    Array<LabelDbRow & { count_visible: number; count_direct: number; __unlabelled: number; __total: number }>
  >`
    WITH vis AS MATERIALIZED (
      SELECT t.id
      FROM ${sql(SCHEMA)}.transcripts t
      LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
        ON s.transcript_id = t.id AND s.shared_with_email = ${normEmail}
      WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND NOT t.scratch
    ),
    vis_assign AS MATERIALIZED (
      SELECT tl.transcript_id, tl.label_id, l2.path_key
      FROM ${sql(SCHEMA)}.transcript_labels tl
      JOIN vis ON vis.id = tl.transcript_id
      JOIN ${sql(SCHEMA)}.labels l2 ON l2.id = tl.label_id
    ),
    direct AS (
      SELECT label_id, count(*)::int AS n FROM vis_assign GROUP BY label_id
    ),
    totals AS (
      SELECT (SELECT count(*)::int FROM vis) AS total,
             (SELECT count(*)::int FROM vis v
               WHERE NOT EXISTS (SELECT 1 FROM vis_assign va WHERE va.transcript_id = v.id)) AS unlabelled
    )
    SELECT ${LABEL_COLS()},
           COALESCE(d.n, 0) AS count_direct,
           (SELECT count(DISTINCT va.transcript_id)::int FROM vis_assign va
             WHERE va.path_key = l.path_key
                OR left(va.path_key, length(l.path_key) + 1) = l.path_key || '/') AS count_visible,
           totals.unlabelled AS __unlabelled,
           totals.total AS __total
    FROM ${sql(SCHEMA)}.labels l
    LEFT JOIN direct d ON d.label_id = l.id
    CROSS JOIN totals
    ORDER BY l.path_key
  `;
  if (rows.length === 0) {
    // No labels yet — still answer the pseudo-node counts.
    const t = await sql<[{ total: number; unlabelled: number }]>`
      SELECT count(*)::int AS total, count(*)::int AS unlabelled
      FROM ${sql(SCHEMA)}.transcripts t
      LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
        ON s.transcript_id = t.id AND s.shared_with_email = ${normEmail}
      WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND NOT t.scratch
    `;
    return { labels: [], unlabelled: t[0]?.unlabelled ?? 0, total: t[0]?.total ?? 0 };
  }
  const { __unlabelled, __total } = rows[0];
  // PRIVACY GATE (tech-debt D4, 2026-09-18): Series/* nodes with no
  // caller-visible tagged transcript do not exist for this caller —
  // lib/label-visibility over the subtree-inclusive count_visible.
  const labels = hideUnseenSeriesLabels(rows).map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { __unlabelled: _u, __total: _t, ...rest } = r;
    return rest;
  });
  return { labels, unlabelled: __unlabelled, total: __total };
}

/** Labels on one transcript (by internal id), sorted by path_key. */
export async function listForTranscript(
  transcriptId: number,
  tx: Tx | Sql = sql
): Promise<AssignedLabel[]> {
  return tx<AssignedLabel[]>`
    SELECT l.id, l.name, l.path, l.color, tl.how, tl.added_by_email,
           tl.added_at::text AS added_at
    FROM ${sql(SCHEMA)}.transcript_labels tl
    JOIN ${sql(SCHEMA)}.labels l ON l.id = tl.label_id
    WHERE tl.transcript_id = ${transcriptId}
    ORDER BY l.path_key
  `;
}

// ---------------------------------------------------------------------------
// Taxonomy writes
// ---------------------------------------------------------------------------

async function writeHistory(
  tx: Tx | Sql,
  input: {
    labelId: number | null;
    action: 'create' | 'rename' | 'move' | 'recolor' | 'delete' | 'merge';
    before?: unknown;
    after?: unknown;
    actor: LabelActor;
  }
): Promise<void> {
  await tx`
    INSERT INTO ${sql(SCHEMA)}.label_history (label_id, action, before, after, by_user, by_email)
    VALUES (
      ${input.labelId},
      ${input.action},
      ${input.before === undefined ? null : sql.json(input.before as never)},
      ${input.after === undefined ? null : sql.json(input.after as never)},
      ${input.actor.userId},
      ${input.actor.email.trim().toLowerCase()}
    )
  `;
}

export interface ResolveOrCreateResult {
  label: LabelDbRow;
  /** Newly inserted segments, root-most first (empty when the path existed). */
  created: LabelDbRow[];
}

/**
 * Walk a display path segment by segment, creating what is missing, in one
 * transaction. Case-insensitive match per parent (`name_key`). Races are
 * settled by `ON CONFLICT DO NOTHING` + re-select. `color` (if given) lands
 * on the leaf only when the leaf is created here. Throws LabelPathError (400)
 * on a bad path.
 */
export async function resolveOrCreatePath(
  path: string,
  actor: LabelActor,
  opts: { color?: string | null; baseParentId?: number | null } = {}
): Promise<ResolveOrCreateResult> {
  return sql.begin(async (tx) => resolveOrCreatePathTx(tx, path, actor, opts));
}

async function resolveOrCreatePathTx(
  tx: Tx,
  path: string,
  actor: LabelActor,
  opts: { color?: string | null; baseParentId?: number | null } = {}
): Promise<ResolveOrCreateResult> {
  let parent: LabelDbRow | null = null;
  if (opts.baseParentId != null) {
    // FOR SHARE: wait out an in-flight rename/move of the parent and read its
    // post-commit path; block later ones until this child is committed.
    parent = await lockLabel(tx, opts.baseParentId, 'share');
    if (!parent) throw new LabelNotFoundError('Parent label not found');
  }
  const segs = assertPath(path, parent?.depth ?? 0);
  const colorV = validateColor(opts.color);
  if (!colorV.ok) throw new LabelPathError(colorV.error);
  const created: LabelDbRow[] = [];
  const email = actor.email.trim().toLowerCase();

  for (let i = 0; i < segs.length; i++) {
    const name = segs[i]!;
    const nameKey = normalizeKey(name);
    const parentKey = parent?.id ?? 0;
    // FOR SHARE on every segment we walk through (see lockLabel): the row we
    // hang the next segment under is the one a concurrent rename/move left
    // behind, and that rename/move cannot slip in between our read and our
    // INSERT (the FK's KEY SHARE alone would not stop a non-key UPDATE).
    const existing = await tx<LabelDbRow[]>`
      SELECT ${LABEL_COLS()} FROM ${sql(SCHEMA)}.labels l
      WHERE COALESCE(l.parent_id, 0) = ${parentKey} AND l.name_key = ${nameKey}
      FOR SHARE
    `;
    if (existing[0]) {
      parent = existing[0];
      continue;
    }
    const displayPath = parent ? joinPath([parent.path, name]) : name;
    const pathKey = pathKeyOf(displayPath);
    const depth = (parent?.depth ?? 0) + 1;
    const isLeaf = i === segs.length - 1;
    const inserted = await tx<LabelDbRow[]>`
      INSERT INTO ${sql(SCHEMA)}.labels AS l
        (parent_id, name, name_key, path, path_key, depth, color, created_by, created_by_email)
      VALUES (
        ${parent?.id ?? null}, ${name}, ${nameKey}, ${displayPath}, ${pathKey}, ${depth},
        ${isLeaf ? colorV.value : null}, ${actor.userId}, ${email}
      )
      ON CONFLICT ((COALESCE(parent_id, 0)), name_key) DO NOTHING
      RETURNING ${LABEL_COLS()}
    `;
    let row = inserted[0];
    if (!row) {
      // Lost a race — the sibling exists now; re-select it.
      const again = await tx<LabelDbRow[]>`
        SELECT ${LABEL_COLS()} FROM ${sql(SCHEMA)}.labels l
        WHERE COALESCE(l.parent_id, 0) = ${parentKey} AND l.name_key = ${nameKey}
        FOR SHARE
      `;
      row = again[0];
      if (!row) throw new LabelConflictError(`Could not create label '${displayPath}'`);
    } else {
      created.push(row);
      await writeHistory(tx, {
        labelId: row.id,
        action: 'create',
        after: { path: row.path, color: row.color, parent_id: row.parent_id },
        actor,
      });
    }
    parent = row;
  }
  if (!parent) throw new LabelPathError('Label path cannot be empty');
  return { label: parent, created };
}

/**
 * Create one label under `parentId` (null = top level). Case-insensitive
 * sibling collision → returns the existing one with created=[] (200, same as
 * a re-POSTed path). `name` must be a single segment.
 */
export async function createLabel(
  input: { name: string; parentId: number | null; color?: string | null },
  actor: LabelActor
): Promise<ResolveOrCreateResult> {
  const name = assertSegment(input.name);
  return resolveOrCreatePath(name, actor, { color: input.color, baseParentId: input.parentId });
}

export interface SubtreeUpdateResult {
  label: LabelDbRow;
  updated: Array<{ id: number; path: string }>;
}

/**
 * Lock and return the subtree rooted at `root` (root included). Call this
 * only AFTER the root row itself is locked via lockLabel(..,'update') and
 * with THAT row's path_key: as a separate statement it gets a fresh
 * snapshot, so children committed by the writer we waited on are included.
 */
async function lockSubtree(
  tx: Tx,
  root: { path_key: string }
): Promise<Array<{ id: number; path: string; parent_id: number | null }>> {
  const prefix = `${escapeLike(root.path_key)}/%`;
  return tx<Array<{ id: number; path: string; parent_id: number | null }>>`
    SELECT id, path, parent_id FROM ${sql(SCHEMA)}.labels
    WHERE path_key = ${root.path_key} OR path_key LIKE ${prefix}
    ORDER BY path_key
    FOR UPDATE
  `;
}

async function applyRewrite(
  tx: Tx,
  rows: ReturnType<typeof rewritePaths>,
  actor: LabelActor
): Promise<void> {
  for (const r of rows) {
    await tx`
      UPDATE ${sql(SCHEMA)}.labels
      SET path = ${r.path}, path_key = ${r.path_key}, depth = ${r.depth},
          updated_by = ${actor.userId}, updated_at = now()
      WHERE id = ${r.id}
    `;
  }
}

async function renameLabelTx(
  tx: Tx,
  id: number,
  newName: string,
  actor: LabelActor
): Promise<SubtreeUpdateResult> {
  const name = assertSegment(newName);
  const nameKey = normalizeKey(name);
  const cur = await lockLabel(tx, id, 'update');
  if (!cur) throw new LabelNotFoundError();
  const subtree = await lockSubtree(tx, cur);
  if (cur.name === name) {
    return { label: cur, updated: subtree.map((r) => ({ id: r.id, path: r.path })) };
  }
  const clash = await tx<Array<{ id: number }>>`
    SELECT id FROM ${sql(SCHEMA)}.labels
    WHERE COALESCE(parent_id, 0) = ${cur.parent_id ?? 0} AND name_key = ${nameKey} AND id <> ${id}
  `;
  if (clash[0]) {
    throw new LabelConflictError(`A label named '${name}' already exists at this level`);
  }
  const parentPathStr = joinPath(cur.path.split('/').slice(0, -1));
  const newPath = parentPathStr ? joinPath([parentPathStr, name]) : name;
  const rewritten = rewritePaths(cur.path, newPath, subtree);
  await applyRewrite(tx, rewritten, actor);
  await tx`
    UPDATE ${sql(SCHEMA)}.labels SET name = ${name}, name_key = ${nameKey} WHERE id = ${id}
  `;
  await writeHistory(tx, {
    labelId: id,
    action: 'rename',
    before: { name: cur.name, path: cur.path },
    after: { name, path: newPath, affected: rewritten.length },
    actor,
  });
  const label = (await getLabel(id, tx))!;
  return { label, updated: rewritten.map((r) => ({ id: r.id, path: r.path })) };
}

/** Rename one segment; the whole subtree's paths follow. 409 on a sibling clash. */
export async function renameLabel(
  id: number,
  newName: string,
  actor: LabelActor
): Promise<SubtreeUpdateResult> {
  return withDeadlockRetry(() => sql.begin((tx) => renameLabelTx(tx, id, newName, actor)));
}

async function moveLabelTx(
  tx: Tx,
  id: number,
  newParentId: number | null,
  actor: LabelActor
): Promise<SubtreeUpdateResult> {
  if (newParentId === id) throw new LabelConflictError('A label cannot be its own parent');
  // Root + new parent FOR UPDATE in ascending id order (two opposite moves
  // then queue instead of deadlocking), both re-read post-lock.
  let cur: LabelDbRow | null = null;
  let parent: LabelDbRow | null = null;
  if (newParentId != null && newParentId < id) {
    parent = await lockLabel(tx, newParentId, 'update');
    cur = await lockLabel(tx, id, 'update');
  } else {
    cur = await lockLabel(tx, id, 'update');
    if (newParentId != null) parent = await lockLabel(tx, newParentId, 'update');
  }
  if (!cur) throw new LabelNotFoundError();
  if (newParentId != null) {
    if (!parent) throw new LabelNotFoundError('Target parent label not found');
    if (parent.path_key === cur.path_key || parent.path_key.startsWith(`${cur.path_key}/`)) {
      throw new LabelConflictError('Cannot move a label into its own subtree');
    }
  }
  const subtree = await lockSubtree(tx, cur);
  if ((cur.parent_id ?? null) === (parent?.id ?? null)) {
    return { label: cur, updated: subtree.map((r) => ({ id: r.id, path: r.path })) };
  }
  const clash = await tx<Array<{ id: number }>>`
    SELECT id FROM ${sql(SCHEMA)}.labels
    WHERE COALESCE(parent_id, 0) = ${parent?.id ?? 0} AND name_key = ${cur.name_key} AND id <> ${id}
  `;
  if (clash[0]) {
    throw new LabelConflictError(
      `A label named '${cur.name}' already exists under ${parent ? `'${parent.path}'` : 'the top level'}`
    );
  }
  const newPath = parent ? joinPath([parent.path, cur.name]) : cur.name;
  let rewritten: ReturnType<typeof rewritePaths>;
  try {
    rewritten = rewritePaths(cur.path, newPath, subtree);
  } catch (err) {
    if (err instanceof LabelPathError) throw new LabelConflictError(err.message);
    throw err;
  }
  await applyRewrite(tx, rewritten, actor);
  await tx`
    UPDATE ${sql(SCHEMA)}.labels SET parent_id = ${parent?.id ?? null} WHERE id = ${id}
  `;
  await writeHistory(tx, {
    labelId: id,
    action: 'move',
    before: { parent_id: cur.parent_id, path: cur.path },
    after: { parent_id: parent?.id ?? null, path: newPath, affected: rewritten.length },
    actor,
  });
  const label = (await getLabel(id, tx))!;
  return { label, updated: rewritten.map((r) => ({ id: r.id, path: r.path })) };
}

/**
 * Re-parent a label (null = top level); subtree paths follow. 409 on: move
 * into its own subtree, sibling clash under the new parent, depth overflow.
 */
export async function moveLabel(
  id: number,
  newParentId: number | null,
  actor: LabelActor
): Promise<SubtreeUpdateResult> {
  return withDeadlockRetry(() => sql.begin((tx) => moveLabelTx(tx, id, newParentId, actor)));
}

async function updateLabelMetaTx(
  tx: Tx,
  id: number,
  patch: { color?: string | null; description?: string | null },
  actor: LabelActor
): Promise<LabelDbRow> {
  const cur = await lockLabel(tx, id, 'update');
  if (!cur) throw new LabelNotFoundError();
  let color = cur.color;
  if (patch.color !== undefined) {
    const v = validateColor(patch.color);
    if (!v.ok) throw new LabelPathError(v.error);
    color = v.value;
  }
  let description = cur.description;
  if (patch.description !== undefined) {
    if (patch.description !== null && typeof patch.description !== 'string') {
      throw new LabelPathError('Description must be a string');
    }
    description = patch.description ? patch.description.trim().slice(0, 500) || null : null;
  }
  await tx`
    UPDATE ${sql(SCHEMA)}.labels
    SET color = ${color}, description = ${description},
        updated_by = ${actor.userId}, updated_at = now()
    WHERE id = ${id}
  `;
  if (color !== cur.color) {
    await writeHistory(tx, {
      labelId: id,
      action: 'recolor',
      before: { color: cur.color },
      after: { color },
      actor,
    });
  }
  return (await getLabel(id, tx))!;
}

/** Color and/or description. Color is validated ('#rrggbb' | null). */
export async function updateLabelMeta(
  id: number,
  patch: { color?: string | null; description?: string | null },
  actor: LabelActor
): Promise<LabelDbRow> {
  return withDeadlockRetry(() => sql.begin((tx) => updateLabelMetaTx(tx, id, patch, actor)));
}

export interface UpdateLabelPatch {
  name?: string;
  /** `null` = move to top level; undefined = don't move. */
  parentId?: number | null;
  color?: string | null;
  description?: string | null;
}

/**
 * PATCH /api/labels/:id in ONE transaction: rename, then move, then
 * color/description — so a 404/409/400 from a later step rolls back the
 * earlier ones (a combined rename+move that 409s on the cycle leaves nothing
 * written). `updated` is the union of every rewritten row, carrying the
 * final path.
 */
export async function updateLabel(
  id: number,
  patch: UpdateLabelPatch,
  actor: LabelActor
): Promise<SubtreeUpdateResult> {
  return withDeadlockRetry(() =>
    sql.begin(async (tx) => {
      const updated = new Map<number, string>();
      let label: LabelDbRow | null = null;
      if (patch.name !== undefined) {
        const r = await renameLabelTx(tx, id, patch.name, actor);
        for (const u of r.updated) updated.set(u.id, u.path);
        label = r.label;
      }
      if (patch.parentId !== undefined) {
        const r = await moveLabelTx(tx, id, patch.parentId, actor);
        for (const u of r.updated) updated.set(u.id, u.path);
        label = r.label;
      }
      if (patch.color !== undefined || patch.description !== undefined) {
        label = await updateLabelMetaTx(
          tx,
          id,
          {
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
          },
          actor
        );
      }
      if (!label) label = await getLabel(id, tx);
      if (!label) throw new LabelNotFoundError();
      if (updated.size === 0) updated.set(label.id, label.path);
      return { label, updated: [...updated].map(([uid, path]) => ({ id: uid, path })) };
    })
  );
}

export interface DeleteLabelResult {
  removedLabels: number;
  removedAssignments: number;
  /** Transcripts (assemblyai ids) that lost an assignment — for SSE. */
  affectedTranscripts: string[];
}

/**
 * Delete a label. 409 when it has children and `cascade` is false. With
 * cascade the FK takes the subtree; assignments cascade either way, and every
 * assignment that goes gets a `label_remove` transcript_activity row (the
 * per-transcript audit stays complete — spec §2), written in the same txn.
 */
export async function deleteLabel(
  id: number,
  cascade: boolean,
  actor: LabelActor
): Promise<DeleteLabelResult> {
  return withDeadlockRetry(() =>
    sql.begin(async (tx) => {
      const cur = await lockLabel(tx, id, 'update');
      if (!cur) throw new LabelNotFoundError();
      const subtree = await lockSubtree(tx, cur);
      if (subtree.length > 1 && !cascade) {
        throw new LabelConflictError(
          `Label '${cur.path}' has ${subtree.length - 1} sub-label(s); pass cascade=1 to delete them too`
        );
      }
      const ids = subtree.map((r) => r.id);
      const affected = await tx<Array<{ assemblyai_id: string }>>`
        SELECT DISTINCT t.assemblyai_id
        FROM ${sql(SCHEMA)}.transcript_labels tl
        JOIN ${sql(SCHEMA)}.transcripts t ON t.id = tl.transcript_id
        WHERE tl.label_id = ANY(${ids}::int[])
      `;
      // Audit the assignments the FK cascade is about to drop: one
      // label_remove row per (transcript, label), attributed to the deleter.
      const email = actor.email.trim().toLowerCase();
      const userName = await resolveDisplayName(email);
      const removed = await tx<Array<{ n: number }>>`
        WITH gone AS (
          INSERT INTO ${sql(SCHEMA)}.transcript_activity
            (transcript_id, user_id, user_email, user_name, action, details)
          SELECT tl.transcript_id, ${actor.userId}, ${email}, ${userName}, 'label_remove',
                 jsonb_build_object('label_id', l.id, 'path', l.path, 'via', 'label_delete',
                                    'cascade', ${cascade}::boolean)
          FROM ${sql(SCHEMA)}.transcript_labels tl
          JOIN ${sql(SCHEMA)}.labels l ON l.id = tl.label_id
          WHERE tl.label_id = ANY(${ids}::int[])
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM gone
      `;
      const nAssignments = removed[0]?.n ?? 0;
      await tx`DELETE FROM ${sql(SCHEMA)}.labels WHERE id = ${id}`;
      await writeHistory(tx, {
        labelId: id,
        action: 'delete',
        before: {
          path: cur.path,
          subtree: subtree.map((r) => ({ id: r.id, path: r.path })),
          assignments: nAssignments,
        },
        actor,
      });
      return {
        removedLabels: subtree.length,
        removedAssignments: nAssignments,
        affectedTranscripts: affected.map((r) => r.assemblyai_id),
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Assignments (the ROUTE checks owner|edit before calling these)
// ---------------------------------------------------------------------------

/**
 * Assign a label to a transcript (idempotent). Returns whether a row was
 * actually inserted so the caller logs activity only on real changes.
 */
export async function addAssignment(
  transcriptId: number,
  labelId: number,
  actor: LabelActor,
  how: AssignmentHow = 'manual'
): Promise<{ inserted: boolean }> {
  const rows = await sql<Array<{ transcript_id: number }>>`
    INSERT INTO ${sql(SCHEMA)}.transcript_labels
      (transcript_id, label_id, how, added_by, added_by_email)
    VALUES (${transcriptId}, ${labelId}, ${how}, ${actor.userId}, ${actor.email.trim().toLowerCase()})
    ON CONFLICT (transcript_id, label_id) DO NOTHING
    RETURNING transcript_id
  `;
  return { inserted: rows.length > 0 };
}

export async function removeAssignment(
  transcriptId: number,
  labelId: number
): Promise<{ removed: boolean }> {
  const rows = await sql<Array<{ transcript_id: number }>>`
    DELETE FROM ${sql(SCHEMA)}.transcript_labels
    WHERE transcript_id = ${transcriptId} AND label_id = ${labelId}
    RETURNING transcript_id
  `;
  return { removed: rows.length > 0 };
}

export { toRef as labelToRef };
