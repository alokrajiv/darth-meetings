import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { shareOriginColumnExists } from '@/db-ops/share-origin';
import { SHARE_ORIGIN_AUDITOR } from '@/lib/auditor-policy';

/**
 * Auditor shares (lib/auditor-policy.ts) — the writes, and the removal ledger
 * (`auditor_share_removals`, migration 052).
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

/**
 * Give each auditor a read share of the meeting — unless they already have
 * any share (an invitee's edit share is never downgraded or re-stamped), or
 * were removed from this meeting before. Returns the emails actually added.
 */
export async function addAuditorShares(
  transcriptId: number,
  ownerUserId: string,
  auditors: ReadonlyArray<{ email: string; name: string | null }>
): Promise<string[]> {
  if (auditors.length === 0) return [];
  const [ledger, origin] = await Promise.all([auditorLedgerExists(), shareOriginColumnExists()]);
  if (!ledger || !origin) return [];

  const added: string[] = [];
  for (const { email, name } of auditors) {
    const rows = await sql<Array<{ id: number }>>`
      INSERT INTO ${sql(SCHEMA)}.transcript_shares (
        transcript_id, owner_user_id, shared_by_user_id,
        shared_with_email, shared_with_name, shared_with_ppl_id, access, origin
      )
      SELECT ${transcriptId}, ${ownerUserId}, ${ownerUserId},
             ${email}, ${name}, NULL, 'read', ${SHARE_ORIGIN_AUDITOR}
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

/** Ledger one auditor removal. Called by the share DELETE route, right after
 * the share row is gone. */
export async function recordAuditorRemoval(input: {
  transcriptId: number;
  auditorEmail: string;
  removedByUserId: string;
  removedByEmail: string;
  meetingTitle: string | null;
}): Promise<void> {
  if (!(await auditorLedgerExists())) return;
  await sql`
    INSERT INTO ${sql(SCHEMA)}.auditor_share_removals (
      transcript_id, auditor_email, removed_by_user_id, removed_by_email, meeting_title
    ) VALUES (
      ${input.transcriptId}, ${input.auditorEmail.trim().toLowerCase()},
      ${input.removedByUserId}, ${input.removedByEmail.trim().toLowerCase()},
      ${input.meetingTitle}
    )
  `;
}
