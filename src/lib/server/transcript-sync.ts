import 'server-only';
import { getTranscript, isAaiNotFound } from '@/lib/server/assemblyai';
import { updateStatusForUser, type TranscriptRow } from '@/db-ops/transcripts';
import { AAI_GONE_REASON, aaiJobIdOf } from '@/lib/aai-job-state';
import { giveUpOnAaiJob } from '@/lib/server/aai-giveup';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';

/**
 * If the stored row is still queued/processing, fetch the latest state from
 * AssemblyAI and persist it. Returns the (possibly updated) row. Swallows
 * upstream errors so a transient AAI hiccup doesn't break the list endpoint.
 *
 * Three things stop the poll before it reaches AAI: a terminal status, a row
 * with no AssemblyAI job to poll (`ext-…`, `gmeet-…`, `teams-…`), a
 * TRASHED row (opening `/transcript/<id>` of a soft-deleted pending row used
 * to poll AssemblyAI on every load — `resolveAccess` does not filter
 * `deleted_at`, by design, so the guard lives here). Jobs pending past AAI_STUCK_HOURS are
 * flipped to 'error' by the 5-minute sweeper (lib/server/auto-notes-sweeper.ts). A 404 from AAI is handled inline —
 * under 24 h retention that answer is final, not a blip.
 */
export async function refreshIfPending(
  userId: string,
  row: TranscriptRow
): Promise<TranscriptRow> {
  // 'uploading' / 'waiting' rows have a synthetic `up-…` / `defer-…` id that
  // AAI has never heard of — nothing to refresh until they're promoted.
  if (
    row.status === 'completed' ||
    row.status === 'error' ||
    row.status === 'uploading' ||
    row.status === 'waiting'
  ) {
    return row;
  }

  // …and neither has it heard of `ext-…` (text imports normalising in the
  // background sit in 'processing'), `gmeet-…` or `teams-…`. The listing
  // fan-out already excluded those by id; this path never did. Since Phase 1b
  // the question is "does this row have a JOB", not "is its id UUID-shaped" —
  // a minted meeting id is UUID-shaped and AAI has never heard of it either.
  const jobId = aaiJobIdOf(row);
  if (!jobId) return row;

  // In the trash: nobody is waiting for this status, and 19 prod rows sat
  // here burning an AAI call per page open.
  if (row.deleted_at) return row;

  // No age guard here on purpose: a row re-sent by Retry keeps its old
  // created_at (only upload_progress_at moves), so an age test on created_at
  // would stop polling a job that was submitted a minute ago. Stuck jobs are
  // flipped to 'error' by the sweeper within five minutes, which ends the
  // polling through the status check above.

  try {
    const aai = await getTranscript(jobId);
    const speakerCount = aai.utterances
      ? new Set(aai.utterances.map((u) => u.speaker)).size
      : null;

    const completed = aai.status === 'completed';
    const updated = await updateStatusForUser(userId, row.assemblyai_id, {
      status: aai.status,
      completedAt: aai.completed ? new Date(aai.completed) : null,
      duration: aai.audio_duration ?? null,
      speakerCount,
      languageCode: aai.language_code ?? null,
      // DEC-4: the payload is written in the SAME statement that flips the
      // row to completed — never lazily on the first content fetch. It is
      // also the only record of what AAI actually DID (which model ran,
      // which language it chose, which warnings it raised —
      // lib/aai-outcome.ts), and after this poll we never ask AAI again.
      content: completed ? aai : null,
    });

    // First observation of the completed state → the post-completion hook
    // (speaker suggestions, ID pass) and the AAI-side delete, both
    // fire-and-forget. The observed utterance count travels with it so the
    // delete can prove our copy matches what AAI returned.
    if (completed) {
      onTranscriptCompleted(userId, row.assemblyai_id, {
        utterances: aai.utterances?.length ?? null,
      });
    }
    // Dual-write: the transcription's status, payload and completed_at come
    // from the row that was just written, so the sync re-reads and copies
    // `imported_content` inside Postgres.
    if (updated) queueRecordingGraphSync(userId, row.assemblyai_id, 'transcript-sync');
    if (completed && updated) return { ...updated, imported_content: aai };

    return updated ?? row;
  } catch (error) {
    // AAI no longer has the job. Terminal under DEC-4 — stop re-asking.
    if (isAaiNotFound(error)) {
      // `userId` is always the OWNER (resolveAccess hands us ownerUserId) —
      // the same scoping updateStatusForUser above writes under. The row is
      // already loaded, so no re-read.
      const flipped = await giveUpOnAaiJob(userId, row.assemblyai_id, AAI_GONE_REASON, row);
      return flipped ? { ...row, status: 'error' } : row;
    }
    console.warn('[transcript-sync] refresh failed:', error);
    return row;
  }
}
