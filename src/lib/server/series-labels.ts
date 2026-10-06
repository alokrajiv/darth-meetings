import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { resolveDisplayName } from '@/db-ops/transcript-activity';
import type { LabelActor } from '@/db-ops/labels';

/**
 * Series default labels (docs/curated-series-spec.md §4) — the label-rules
 * engine of kind 'series', curated edition.
 *
 * A series' default labels are its `label_rules` rows {kind:'series',
 * value:'<series id>', label_id NOT NULL, enabled} — any number of them
 * (migration 053 replaced 030's one-rule-per-series index with a
 * (value, label_id) one). Every member carries each one with how='rule' and
 * rule_id set; the rule follows label_id, never the path, so a renamed or
 * moved label keeps applying.
 *
 *  - member joins → every default label applied (`applySeriesLabels`);
 *  - member leaves (pattern change, manual removal, moved to another series,
 *    series deleted) → the assignments THIS series' rules made are deleted
 *    (`removeSeriesRuleLabels`);
 *  - label removed from a series → its rule AND the assignments it made go
 *    (`setSeriesLabels`);
 *  - a label someone attached by hand (how <> 'rule') is never touched: if
 *    the member already carried the label manually, the rule's insert is a
 *    no-op (ON CONFLICT DO NOTHING) and its removal never matches.
 *
 * Gone with the key-based series: the 2-member threshold, the auto-created
 * `Series/<title>` label, the rename follower and the merge path.
 *
 * Callers are the membership engine (lib/server/curated-series.ts) and the
 * series routes through it; 053 must be applied (the engine checks).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface SeriesLabelRule {
  id: number;
  label_id: number;
  /** The series id, as text (label_rules.value). */
  value: string;
  created_by: string;
  created_by_email: string;
  path: string;
  name: string;
  color: string | null;
}

/** The live default labels of these series (label joined for display). */
export async function listSeriesLabelRules(seriesIds: number[]): Promise<SeriesLabelRule[]> {
  if (seriesIds.length === 0) return [];
  return sql<SeriesLabelRule[]>`
    SELECT lr.id, lr.label_id, lr.value, lr.created_by, lr.created_by_email,
           l.path, l.name, l.color
    FROM ${sql(SCHEMA)}.label_rules lr
    JOIN ${sql(SCHEMA)}.labels l ON l.id = lr.label_id
    WHERE lr.kind = 'series'
      AND lr.enabled
      AND lr.value = ANY(${seriesIds.map(String)}::text[])
    ORDER BY lr.value, l.path_key
  `;
}

/**
 * Apply every default label of the series to its live members (all, or just
 * `transcriptIds`), how='rule' + rule_id, and write one label_add activity
 * row per assignment actually made. Attribution: the acting person when
 * known, else the rule's creator.
 */
export async function applySeriesLabels(
  seriesId: number,
  transcriptIds?: number[],
  actor?: LabelActor | null
): Promise<{ assigned: number }> {
  if (transcriptIds && transcriptIds.length === 0) return { assigned: 0 };
  const idFilter = transcriptIds ? sql`AND m.transcript_id = ANY(${transcriptIds}::int[])` : sql``;
  const actorId = actor?.userId ?? null;
  const actorEmail = actor?.email ? actor.email.trim().toLowerCase() : null;
  const inserted = await sql<
    Array<{
      transcript_id: number;
      label_id: number;
      rule_id: number;
      added_by: string;
      added_by_email: string;
      assemblyai_id: string;
      path: string;
    }>
  >`
    WITH ins AS (
      INSERT INTO ${sql(SCHEMA)}.transcript_labels
        (transcript_id, label_id, how, rule_id, added_by, added_by_email)
      SELECT m.transcript_id, lr.label_id, 'rule', lr.id,
             COALESCE(${actorId}::uuid, lr.created_by),
             COALESCE(${actorEmail}::text, lr.created_by_email)
      FROM ${sql(SCHEMA)}.series_members m
      JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id AND t.deleted_at IS NULL
      JOIN ${sql(SCHEMA)}.label_rules lr
        ON lr.kind = 'series' AND lr.value = ${String(seriesId)}
       AND lr.label_id IS NOT NULL AND lr.enabled
      WHERE m.series_id = ${seriesId} ${idFilter}
      ON CONFLICT (transcript_id, label_id) DO NOTHING
      RETURNING transcript_id, label_id, rule_id, added_by, added_by_email
    )
    SELECT ins.*, t.assemblyai_id, l.path
    FROM ins
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = ins.transcript_id
    JOIN ${sql(SCHEMA)}.labels l ON l.id = ins.label_id
  `;
  if (inserted.length === 0) return { assigned: 0 };

  try {
    const names = new Map<string, string | null>();
    for (const e of new Set(inserted.map((r) => r.added_by_email))) {
      names.set(e, await resolveDisplayName(e).catch(() => null));
    }
    await sql`
      INSERT INTO ${sql(SCHEMA)}.transcript_activity
        (transcript_id, user_id, user_email, user_name, action, details)
      SELECT r.tid, r.uid, r.email, r.name, 'label_add',
             jsonb_build_object('label_id', r.label_id, 'path', r.path,
                                'via', 'series_rule', 'series_id', ${seriesId}::int,
                                'rule_id', r.rule_id)
      FROM unnest(
        ${inserted.map((r) => r.transcript_id)}::int[],
        ${inserted.map((r) => r.added_by)}::uuid[],
        ${inserted.map((r) => r.added_by_email)}::text[],
        ${inserted.map((r) => names.get(r.added_by_email) ?? null)}::text[],
        ${inserted.map((r) => r.label_id)}::int[],
        ${inserted.map((r) => r.path)}::text[],
        ${inserted.map((r) => r.rule_id)}::int[]
      ) AS r(tid, uid, email, name, label_id, path, rule_id)
    `;
  } catch (err) {
    console.warn('[series-labels] activity write failed (labels applied):', err);
  }

  publishEvent({ kind: 'labels' });
  for (const id of new Set(inserted.map((r) => r.assemblyai_id))) {
    publishEvent({ kind: 'labels', assemblyaiId: id });
  }
  return { assigned: inserted.length };
}

