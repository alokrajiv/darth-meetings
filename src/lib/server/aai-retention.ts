import 'server-only';
import { deleteTranscript } from '@/lib/server/assemblyai';
import { isAaiJobId } from '@/lib/aai-job-state';
import { getForUser, stampAaiDeleted, type TranscriptRow } from '@/db-ops/transcripts';
import { queueProviderDeletedStamp } from '@/lib/server/recording-sync';

/**
 * DEC-4 — "AssemblyAI keeps nothing of ours"
 * (docs/recordings-first-class-design.md §7).
 *
 * AAI retention is being shortened to 24 h, so two things must hold:
 *   1. a finished row is served entirely from Postgres + our own disk — no
 *      code path may ask AAI about it again (the lazy `getTranscript()`
 *      fallbacks are gone; see content/audio routes and getContentCached);
 *   2. once our copy is PROVEN safe we delete the job at AAI ourselves,
 *      rather than waiting out their clock.
 *
 * The delete is behind `MW_AAI_DELETE_ON_COMPLETE` and OFF by default. The
 * env is read lazily on every call (never at module load) so `bun run build`
 * succeeds with no environment at all, and so flipping it on the VM only
 * needs a pm2 restart.
 */

/**
 * AssemblyAI job ids are plain UUIDs. Every id we mint ourselves carries a
 * prefix instead (`up-`, `defer-`, `ext-`, `gmeet-`, `teams-`), so a UUID
 * test is the one check that stays correct when another prefix is added.
 * The test itself lives in `@/lib/aai-job-state` — the give-up rules need it
 * too and that module is pure (unit-testable); re-exported here so existing
 * importers of `isAaiJobId` are unaffected.
 */
export { isAaiJobId } from '@/lib/aai-job-state';

/** Lazy, per-call — see the module comment. */
export function deleteOnCompleteEnabled(): boolean {
  const raw = (process.env.MW_AAI_DELETE_ON_COMPLETE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export type RetentionOutcome =
  /** Job deleted at AAI (or already gone) and every copy stamped. */
  | 'deleted'
  /** Feature off, not an AAI job, or already stamped — nothing to do. */
  | 'skipped'
  /** Our copy isn't provably safe yet; refuse to delete and say why. */
  | 'unsafe'
  /** AAI refused/was unreachable; a later sweep tick retries. */
  | 'failed';

/**
 * The safety gate. Deleting at AAI is irreversible, so it only happens when
 * the row reads back with a real payload and local media. `expectedUtterances`
 * is the count the caller counted — what AAI returned in the completing poll,
 * or what the sweeper's candidate query saw. A mismatch means the row moved
 * under us between then and the re-read, so we stop.
 */
function unsafeReason(
  row: TranscriptRow,
  expectedUtterances: number | null
): string | null {
  if (row.status !== 'completed') return `status is ${row.status}`;
  const stored = row.imported_content?.utterances?.length ?? 0;
  if (stored === 0) return 'stored payload has no utterances';
  if (expectedUtterances !== null && stored !== expectedUtterances) {
    return `stored ${stored} utterances, AAI returned ${expectedUtterances}`;
  }
  if (!row.imported_content?.words?.length) return 'stored payload has no words';
  if (!row.local_audio_path) return 'no media stored locally';
  return null;
}

/**
 * Delete the AAI job behind a row that has just completed, after re-reading
 * the row and verifying our copy. Never throws: completion must not depend on
 * AAI being reachable, and a 'failed' outcome is picked up by the sweeper
 * (lib/server/auto-notes-sweeper.ts).
 *
 * One job can back several rows (`UNIQUE (user_id, assemblyai_id)` — two
 * people importing the same meeting). The delete happens once; the stamp goes
 * on every copy, which is also what makes this idempotent.
 */
export async function deleteAtAaiIfSafe(
  ownerUserId: string,
  assemblyaiId: string,
  expectedUtterances: number | null
): Promise<RetentionOutcome> {
  if (!deleteOnCompleteEnabled()) return 'skipped';
  if (!isAaiJobId(assemblyaiId)) return 'skipped';

  let row: TranscriptRow | null;
  try {
    row = await getForUser(ownerUserId, assemblyaiId);
  } catch (err) {
    console.warn(`[aai-retention] re-read failed ${assemblyaiId}:`, err);
    return 'failed';
  }
  if (!row) return 'skipped';
  if (row.gmeet_context?.aai?.deletedAt) return 'skipped';

  const reason = unsafeReason(row, expectedUtterances);
  if (reason) {
    console.warn(`[aai-retention] NOT deleting ${assemblyaiId} at AAI: ${reason}`);
    return 'unsafe';
  }

  const gone = await deleteTranscript(assemblyaiId);
  if (!gone) {
    console.warn(`[aai-retention] delete rejected by AAI ${assemblyaiId} — will retry`);
    return 'failed';
  }

  const stamp = { deletedAt: new Date().toISOString(), jobId: assemblyaiId };
  try {
    const copies = await stampAaiDeleted(assemblyaiId, stamp);
    // DEC-4's other half: one `recording_transcriptions` row holds this job
    // however many meetings point at it, so the stamp is keyed on the job id.
    queueProviderDeletedStamp(assemblyaiId, stamp.deletedAt);
    console.log(
      `[aai-retention] deleted ${assemblyaiId} at AAI (${row.imported_content?.utterances?.length ?? 0} utterances kept, ${copies} row(s) stamped)`
    );
  } catch (err) {
    // The delete already happened; losing the stamp only costs a no-op retry
    // (AAI answers 404, which deleteTranscript treats as success).
    console.warn(`[aai-retention] stamp failed after delete ${assemblyaiId}:`, err);
  }
  return 'deleted';
}

/**
 * The one line to log when a finished row has no payload. Deliberately loud
 * and uniform: under 24 h retention this is unrecoverable, so it has to be
 * greppable in the pm2 log rather than hidden behind a silent AAI refetch.
 */
export function logPayloadMissing(assemblyaiId: string, where: string): void {
  console.error(
    `[aai-retention] payload missing ${assemblyaiId} — finished row with no stored content (${where}); AssemblyAI is no longer consulted, this row cannot be served`
  );
}
