import 'server-only';
import {
  getForUser,
  markAaiGaveUp,
  type StuckAaiRow,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import type { GmeetContext } from '@/lib/format';

/**
 * Giving up on an AssemblyAI job.
 *
 * Under DEC-4 (docs/recordings-first-class-design.md §7) AssemblyAI keeps
 * our jobs for 24 h, so "queued/processing" is not an open-ended state any
 * more. Two things end it badly and both land here:
 *
 *   - AAI answers 404 on the poll (`isAaiNotFound`) — the job is gone.
 *   - The job has been pending longer than AAI_STUCK_HOURS — it is never
 *     coming back. 19 prod rows had been in 'processing' since 2026-09-15.
 *
 * Both write the SAME marker a failed hand-off writes
 * (`gmeet_context.ingestFailure`, stage 'aai-job'), because that is how an
 * error reason is stored and shown today: the listing projects it as
 * `deferred_error` (db-ops/transcripts.ts), the recording strip renders it
 * (lib/recording-strip.ts) and the detail page shows it with a Retry button
 * (components/ingest-failure-note.tsx). No new column, no second convention.
 *
 * `retryable: false` / `nextAt: null` keep the automatic ingest-retry
 * sweeper off the row (`listIngestRetryRows` filters on `retryable = true`)
 * — giving up has to mean giving up — while POST
 * /api/transcripts/:id/retry-ingest, which only asks for status 'error' + an
 * ingestFailure marker, still works and re-sends the stored recording.
 */

/**
 * The columns the marker is built from. Both a full `TranscriptRow` (the
 * detail-page sync) and the sweeper's `StuckAaiRow` projection satisfy it —
 * that is what `StuckAaiRow` is projected for.
 */
export type GiveUpRow = Pick<
  TranscriptRow,
  'user_id' | 'assemblyai_id' | 'original_filename' | 'title' | 'language_code' | 'speech_model'
> &
  Partial<Pick<StuckAaiRow, 'gmeet_context'>>;

/**
 * The replay options frozen on the marker. A row that already carries an
 * `ingestFailure` (it failed a hand-off once, was retried, and THEN got
 * stuck) keeps the opts it was retried with — they are the ones that
 * actually produced the submit.
 */
function replayOpts(
  row: GiveUpRow | undefined
): NonNullable<GmeetContext['ingestFailure']>['opts'] {
  const prev = row?.gmeet_context?.ingestFailure?.opts;
  if (prev) return prev;
  return {
    originalFilename: row?.original_filename ?? null,
    languageCode: row?.language_code?.trim() || undefined,
    title: row?.title ?? null,
    speechModel: row?.speech_model?.trim() || undefined,
  };
}

/**
 * Flip a row AssemblyAI owes us an answer for to 'error' with `reason`.
 *
 * `row` is optional: callers that already hold the columns pass them (the
 * sweeper, the detail-page sync), and the listing fan-out — whose projection
 * is deliberately thin — passes nothing and the row is re-read here. The
 * re-read only ever happens on the give-up path, which is rare by
 * definition, and getting it wrong would cost the replay its filename,
 * language and speech model.
 *
 * Returns true when this call is the one that flipped it (the UPDATE is
 * guarded on queued/processing, so a row that completed in the meantime, or
 * that another worker already gave up on, answers false). Never throws.
 */
export async function giveUpOnAaiJob(
  userId: string,
  assemblyaiId: string,
  reason: string,
  known?: GiveUpRow
): Promise<boolean> {
  const now = new Date().toISOString();
  let row = known;
  if (!row) {
    try {
      row = (await getForUser(userId, assemblyaiId)) ?? undefined;
    } catch (err) {
      console.warn(`[aai-giveup] re-read failed ${assemblyaiId}:`, err);
    }
  }
  const prev = row?.gmeet_context?.ingestFailure;
  try {
    const flipped = await markAaiGaveUp(userId, assemblyaiId, {
      stage: 'aai-job',
      message: reason,
      firstAt: prev?.firstAt ?? now,
      at: now,
      attempts: (prev?.attempts ?? 0) + 1,
      nextAt: null,
      retryable: false,
      opts: replayOpts(row),
    });
    if (flipped) console.warn(`[aai-giveup] ${assemblyaiId} → error: ${reason}`);
    return flipped;
  } catch (err) {
    console.warn(`[aai-giveup] could not mark ${assemblyaiId}:`, err);
    return false;
  }
}
