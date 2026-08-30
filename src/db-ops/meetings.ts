import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { GmeetContext } from '@/lib/format';

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

/**
 * T1 (migration 031): one stable uuid per meeting, independent of provider
 * id churn. transcripts.assemblyai_id gets RENAMED on placeholder promotion
 * and REPLACED on transcript-mode deferred fulfilment; `meetings` tracks the
 * current id (`transcript_id`) plus every id the meeting has ever worn
 * (`former_ids`), so `/m/<uuid>` and stale `/transcript/<old-id>` links keep
 * resolving forever.
 *
 * All writers are BEST-EFFORT from the transcripts db-ops hooks — a meetings
 * bookkeeping failure must never fail the import/upload itself. Callers in
 * db-ops/transcripts.ts wrap in try/catch; the functions here just do the SQL.
 */

export interface MeetingRow {
  id: string;
  transcript_id: string;
  former_ids: string[];
  provider: string;
  provider_key: string | null;
  title_hint: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Provider + canonical occurrence key derived from what the row carries. */
export function meetingIdentityFrom(
  assemblyaiId: string,
  ctx?: GmeetContext | null
): { provider: string; providerKey: string | null } {
  const provider = assemblyaiId.startsWith('gmeet-')
    ? 'gmeet'
    : assemblyaiId.startsWith('teams-')
      ? 'teams'
      : ctx?.provider === 'teams'
        ? 'teams'
        : ctx?.meetingCode
          ? 'gmeet'
          : 'upload';
  const providerKey = ctx?.teams?.joinWebUrl ?? ctx?.meetingCode ?? null;
  return { provider, providerKey };
}

/**
 * Idempotent per transcript identity: creates the meeting row on first
 * sight, backfills provider_key/title on later sights (never clears them).
 */
export async function ensureMeeting(input: {
  transcriptId: string;
  provider: string;
  providerKey?: string | null;
  title?: string | null;
  createdBy?: string | null;
}): Promise<MeetingRow> {
  const rows = await sql<MeetingRow[]>`
    INSERT INTO ${sql(SCHEMA)}.meetings (transcript_id, provider, provider_key, title_hint, created_by)
    VALUES (${input.transcriptId}, ${input.provider}, ${input.providerKey ?? null},
            ${input.title ?? null}, ${input.createdBy ?? null})
    ON CONFLICT (transcript_id) DO UPDATE SET
      provider_key = COALESCE(${sql(SCHEMA)}.meetings.provider_key, EXCLUDED.provider_key),
      title_hint = COALESCE(EXCLUDED.title_hint, ${sql(SCHEMA)}.meetings.title_hint),
      updated_at = now()
    RETURNING *
  `;
  return rows[0]!;
}

/**
 * A transcript identity was renamed (placeholder promotion) or replaced
 * (transcript-mode deferred fulfilment: fresh `gmeet-…` row + retired
 * placeholder). Keeps the OLDEST meeting uuid — that is the one handed out
 * at click time — and folds any row the new id already spawned (its hook
 * fires before the retire) into `former_ids`.
 */
export async function repointMeeting(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  await sql.begin(async (tx) => {
    // Lock both rows in a deterministic order so two concurrent repoints
    // (two users' placeholders fulfilling for the same final id) serialize
    // instead of deadlocking.
    const rows = await tx<MeetingRow[]>`
      SELECT * FROM ${sql(SCHEMA)}.meetings
      WHERE transcript_id IN (${fromId}, ${toId})
      ORDER BY id
      FOR UPDATE
    `;
    const from = rows.find((r) => r.transcript_id === fromId) ?? null;
    const to = rows.find((r) => r.transcript_id === toId) ?? null;

    if (!from && !to) {
      await tx`
        INSERT INTO ${sql(SCHEMA)}.meetings (transcript_id, provider, former_ids)
        VALUES (${toId}, ${meetingIdentityFrom(toId).provider}, ${sql.array([fromId])})
        ON CONFLICT (transcript_id) DO UPDATE SET
          former_ids = (
            SELECT ARRAY(SELECT DISTINCT x FROM unnest(${sql(SCHEMA)}.meetings.former_ids || ${fromId}) AS x)
          ),
          updated_at = now()
      `;
      return;
    }
    if (!from && to) {
      // The rename's source never had a row — just remember the old id.
      await tx`
        UPDATE ${sql(SCHEMA)}.meetings SET
          former_ids = ${sql.array(Array.from(new Set([...to.former_ids, fromId])))},
          updated_at = now()
        WHERE id = ${to.id}
      `;
      return;
    }
    if (from && !to) {
      // Plain rename (the common promotion path).
      await tx`
        UPDATE ${sql(SCHEMA)}.meetings SET
          transcript_id = ${toId},
          former_ids = ${sql.array(Array.from(new Set([...from.former_ids, fromId])).filter((x) => x !== toId))},
          provider = ${meetingIdentityFrom(toId).provider === 'upload' ? from.provider : meetingIdentityFrom(toId).provider},
          updated_at = now()
        WHERE id = ${from.id}
      `;
      return;
    }
    // BOTH exist: the two rows are the same meeting. Survivor = the OLDER
    // uuid (an established, possibly-shared link always outranks the row a
    // hook minted moments ago); the loser's uuid becomes an ALIAS so any
    // /m/<loser-uuid> link someone copied keeps resolving forever
    // (migration 032; review finding "usurper fold deletes established
    // stable meeting uuids").
    const older =
      new Date(from!.created_at).getTime() <= new Date(to!.created_at).getTime() ? from! : to!;
    const loser = older.id === from!.id ? to! : from!;
    const mergedFormer = Array.from(
      new Set([...from!.former_ids, ...to!.former_ids, fromId])
    ).filter((x) => x !== toId);
    await tx`
      UPDATE ${sql(SCHEMA)}.meeting_aliases SET meeting_id = ${older.id} WHERE meeting_id = ${loser.id}
    `;
    await tx`DELETE FROM ${sql(SCHEMA)}.meetings WHERE id = ${loser.id}`;
    await tx`
      INSERT INTO ${sql(SCHEMA)}.meeting_aliases (alias, meeting_id)
      VALUES (${loser.id}, ${older.id})
      ON CONFLICT (alias) DO UPDATE SET meeting_id = ${older.id}
    `;
    await tx`
      UPDATE ${sql(SCHEMA)}.meetings SET
        transcript_id = ${toId},
        former_ids = ${sql.array(mergedFormer)},
        provider = ${meetingIdentityFrom(toId).provider === 'upload' ? older.provider : meetingIdentityFrom(toId).provider},
        provider_key = COALESCE(provider_key, ${loser.provider_key}),
        title_hint = COALESCE(title_hint, ${loser.title_hint}),
        updated_at = now()
      WHERE id = ${older.id}
    `;
  });
}

/** `/m/<uuid>` lookup — falls through to the alias table (migration 032)
 * so a uuid whose row was folded into a survivor still resolves. */
export async function getMeetingById(id: string): Promise<MeetingRow | null> {
  const rows = await sql<MeetingRow[]>`
    SELECT m.* FROM ${sql(SCHEMA)}.meetings m WHERE m.id = ${id}
    UNION ALL
    SELECT m.* FROM ${sql(SCHEMA)}.meetings m
    JOIN ${sql(SCHEMA)}.meeting_aliases a ON a.meeting_id = m.id
    WHERE a.alias = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Resolve ANY id the meeting has ever had (current or former) — the
 * self-heal for stale /transcript/<old-id> links.
 */
export async function resolveMeetingByAnyTranscriptId(
  anyId: string
): Promise<MeetingRow | null> {
  const rows = await sql<MeetingRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.meetings
    WHERE transcript_id = ${anyId} OR former_ids @> ${sql.array([anyId])}
    ORDER BY (transcript_id = ${anyId}) DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Permanent-delete cleanup: drop the meeting row when its LAST transcript
 * copy is gone (a meeting whose id lives on for another user stays).
 */
export async function cleanupMeetingIfOrphan(assemblyaiId: string): Promise<void> {
  await sql`
    DELETE FROM ${sql(SCHEMA)}.meetings m
    WHERE m.transcript_id = ${assemblyaiId}
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcripts t
        WHERE t.assemblyai_id = ${assemblyaiId}
      )
  `;
}
