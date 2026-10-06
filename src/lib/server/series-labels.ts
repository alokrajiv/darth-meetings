import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { resolveDisplayName } from '@/db-ops/transcript-activity';
import type { LabelActor } from '@/db-ops/labels';

/**
 * Series default labels (docs/curated-series-spec.md §4, §11.5) — the
 * label-rules engine of kind 'series', curated edition.
 *
 * A series' default labels are its `label_rules` rows {kind:'series',
 * value:'<series id>', label_id NOT NULL, enabled} — any number of them
 * (migration 053 replaced 030's one-rule-per-series index with a
 * (value, label_id) one). A member carries each one with how='rule' and
 * rule_id set — but only where the series' OWNER is the meeting's owner or
 * editor, or the series is auditor-owned (§11.5: labels are global per
 * meeting and only owner/editors may change them). The rule follows
 * label_id, never the path, so a renamed or moved label keeps applying.
 *
 *  - the membership engine (lib/server/curated-series.ts) computes the rule
 *    labels every meeting SHOULD carry from ALL its series and writes the
 *    difference (`insertRuleLabels`, `deleteRuleLabels`, `repointRuleLabel`)
 *    — a meeting in two series carries both label sets;
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

/** Every live series rule (the engine's cache): rule id → series id + label. */
export async function listAllSeriesLabelRules(): Promise<
  Array<{ id: number; label_id: number; series_id: number; created_by: string; created_by_email: string }>
> {
  const rows = await sql<
    Array<{ id: number; label_id: number; value: string; created_by: string; created_by_email: string }>
  >`
    SELECT lr.id, lr.label_id, lr.value, lr.created_by, lr.created_by_email
    FROM ${sql(SCHEMA)}.label_rules lr
    WHERE lr.kind = 'series' AND lr.enabled AND lr.label_id IS NOT NULL
    ORDER BY lr.id
  `;
  return rows
    .map((r) => ({ ...r, series_id: Number(r.value) }))
    .filter((r) => Number.isInteger(r.series_id) && r.series_id > 0);
}

/**
 * Write rule labels on ONE meeting (how='rule', rule_id set) — the engine
 * decided they belong there (§11.5: a series whose owner may act on the
 * meeting). A label the meeting already carries (by hand or by another rule)
 * is left as it is (ON CONFLICT DO NOTHING). One label_add activity row per
 * assignment actually made. Attribution: the acting person when known, else
 * the rule's creator.
 */
export async function insertRuleLabels(
  transcriptId: number,
  items: ReadonlyArray<{ labelId: number; ruleId: number; seriesId: number }>,
  actor?: LabelActor | null
): Promise<{ assigned: number }> {
  if (items.length === 0) return { assigned: 0 };
  const actorId = actor?.userId ?? null;
  const actorEmail = actor?.email ? actor.email.trim().toLowerCase() : null;
  const ruleIds = items.map((i) => i.ruleId);
  const inserted = await sql<
    Array<{
      transcript_id: number;
      label_id: number;
      rule_id: number;
      added_by: string;
      added_by_email: string;
      assemblyai_id: string;
      path: string;
      series_id: string;
    }>
  >`
    WITH ins AS (
      INSERT INTO ${sql(SCHEMA)}.transcript_labels
        (transcript_id, label_id, how, rule_id, added_by, added_by_email)
      SELECT ${transcriptId}::int, lr.label_id, 'rule', lr.id,
             COALESCE(${actorId}::uuid, lr.created_by),
             COALESCE(${actorEmail}::text, lr.created_by_email)
      FROM ${sql(SCHEMA)}.label_rules lr
      WHERE lr.id = ANY(${ruleIds}::int[])
        AND lr.kind = 'series' AND lr.label_id IS NOT NULL AND lr.enabled
      ON CONFLICT (transcript_id, label_id) DO NOTHING
      RETURNING transcript_id, label_id, rule_id, added_by, added_by_email
    )
    SELECT ins.*, t.assemblyai_id, l.path, lr.value AS series_id
    FROM ins
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = ins.transcript_id
    JOIN ${sql(SCHEMA)}.labels l ON l.id = ins.label_id
    JOIN ${sql(SCHEMA)}.label_rules lr ON lr.id = ins.rule_id
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
                                'via', 'series_rule', 'series_id', r.series_id,
                                'rule_id', r.rule_id)
      FROM unnest(
        ${inserted.map((r) => r.transcript_id)}::int[],
        ${inserted.map((r) => r.added_by)}::uuid[],
        ${inserted.map((r) => r.added_by_email)}::text[],
        ${inserted.map((r) => names.get(r.added_by_email) ?? null)}::text[],
        ${inserted.map((r) => r.label_id)}::int[],
        ${inserted.map((r) => r.path)}::text[],
        ${inserted.map((r) => r.rule_id)}::int[],
        ${inserted.map((r) => Number(r.series_id))}::int[]
      ) AS r(tid, uid, email, name, label_id, path, rule_id, series_id)
    `;
  } catch (err) {
    console.warn('[series-labels] activity write failed (labels applied):', err);
  }

  publishEvent({ kind: 'labels' });
  publishEvent({ kind: 'labels', assemblyaiId: inserted[0]!.assemblyai_id });
  return { assigned: inserted.length };
}

/** Delete the assignments these series rules made on ONE meeting
 * (how='rule' only — a hand-made label is never touched). */
export async function deleteRuleLabels(transcriptId: number, ruleIds: number[]): Promise<{ removed: number }> {
  if (ruleIds.length === 0) return { removed: 0 };
  const rows = await sql<Array<{ transcript_id: number; assemblyai_id: string }>>`
    WITH del AS (
      DELETE FROM ${sql(SCHEMA)}.transcript_labels tl
      WHERE tl.transcript_id = ${transcriptId}
        AND tl.how = 'rule'
        AND tl.rule_id = ANY(${ruleIds}::int[])
      RETURNING tl.transcript_id
    )
    SELECT del.transcript_id, t.assemblyai_id
    FROM del JOIN ${sql(SCHEMA)}.transcripts t ON t.id = del.transcript_id
  `;
  if (rows.length > 0) {
    publishEvent({ kind: 'labels' });
    publishEvent({ kind: 'labels', assemblyaiId: rows[0]!.assemblyai_id });
  }
  return { removed: rows.length };
}

/** A rule label on ONE meeting whose series no longer applies it, while
 * another series still wants the same label: hand the assignment to that
 * series' rule instead of deleting and re-adding it. */
export async function repointRuleLabel(transcriptId: number, fromRuleId: number, toRuleId: number): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcript_labels
    SET rule_id = ${toRuleId}
    WHERE transcript_id = ${transcriptId} AND rule_id = ${fromRuleId} AND how = 'rule'
  `;
}

/**
 * Make the series' default labels exactly `labelIds`: a new label gets a
 * rule; a dropped label loses its rule and every assignment that rule made.
 * Applying the new rules to the members is the ENGINE's job — the caller
 * runs `reconcileSeriesMembers(seriesId)` after (lib/server/curated-series):
 * only members the series' owner may act on get them (§11.5), and a label
 * another series still wants comes straight back. Returns what changed.
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
