import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { identityForUser, resolveDisplayName } from '@/db-ops/transcript-activity';
import {
  getLabel,
  getLabelByPath,
  renameLabel,
  resolveOrCreatePath,
  LabelConflictError,
  type LabelActor,
  type LabelDbRow,
} from '@/db-ops/labels';
import { deriveSeriesLabelName, seriesLabelPath } from '@/lib/series-label-name';

/**
 * Series auto-labels — the first label-rules engine (labels-design §5).
 *
 * Every series with ≥2 live members gets a `Series/<title>` label plus a
 * label_rules row {kind:'series', value:'<seriesId>'}; every member carries
 * the label with how='rule', rule_id set. The rule follows label_id, never
 * the path — users may rename/move the series label freely and the rule
 * keeps applying it.
 *
 * Lifecycle / opt-out semantics (all hooks live in src/db-ops/series.ts and
 * run AFTER the series write commits, log-and-continue on failure):
 *   - creation happens whenever a member add finds ≥2 live members and NO
 *     rule row (plus the one-off backfill / merge transitions). Opt-out is
 *     an explicit tombstone, never an inferred absence: deleting the series
 *     label leaves the rule row behind with label_id NULL (FK ON DELETE SET
 *     NULL), and `enabled=false` is the same opt-out with the label kept.
 *     A tombstoned/disabled rule is never lazily re-labelled; a MISSING row
 *     means "never created", so concurrent adds that jump the count past 2
 *     (or a transient hook failure at the 1→2 transition) self-heal on the
 *     next member add instead of silently disabling the series forever.
 *   - series rename renames the label IF its name still matches the derived
 *     old-title name (a manual label rename wins over the automation).
 *   - merge: winner keeps/gets its label, the loser's rule-owned
 *     assignments migrate to the winner's label, the loser's rule dies.
 *     (The loser's *label* survives as an ordinary, now-unassigned label.)
 *   - series delete drops the rule; label + assignments stay as history
 *     (the rule_id FK nulls out).
 *   - member removal never un-labels — assignments are sticky history.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface SeriesLabelRule {
  id: number;
  /** NULL = opt-out tombstone: the series label was deleted (FK SET NULL). */
  label_id: number | null;
  kind: string;
  value: string;
  enabled: boolean;
  created_by: string;
  created_by_email: string;
}

/** A rule that should keep labelling (not a tombstone, not disabled). */
function ruleIsLive(rule: SeriesLabelRule | null): rule is SeriesLabelRule & { label_id: number } {
  return !!rule && rule.enabled && rule.label_id != null;
}

/** The series rule for a series id, if any (label_rules_series_value_uniq
 * guarantees at most one per series, tombstones included). */
export async function getSeriesRule(seriesId: number): Promise<SeriesLabelRule | null> {
  const rows = await sql<SeriesLabelRule[]>`
    SELECT id, label_id, kind, value, enabled, created_by, created_by_email
    FROM ${sql(SCHEMA)}.label_rules
    WHERE kind = 'series' AND value = ${String(seriesId)}
    ORDER BY id
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Live (non-trashed) member count — the ≥2 eligibility gate. */
async function liveMemberCount(seriesId: number): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
    WHERE m.series_id = ${seriesId}
  `;
  return row?.n ?? 0;
}

/**
 * Best actor we can attribute automation to. There is no users table;
 * identityForUser reads the activity log. The final fallback keeps the
 * NOT NULL columns satisfied with an honest system marker.
 */
async function resolveActor(
  preferredUserId: string | null | undefined,
  fallbackUserId: string
): Promise<LabelActor> {
  for (const uid of [preferredUserId, fallbackUserId]) {
    if (!uid) continue;
    const identity = await identityForUser(uid);
    if (identity) return { userId: identity.userId, email: identity.email };
  }
  return { userId: preferredUserId ?? fallbackUserId, email: 'system@darth-meetings' };
}

export interface EnsuredSeriesLabel {
  label: LabelDbRow;
  rule: SeriesLabelRule;
}

