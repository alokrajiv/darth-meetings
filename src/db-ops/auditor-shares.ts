import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { shareOriginColumnExists } from '@/db-ops/share-origin';
import { SHARE_ORIGIN_AUDITOR, SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';
import { curatedSeriesReady } from '@/db-ops/curated-series-schema';

/**
 * Automatic READ shares — the auditors' (lib/auditor-policy.ts) and, since
 * curated series (docs/curated-series-spec.md §5), a series follower's — the
 * writes, and the removal ledger (`auditor_share_removals`, migration 052;
 * 053 added its `origin` column). One writer for both: same shape, same
 * guard, same rule that a person taken off a meeting is never put back by
 * automation.
 *
 * Probed once per process like share-origin.ts: until 052 is applied there is
 * no ledger, and without one a removal could not be respected — so the
 * auto-add does nothing at all rather than re-adding someone an owner took
 * off. Never at module scope (`bun run build` runs with no database).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

const g = globalThis as unknown as { __mwAuditorLedger?: Promise<boolean> };

export function auditorLedgerExists(): Promise<boolean> {
  return (g.__mwAuditorLedger ??= (async () => {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_name = 'auditor_share_removals'
    `;
    const present = (rows[0]?.n ?? 0) > 0;
    if (!present) {
      console.warn(
        '[auditor-share] table missing — apply migrations/052_auditor_share_removals.sql; ' +
          'auditors are not auto-added until then'
      );
    }
    return present;
  })().catch((err) => {
    g.__mwAuditorLedger = undefined;
    throw err;
  }));
}

/** The two automatic read-share origins this module writes. */
export type AutoReadShareOrigin = typeof SHARE_ORIGIN_AUDITOR | typeof SHARE_ORIGIN_SERIES_FOLLOW;

/**
 * Give each person a read share of the meeting stamped with `origin` —
 * unless they already have any share (an invitee's edit share is never
 * downgraded or re-stamped: ON CONFLICT DO NOTHING), or the ledger has ANY
 * removal row for (meeting, email) — whoever removed them, from whichever
 * automatic share, no automation adds them back. The caller leaves the
 * meeting's owner out. Returns the emails actually added.
 *
 * No ledger (052) or no origin column (048) → nobody is added: a removal
 * could not be respected, nor could the share be told apart later.
 */
export async function addAutoReadShares(
  transcriptId: number,
  ownerUserId: string,
  people: ReadonlyArray<{ email: string; name: string | null }>,
  origin: AutoReadShareOrigin
): Promise<string[]> {
  if (people.length === 0) return [];
  const [ledger, originCol] = await Promise.all([auditorLedgerExists(), shareOriginColumnExists()]);
  if (!ledger || !originCol) return [];

  const added: string[] = [];
  for (const person of people) {
    const email = person.email.trim().toLowerCase();
    if (!email) continue;
    const rows = await sql<Array<{ id: number }>>`
      INSERT INTO ${sql(SCHEMA)}.transcript_shares (
        transcript_id, owner_user_id, shared_by_user_id,
        shared_with_email, shared_with_name, shared_with_ppl_id, access, origin
      )
      SELECT ${transcriptId}, ${ownerUserId}, ${ownerUserId},
             ${email}, ${person.name}, NULL, 'read', ${origin}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.auditor_share_removals r
        WHERE r.transcript_id = ${transcriptId} AND r.auditor_email = ${email}
      )
      ON CONFLICT (transcript_id, shared_with_email) DO NOTHING
      RETURNING id
    `;
    if (rows.length > 0) added.push(email);
  }
  if (added.length > 0) publishEvent({ kind: 'shares' });
  return added;
}

/**
 * Give each auditor a read share of the meeting — unless they already have
 * any share, or were removed from this meeting before. Returns the emails
 * actually added. (The auditor arm of `addAutoReadShares`.)
 */
export function addAuditorShares(
  transcriptId: number,
  ownerUserId: string,
  auditors: ReadonlyArray<{ email: string; name: string | null }>
): Promise<string[]> {
  return addAutoReadShares(transcriptId, ownerUserId, auditors, SHARE_ORIGIN_AUDITOR);
}

/**
 * Take automatic shares of one origin back off meetings — the follow shares
 * of a series' followers when a meeting leaves the series or a follower is
 * removed. Only rows stamped `origin` go: a share a person made, an
 * invitee's share or an auditor share of the same person is never touched.
 * Not ledgered — this is the automation undoing itself, not a person's
 * "no". Returns the (transcript, email) pairs removed.
 */
export async function removeAutoReadShares(input: {
  transcriptIds: number[];
  emails: string[];
  origin: AutoReadShareOrigin;
}): Promise<Array<{ transcript_id: number; shared_with_email: string }>> {
  const ids = [...new Set(input.transcriptIds)];
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0 || emails.length === 0) return [];
  if (!(await shareOriginColumnExists().catch(() => false))) return [];
  const rows = await sql<Array<{ transcript_id: number; shared_with_email: string }>>`
    DELETE FROM ${sql(SCHEMA)}.transcript_shares
    WHERE transcript_id = ANY(${ids}::int[])
      AND lower(shared_with_email) = ANY(${emails}::text[])
      AND origin = ${input.origin}
    RETURNING transcript_id, shared_with_email
  `;
  if (rows.length > 0) publishEvent({ kind: 'shares' });
  return rows;
}

/** Ledger one removal of an automatic share (auditor or follow). Called by
 * the share DELETE route, right after the share row is gone. The `origin`
 * column exists from 053 on; before that every ledger row is an auditor's. */
export async function recordAutoShareRemoval(input: {
  transcriptId: number;
  email: string;
  origin: AutoReadShareOrigin;
  removedByUserId: string;
  removedByEmail: string;
  meetingTitle: string | null;
}): Promise<void> {
  if (!(await auditorLedgerExists())) return;
  const withOrigin = await curatedSeriesReady().catch(() => false);
  if (!withOrigin && input.origin !== SHARE_ORIGIN_AUDITOR) {
    // Without 053 a follow share cannot exist; never ledger it as an
    // auditor's by accident.
    return;
  }
  await sql`
    INSERT INTO ${sql(SCHEMA)}.auditor_share_removals (
      transcript_id, auditor_email, removed_by_user_id, removed_by_email, meeting_title
      ${withOrigin ? sql`, origin` : sql``}
    ) VALUES (
      ${input.transcriptId}, ${input.email.trim().toLowerCase()},
      ${input.removedByUserId}, ${input.removedByEmail.trim().toLowerCase()},
      ${input.meetingTitle}
      ${withOrigin ? sql`, ${input.origin}` : sql``}
    )
  `;
}

/** Ledger one auditor removal (the auditor arm of recordAutoShareRemoval). */
export function recordAuditorRemoval(input: {
  transcriptId: number;
  auditorEmail: string;
  removedByUserId: string;
  removedByEmail: string;
  meetingTitle: string | null;
}): Promise<void> {
  return recordAutoShareRemoval({
    transcriptId: input.transcriptId,
    email: input.auditorEmail,
    origin: SHARE_ORIGIN_AUDITOR,
    removedByUserId: input.removedByUserId,
    removedByEmail: input.removedByEmail,
    meetingTitle: input.meetingTitle,
  });
}
