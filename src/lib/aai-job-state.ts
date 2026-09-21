/**
 * What "still waiting on AssemblyAI" means, when we stop waiting, and — since
 * Phase 1b — WHICH id to ask AssemblyAI about.
 *
 * Three rules live here, all pure so the pollers, the listing query and the
 * sweeper can share one definition (and so they can be unit-tested):
 *
 *   1. WHICH AssemblyAI job a row belongs to, if any: `aaiJobIdOf`. Before
 *      Phase 1b a row's meeting id WAS its job id, so "is `assemblyai_id`
 *      UUID-shaped?" answered this. It does not any more — a meeting id we
 *      mint is UUID-shaped too and AssemblyAI has never heard of it — so the
 *      job id lives in its own column and every caller goes through the
 *      accessor.
 *   2. WHICH rows are actually AAI's problem: the ones with a job id, in
 *      queued/processing. A row in 'processing' with an `ext-` id is our own
 *      text-import normaliser working — nothing to give up on.
 *   3. WHEN a submitted job has taken too long. AssemblyAI finishes a normal
 *      meeting in minutes; 19 rows sat in 'processing' in prod since
 *      2026-09-15/16 (>125 h) being re-polled on every listing load. Past
 *      AAI_STUCK_HOURS we stop polling and the sweeper flips the row to
 *      'error' with AAI_STUCK_REASON, which is a retryable state the user
 *      can drive from the detail page.
 */

/**
 * AssemblyAI job ids are plain UUIDs. Still the right test for "could this
 * string be a job id" — it is NO LONGER the test for "is this row an
 * AssemblyAI job" (that is `aaiJobIdOf`). This is the canonical copy;
 * `@/lib/server/aai-retention` re-exports it.
 */
export const AAI_JOB_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAaiJobId(id: string): boolean {
  return AAI_JOB_ID_RE.test(id);
}

/**
 * The two id columns of a `transcripts` row. `aai_job_id` is optional because
 * a projection may predate migration 045, or deliberately not select it.
 */
export interface AaiJobIdRow {
  /** The MEETING's opaque public id (URLs, edits, speaker mappings). */
  assemblyai_id: string;
  /** The AssemblyAI job (migration 045). `undefined` = not in the projection
   * / column not there yet; `null` = this row never went to AssemblyAI. */
  aai_job_id?: string | null;
}

/**
 * The job id to hand AssemblyAI for this row, or null when there is none.
 *
 * ONE accessor, because the answer stopped being derivable from the meeting
 * id: `aai_job_id` when it is set, else — only for a row that predates 1b,
 * which is exactly the case where the column is null or absent — the meeting
 * id when it is UUID-shaped. A row minted by 1b always carries its job id in
 * the column (the promote writes both in one statement, and minting is forced
 * off while the column is missing), so the fallback can never hand AssemblyAI
 * an id we invented.
 */
export function aaiJobIdOf(row: AaiJobIdRow): string | null {
  if (row.aai_job_id) return row.aai_job_id;
  return isAaiJobId(row.assemblyai_id) ? row.assemblyai_id : null;
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
  /** Migration 045; omit it and a UUID-shaped `assemblyaiId` is read as the
   * job, which is what every pre-1b row is. */
  aaiJobId?: string | null;
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
 * `true` when this row is one AssemblyAI owes us an answer for: it has a job
 * id, and it is in queued/processing. Our own placeholders and every finished
 * or failed row answer `false`.
 */
export function waitingOnAai(
  row: Pick<AaiWaitState, 'assemblyaiId' | 'aaiJobId' | 'status'>
): boolean {
  if (!awaitingAai(row.status)) return false;
  return aaiJobIdOf({ assemblyai_id: row.assemblyaiId, aai_job_id: row.aaiJobId }) !== null;
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
