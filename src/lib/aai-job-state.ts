/**
 * What "still waiting on AssemblyAI" means, and when we stop waiting.
 *
 * Two rules live here, both pure so the pollers, the listing query and the
 * sweeper can share one definition (and so they can be unit-tested):
 *
 *   1. WHICH rows are actually AAI's problem. Every id we mint ourselves
 *      carries a prefix (`up-`, `defer-`, `ext-`, `gmeet-`, `teams-`), so a
 *      UUID test is the one check that stays correct when another prefix is
 *      added. A row in 'processing' with an `ext-` id is our own text-import
 *      normaliser working — nothing to give up on.
 *   2. WHEN a submitted job has taken too long. AssemblyAI finishes a normal
 *      meeting in minutes; 19 rows sat in 'processing' in prod since
 *      2026-09-15/16 (>125 h) being re-polled on every listing load. Past
 *      AAI_STUCK_HOURS we stop polling and the sweeper flips the row to
 *      'error' with AAI_STUCK_REASON, which is a retryable state the user
 *      can drive from the detail page.
 */

/**
 * AssemblyAI job ids are plain UUIDs — see rule 1 above. This is the
 * canonical copy; `@/lib/server/aai-retention` re-exports it.
 */
export const AAI_JOB_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAaiJobId(id: string): boolean {
  return AAI_JOB_ID_RE.test(id);
}

/** The two statuses that mean "submitted, AssemblyAI owes us an answer". */
export const AAI_PENDING_STATUSES = ['queued', 'processing'] as const;

export function awaitingAai(status: string): boolean {
  return (AAI_PENDING_STATUSES as readonly string[]).includes(status);
}

/** How long a submitted job may sit in queued/processing before we give up. */
export const AAI_STUCK_HOURS = 6;
export const AAI_STUCK_MS = AAI_STUCK_HOURS * 3600_000;

/** Reason written on the row when AssemblyAI 404s the job. */
export const AAI_GONE_REASON = 'This job no longer exists at AssemblyAI';

/** Reason written on the row when the job never came back. */
export const AAI_STUCK_REASON =
  `Stuck at AssemblyAI for over ${AAI_STUCK_HOURS} hours — gave up. ` +
  'Retry re-sends the stored recording.';

export interface AaiWaitState {
  assemblyaiId: string;
  status: string;
  /**
   * When the job started waiting on AssemblyAI. The server passes
   * `COALESCE(upload_progress_at, created_at)` where it has it (the last
   * heartbeat before the submit — the bytes may have been streaming for
   * hours before AAI ever saw them) and `created_at` where the column is not
   * in the projection.
   */
  waitingSince: string | Date | null;
}

/**
 * `true` when this row is one AssemblyAI owes us an answer for: a real AAI
 * job id, in queued/processing. Our own placeholders and every finished or
 * failed row answer `false`.
 */
export function waitingOnAai(row: Pick<AaiWaitState, 'assemblyaiId' | 'status'>): boolean {
  return awaitingAai(row.status) && isAaiJobId(row.assemblyaiId);
}

function msOf(when: string | Date | null): number | null {
  if (when === null) return null;
  const t = when instanceof Date ? when.getTime() : Date.parse(when);
  return Number.isFinite(t) ? t : null;
}

/**
 * `true` when the row has been waiting on AssemblyAI for longer than
 * AAI_STUCK_HOURS. An unparseable/absent `waitingSince` answers `false`:
 * without an age we never give up on a row.
 */
export function stuckAtAai(row: AaiWaitState, now: number = Date.now()): boolean {
  if (!waitingOnAai(row)) return false;
  const since = msOf(row.waitingSince);
  if (since === null) return false;
  return now - since > AAI_STUCK_MS;
}