/**
 * Resolve (or create) the `Series/<title>` label + rule for a series.
 * Returns null when the series is gone, the rule is disabled, or
 * `createIfMissing` is false and no rule exists. Collisions under Series/
 * (two series named "Integration Cadence") take the ` (#<id>)` suffix;
 * the suffixed path, being deterministic per series, is REUSED if it
 * already exists (recovery after a partially-failed earlier run).
 */
export async function ensureSeriesLabel(
  seriesId: number,
  opts: { actor?: LabelActor; createIfMissing?: boolean } = {}
): Promise<EnsuredSeriesLabel | null> {
  const createIfMissing = opts.createIfMissing ?? true;

  const existingRule = await getSeriesRule(seriesId);
  if (existingRule) {
    // Tombstone (label_id NULL) or enabled=false = durable opt-out.
    if (!ruleIsLive(existingRule)) return null;
    const label = await getLabel(existingRule.label_id);
    if (!label) return null; // FK should make this impossible; stay safe
    return { label, rule: existingRule };
  }
  if (!createIfMissing) return null;

  const [series] = await sql<Array<{ id: number; title: string; created_by: string }>>`
    SELECT id, title, created_by FROM ${sql(SCHEMA)}.series WHERE id = ${seriesId}
  `;
  if (!series) return null;

  const actor = opts.actor ?? (await resolveActor(null, series.created_by));
  const names = deriveSeriesLabelName(series.title, seriesId);

  // Prefer the plain title; any existing label at that path (another
  // series' or a user's) is a collision → deterministic suffixed name.
  let segment = names.base;
  const clash = await getLabelByPath(seriesLabelPath(names.base));
  if (clash) segment = names.suffixed;

  const { label, created } = await resolveOrCreatePath(seriesLabelPath(segment), actor);
  if (created.length > 0) publishEvent({ kind: 'labels' });

  await sql`
    INSERT INTO ${sql(SCHEMA)}.label_rules (label_id, kind, value, created_by, created_by_email)
    VALUES (${label.id}, 'series', ${String(seriesId)}, ${actor.userId}, ${actor.email.trim().toLowerCase()})
    ON CONFLICT DO NOTHING
  `;
  // Re-select: if a concurrent ensure won (label_rules_series_value_uniq
  // makes exactly one rule per series stick), use the winner's label.
  const rule = await getSeriesRule(seriesId);
  if (!ruleIsLive(rule)) return null;
  if (rule.label_id !== label.id) {
    const winner = await getLabel(rule.label_id);
    return winner ? { label: winner, rule } : null;
  }

  // Cross-series guard: two DIFFERENT same-titled series racing this path
  // both pass the clash pre-check (neither label existed yet) and resolve
  // the identical base path — the unique index can't catch that (values
  // differ). The older rule keeps the base label; a younger rule that finds
  // an elder sibling on the same label moves to its deterministic suffixed
  // label so the two series stay distinguishable.
  if (segment === names.base) {
    const [elder] = await sql<Array<{ id: number }>>`
      SELECT id FROM ${sql(SCHEMA)}.label_rules
      WHERE kind = 'series' AND label_id = ${label.id}
        AND value <> ${String(seriesId)} AND id < ${rule.id}
      LIMIT 1
    `;
    if (elder) {
      const moved = await resolveOrCreatePath(seriesLabelPath(names.suffixed), actor);
      if (moved.created.length > 0) publishEvent({ kind: 'labels' });
      await sql`
        UPDATE ${sql(SCHEMA)}.label_rules SET label_id = ${moved.label.id}
        WHERE id = ${rule.id}
      `;
      return { label: moved.label, rule: { ...rule, label_id: moved.label.id } };
    }
  }
  return { label, rule };
}

/**
 * Assign the series label to members that don't carry it yet (all live
 * members, or just `transcriptIds`), with how='rule' + rule_id, and write
 * one label_add activity row per actually-new assignment. Attribution:
 * the acting user when known, else the rule's creator.
 */