/**
 * A meeting LEFT the series: delete the assignments this series' rules made
 * on it (how='rule' with one of its rule ids). Hand-made labels stay.
 */
export async function removeSeriesRuleLabels(
  seriesId: number,
  transcriptIds: number[]
): Promise<{ removed: number }> {
  if (transcriptIds.length === 0) return { removed: 0 };
  const rows = await sql<Array<{ transcript_id: number; assemblyai_id: string }>>`
    WITH del AS (
      DELETE FROM ${sql(SCHEMA)}.transcript_labels tl
      USING ${sql(SCHEMA)}.label_rules lr
      WHERE lr.id = tl.rule_id
        AND lr.kind = 'series'
        AND lr.value = ${String(seriesId)}
        AND tl.how = 'rule'
        AND tl.transcript_id = ANY(${transcriptIds}::int[])
      RETURNING tl.transcript_id
    )
    SELECT del.transcript_id, t.assemblyai_id
    FROM del JOIN ${sql(SCHEMA)}.transcripts t ON t.id = del.transcript_id
  `;
  if (rows.length > 0) {
    publishEvent({ kind: 'labels' });
    for (const id of new Set(rows.map((r) => r.assemblyai_id))) publishEvent({ kind: 'labels', assemblyaiId: id });
  }
  return { removed: rows.length };
}

/**
 * Make the series' default labels exactly `labelIds`: a new label gets a
 * rule and is applied to every member; a dropped label loses its rule and
 * every assignment that rule made. Returns what changed.
 */
export async function setSeriesLabels(
  seriesId: number,
  labelIds: number[],
  actor: LabelActor
): Promise<{ added: number[]; removed: number[] }> {
  const wanted = new Set(labelIds);
  const current = await listSeriesLabelRules([seriesId]);
  const have = new Set(current.map((r) => r.label_id));
  const drop = current.filter((r) => !wanted.has(r.label_id));
  const add = [...wanted].filter((id) => !have.has(id));

  for (const rule of drop) {
    await sql`
      DELETE FROM ${sql(SCHEMA)}.transcript_labels
      WHERE rule_id = ${rule.id} AND how = 'rule'
    `;
    await sql`DELETE FROM ${sql(SCHEMA)}.label_rules WHERE id = ${rule.id}`;
  }
  for (const labelId of add) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.label_rules (label_id, kind, value, created_by, created_by_email)
      VALUES (${labelId}, 'series', ${String(seriesId)}, ${actor.userId}, ${actor.email.trim().toLowerCase()})
      ON CONFLICT DO NOTHING
    `;
  }
  if (drop.length > 0) publishEvent({ kind: 'labels' });
  if (add.length > 0) await applySeriesLabels(seriesId, undefined, actor);
  return { added: add, removed: drop.map((r) => r.label_id) };
}

/** Series deleted: every rule of it goes (its members' rule assignments are
 * removed by the engine's leave step first; this also sweeps any left). */
export async function dropSeriesLabelRules(seriesId: number): Promise<void> {
  await sql`
    DELETE FROM ${sql(SCHEMA)}.transcript_labels tl
    USING ${sql(SCHEMA)}.label_rules lr
    WHERE lr.id = tl.rule_id AND lr.kind = 'series' AND lr.value = ${String(seriesId)}
      AND tl.how = 'rule'
  `;
  await sql`
    DELETE FROM ${sql(SCHEMA)}.label_rules
    WHERE kind = 'series' AND value = ${String(seriesId)}
  `;
}
