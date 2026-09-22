import 'server-only';
import { type PendingRefreshRow, updateStatusForUser } from '@/db-ops/transcripts';
import { getTranscript, isAaiNotFound } from '@/lib/server/assemblyai';
import { AAI_GONE_REASON } from '@/lib/aai-job-state';
import { giveUpOnAaiJob } from '@/lib/server/aai-giveup';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';

/**
 * Refresh rows still in flight at AssemblyAI, in parallel, patching each
 * refreshed row in place. Completed/error rows and the synthetic `up-…` /
 * `defer-…` placeholders (statuses 'uploading' / 'waiting' — AAI has never
 * heard of their ids) are skipped, so for an all-finished list this is a
 * no-op with zero network hops. Shared by the legacy full listing (which
 * passes every row) and the v2 path (which passes a dedicated pending-only
 * query's rows, decoupled from pagination), and by the notes-sweeper's resume
 * pass (rows born before this process started, whose in-process wait died
 * with the previous process — see `listStrandedAtAai`). First observed completion stores
 * the payload in the same write and fires onTranscriptCompleted (speaker
 * suggestions + the AAI-side delete, fire-and-forget).
 *
 * Two terminal outcomes are handled here rather than retried forever (DEC-4:
 * AAI keeps nothing of ours, retention is 24 h):
 *   - a job AAI has been holding past AAI_STUCK_HOURS is skipped — the
 *     5-minute sweeper flips it to 'error';
 *   - a 404 flips it right here, because that answer cannot improve.
 *
 * WHICH id is polled: the AssemblyAI JOB, never the meeting (Phase 1b — a
 * minted meeting id is UUID-shaped and AAI has never heard of it). The v2
 * path's query returns the job with each row; the legacy listing's projection
 * deliberately has no such column (its rows are the response body, byte for
 * byte, and darth-cli reads them), so it passes `lookupJobIds` and the job ids
 * are fetched — caller-scoped — only for the rows that are still in flight.
 * An all-finished listing therefore still makes zero extra queries.
 */
export async function refreshPendingAgainstAai<T extends PendingRefreshRow>(
  rows: T[],
  lookupJobIds?: (assemblyaiIds: string[]) => Promise<ReadonlyMap<string, string | null>>
): Promise<void> {
  const inFlight = (r: PendingRefreshRow) =>
    r.status !== 'completed' &&
    r.status !== 'error' &&
    r.status !== 'uploading' &&
    r.status !== 'waiting';

  const candidates = rows.map((r, i) => (inFlight(r) ? i : -1)).filter((i) => i >= 0);
  if (candidates.length === 0) return;

  // Rows whose projection carries no job id at all — see above.
  const unknown = candidates.filter((i) => rows[i]!.aai_job_id === undefined);
  const fetched =
    unknown.length > 0 && lookupJobIds
      ? await lookupJobIds(unknown.map((i) => rows[i]!.assemblyai_id))
      : null;
  // No AssemblyAI job behind the row ⇒ nothing to poll: the `up-`/`defer-`
  // placeholders whose bytes are still in our pipeline, the text-import
  // placeholders that normalize via the LLM in the background (they sit in
  // 'processing' but never reached AAI), and any meeting id we minted.
  const jobOf = (r: T): string | null =>
    r.aai_job_id !== undefined ? r.aai_job_id : (fetched?.get(r.assemblyai_id) ?? null);

  const pendingIdx = candidates.filter((i) => jobOf(rows[i]!) !== null);
  if (pendingIdx.length === 0) return;

  await Promise.all(
    pendingIdx.map(async (i) => {
      const row = rows[i]!;
      try {
        const aai = await getTranscript(jobOf(row)!);
        const speakerCount = aai.utterances
          ? new Set(aai.utterances.map((u) => u.speaker)).size
          : null;
        const completed = aai.status === 'completed';
        await updateStatusForUser(row.user_id, row.assemblyai_id, {
          status: aai.status,
          completedAt: aai.completed ? new Date(aai.completed) : null,
          duration: aai.audio_duration ?? null,
          speakerCount,
          languageCode: aai.language_code ?? null,
          // DEC-4: this poll is the last time we ever see the payload, so it
          // is stored in the same write that says 'completed'. The listing
          // used to leave that to the first content fetch, which under 24 h
          // AAI retention would eventually find nothing.
          content: completed ? aai : null,
        });
        rows[i] = {
          ...row,
          status: aai.status,
          completed_at: aai.completed ?? row.completed_at,
          duration: aai.audio_duration ?? row.duration,
          speaker_count: speakerCount ?? row.speaker_count,
        };
        // Dual-write: the listing's own completion write is a status/payload
        // change like the detail page's, and mirrors the same way.
        queueRecordingGraphSync(row.user_id, row.assemblyai_id, 'listing-refresh');
        // First observation of completion → auto-notes + speaker
        // suggestions (fire-and-forget, owner-scoped) and the AAI-side
        // delete, which verifies our copy against this utterance count.
        if (completed) {
          onTranscriptCompleted(row.user_id, row.assemblyai_id, {
            utterances: aai.utterances?.length ?? null,
          });
        }
      } catch (err) {
        // AssemblyAI does not have this job any more. Final — flip the row
        // so the listing stops showing an eternal "Transcribing…" spinner
        // and stops re-asking on every load.
        if (isAaiNotFound(err)) {
          // No row argument: the listing projection is thin on purpose, so
          // the marker's replay options are read from the full row inside.
          const flipped = await giveUpOnAaiJob(row.user_id, row.assemblyai_id, AAI_GONE_REASON);
          if (flipped) rows[i] = { ...row, status: 'error' };
          return;
        }
        console.warn('[GET /api/transcripts] refresh failed for', row.assemblyai_id, err);
      }
    })
  );
}