export async function applySeriesLabel(
  seriesId: number,
  transcriptIds?: number[],
  opts: { actorUserId?: string | null; createIfMissing?: boolean } = {}
): Promise<{ assigned: number; labelPath: string | null }> {
  const ensured = await ensureSeriesLabel(seriesId, { createIfMissing: opts.createIfMissing });
  if (!ensured) return { assigned: 0, labelPath: null };
  const { label, rule } = ensured;

  const actor = await resolveActor(opts.actorUserId, rule.created_by).then((a) =>
    a.email === 'system@darth-meetings' ? { userId: rule.created_by, email: rule.created_by_email } : a
  );
  const email = actor.email.trim().toLowerCase();

  const idFilter = transcriptIds ? sql`AND m.transcript_id = ANY(${transcriptIds}::int[])` : sql``;
  const inserted = await sql<Array<{ transcript_id: number; assemblyai_id: string }>>`
    WITH ins AS (
      INSERT INTO ${sql(SCHEMA)}.transcript_labels
        (transcript_id, label_id, how, rule_id, added_by, added_by_email)
      SELECT m.transcript_id, ${label.id}, 'rule', ${rule.id}, ${actor.userId}, ${email}
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
      WHERE m.series_id = ${seriesId} ${idFilter}
      ON CONFLICT (transcript_id, label_id) DO NOTHING
      RETURNING transcript_id
    )
    SELECT ins.transcript_id, t.assemblyai_id
    FROM ins JOIN ${sql(SCHEMA)}.transcripts t ON t.id = ins.transcript_id
  `;
  if (inserted.length === 0) return { assigned: 0, labelPath: label.path };

  try {
    const userName = await resolveDisplayName(email);
    const ids = inserted.map((r) => r.transcript_id);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.transcript_activity
        (transcript_id, user_id, user_email, user_name, action, details)
      SELECT tid, ${actor.userId}::uuid, ${email}::text, ${userName}::text, 'label_add',
             jsonb_build_object('label_id', ${label.id}::int, 'path', ${label.path}::text,
                                'via', 'series_rule', 'series_id', ${seriesId}::int,
                                'rule_id', ${rule.id}::int)
      FROM unnest(${ids}::int[]) AS tid
    `;
  } catch (err) {
    console.warn('[series-labels] activity write failed (labels applied):', err);
  }

  publishEvent({ kind: 'labels' });
  for (const r of inserted) publishEvent({ kind: 'labels', assemblyaiId: r.assemblyai_id });
  return { assigned: inserted.length, labelPath: label.path };
}

/**
 * Post-addMember hook. Creates the label whenever the series has ≥2 live
 * members and no rule row yet — opt-out is an explicit tombstone (see
 * module docs), so "no rule" always means "never created" and concurrent
 * adds that jump the count past 2 (or a transient failure at the 1→2
 * transition) heal on the next add. An existing live rule keeps labelling
 * every new member; a tombstoned/disabled one never does.
 */
export async function syncSeriesLabelOnMemberAdd(
  seriesId: number,
  addedByUserId: string | null
): Promise<void> {
  const count = await liveMemberCount(seriesId);
  if (count < 2) return;
  const rule = await getSeriesRule(seriesId);
  if (rule && !ruleIsLive(rule)) return; // opted out
  await applySeriesLabel(seriesId, undefined, { actorUserId: addedByUserId });
}

/**
 * Post-rename hook: follow the series title IF the label still carries the
 * derived old-title name (base or suffixed) — a manual rename wins forever.
 * On a sibling clash with the new name, fall back to the suffixed variant.
 */
export async function onSeriesRenamed(
  seriesId: number,
  oldTitle: string,
  newTitle: string,
  actorUserId?: string | null
): Promise<void> {
  const rule = await getSeriesRule(seriesId);
  if (!ruleIsLive(rule)) return;
  const label = await getLabel(rule.label_id);
  if (!label) return;

  const oldNames = deriveSeriesLabelName(oldTitle, seriesId);
  if (label.name !== oldNames.base && label.name !== oldNames.suffixed) return;

  const newNames = deriveSeriesLabelName(newTitle, seriesId);
  if (label.name === newNames.base) return;
  // Attribute the label rename to whoever renamed the series; the rule's
  // creator is only the fallback when the actor can't be resolved.
  const actor = await resolveActor(actorUserId, rule.created_by).then((a) =>
    a.email === 'system@darth-meetings' ? { userId: rule.created_by, email: rule.created_by_email } : a
  );
  try {
    await renameLabel(label.id, newNames.base, actor);
  } catch (err) {
    if (err instanceof LabelConflictError && newNames.suffixed !== label.name) {
      await renameLabel(label.id, newNames.suffixed, actor);
    } else if (!(err instanceof LabelConflictError)) {
      throw err;
    }
  }
  publishEvent({ kind: 'labels' });
}

/** Captured BEFORE the merge transaction (the loser row dies inside it). */
export interface PreMergeLabelState {
  intoRule: SeriesLabelRule | null;
  fromRule: SeriesLabelRule | null;
  intoCount: number;
  fromCount: number;
}

export async function preMergeLabelState(
  intoId: number,
  fromId: number
): Promise<PreMergeLabelState> {
  return {
    intoRule: await getSeriesRule(intoId),
    fromRule: await getSeriesRule(fromId),
    intoCount: await liveMemberCount(intoId),
    fromCount: await liveMemberCount(fromId),
  };
}

/**
 * Post-merge hook. Winner keeps/gets its label; the loser's rule-owned
 * assignments move to the winner's label and the loser's rule is deleted.
 * The winner's own state decides creation: a tombstoned/disabled winner
 * rule is a durable opt-out that the merge must NOT revive, even when the
 * loser's rule is live. A winner with no rule at all gets one when the
 * loser's rule was live (automation follows the members) or when the merge
 * itself reaches the ≥2 threshold.
 */
export async function onSeriesMerged(
  intoId: number,
  fromId: number,
  pre: PreMergeLabelState,
  actorUserId?: string | null
): Promise<void> {
  const { intoRule, fromRule, intoCount, fromCount } = pre;

  const shouldHaveLabel = intoRule
    ? ruleIsLive(intoRule)
    : fromRule
      ? ruleIsLive(fromRule)
      : intoCount + fromCount >= 2;

  const winner = shouldHaveLabel
    ? await ensureSeriesLabel(intoId, { createIfMissing: true })
    : null;

  if (fromRule) {
    if (winner && fromRule.label_id != null) {
      // Migrate the loser's rule-owned assignments onto the winner's label.
      const migrated = await sql<Array<{ transcript_id: number }>>`
        INSERT INTO ${sql(SCHEMA)}.transcript_labels
          (transcript_id, label_id, how, rule_id, added_by, added_by_email)
        SELECT tl.transcript_id, ${winner.label.id}, 'rule', ${winner.rule.id},
               tl.added_by, tl.added_by_email
        FROM ${sql(SCHEMA)}.transcript_labels tl
        WHERE tl.rule_id = ${fromRule.id} AND tl.label_id = ${fromRule.label_id}
        ON CONFLICT (transcript_id, label_id) DO NOTHING
        RETURNING transcript_id
      `;
      await sql`
        DELETE FROM ${sql(SCHEMA)}.transcript_labels
        WHERE rule_id = ${fromRule.id} AND label_id = ${fromRule.label_id}
      `;
      if (migrated.length > 0) publishEvent({ kind: 'labels' });
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.label_rules WHERE id = ${fromRule.id}`;
  }

  if (winner) await applySeriesLabel(intoId, undefined, { actorUserId });
}

/** Post-delete hook: the rule dies with its series; label + history stay. */
export async function onSeriesDeleted(seriesId: number): Promise<void> {
  await sql`
    DELETE FROM ${sql(SCHEMA)}.label_rules
    WHERE kind = 'series' AND value = ${String(seriesId)}
  `;
}
