import 'server-only';
import {
  clearIngestFailure,
  getForUser,
  listIngestRetryRows,
  markIngestFailed,
  resetForIngestRetry,
  updateUploadProgress,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import { relinkRecordingTranscript } from '@/db-ops/recorder';
import { copyPathToAudioTemp, deleteAudioFile } from '@/lib/server/audio-storage';
import { storedFileSource, withHeldStoredFiles } from '@/lib/server/stored-media';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';
import { borrowedMediaReason, madeFromRecordingId } from '@/lib/made-early';
import type { SpeechModel } from '@/lib/aai-language';
import { unlessDraining } from '@/lib/server/deploy-drain';

/**
 * Re-submits kept-failure rows (status 'error' + gmeet_context.ingestFailure,
 * see ingest.ts) to AssemblyAI. The bytes never move: the stored file IS the
 * temp file of the replay, the placeholder is promoted in place on success
 * (same /m link, same shares, recorder registry relinked), and on another
 * failure `keepFailedIngest` re-marks the row with the next backoff.
 *
 * The row handed to `ingestLocalAudio` as the "placeholder" is whatever the
 * meeting is called now, which is not always a `up-`/`defer-` id: a row the
 * AAI sweeper gave up on carries a promoted id, and since Phase 1b a minted
 * one. `promoteUploadingRow` keeps a non-placeholder id as it is, so a retry
 * puts a SECOND job id on the SAME meeting instead of renaming it — the file
 * on disk, the /m link and every share stay where they are.
 *
 * A meeting that BORROWS its media (made from a recording, or split off
 * another meeting — lib/made-early.ts) is never re-ingested: its
 * `local_audio_path` is someone else's file, and `ingestLocalAudio` would
 * send it to AssemblyAI a second time and rename it after this meeting (prod
 * 2026-10-02: the recording's canonical file was renamed out from under its
 * media row). A meeting made from a recording is retried THROUGH the
 * recording instead (`retryRecordingForMeeting`).
 *
 * Runs every TICK_MS from instrumentation.ts; `retryIngest` is also called on
 * demand by POST /api/transcripts/:id/retry-ingest. One row at a time — the
 * AAI upload leg of a multi-GB file is minutes long and the sweeper must not
 * pile a second copy of it on the VM.
 */

const TICK_MS = 5 * 60 * 1000;
const BATCH = 5;

type Guard = { timer: ReturnType<typeof setInterval> | null; running: Set<string> };
// Next.js bundles server modules more than once (route chunks + instrumentation),
// so a module-level guard would be duplicated — keep it on globalThis.
const g = globalThis as unknown as { __mwIngestRetry?: Guard };
const guard: Guard = (g.__mwIngestRetry ??= { timer: null, running: new Set() });

export type RetryOutcome = { ok: true; id: string } | { ok: false; error: string };

export async function retryIngest(
  row: Pick<TranscriptRow, 'user_id' | 'assemblyai_id'>,
  trigger: 'sweeper' | 'manual'
): Promise<RetryOutcome> {
  const key = `${row.user_id}:${row.assemblyai_id}`;
  if (guard.running.has(key)) return { ok: false, error: 'A retry is already running' };
  guard.running.add(key);
  try {
    const fresh = await getForUser(row.user_id, row.assemblyai_id);
    const failure = fresh?.gmeet_context?.ingestFailure;
    if (!fresh || fresh.status !== 'error' || !failure) {
      return { ok: false, error: 'Not a failed hand-off any more' };
    }
    const borrowed = borrowedMediaReason(fresh);
    if (borrowed) return await retryBorrower(fresh, borrowed, trigger);
    const source = fresh.local_audio_path ? await storedFileSource(fresh.local_audio_path) : null;
    if (!fresh.local_audio_path || !source?.held) {
      await markIngestFailed(
        fresh.user_id,
        fresh.assemblyai_id,
        { ...failure, retryable: false, nextAt: null, message: `${failure.message} (stored file missing)` },
        fresh.local_audio_path ?? ''
      );
      return { ok: false, error: 'Stored file is missing — cannot retry' };
    }
    // Stage D: the local copy was evicted but the bytes are archived. The
    // ingest treats its input as a temp (rewrites, renames, deletes it), so it
    // is handed a fresh COPY under the audio dir — never the media-cache entry
    // — made while the pulled file is held, and released straight after.
    let ingestInput = fresh.local_audio_path;
    if (source.localBytes === null) {
      const copied = await withHeldStoredFiles([source.media], 'canonical', 'ingest-retry', ([local]) =>
        copyPathToAudioTemp(local!.path)
      ).catch((err) => {
        console.warn(`[ingest-retry] ${fresh.assemblyai_id}: archived copy could not be fetched:`, err);
        return { ok: false as const };
      });
      if (!copied.ok) {
        // Transient (the archive or the cache): the row stays retryable and
        // the sweeper's backoff tries again.
        return { ok: false, error: 'The archived recording could not be fetched — try again in a few minutes' };
      }
      ingestInput = copied.value;
    }
    if (!(await resetForIngestRetry(fresh.user_id, fresh.assemblyai_id))) {
      if (ingestInput !== fresh.local_audio_path) await deleteAudioFile(ingestInput).catch(() => {});
      return { ok: false, error: 'Row changed under us' };
    }
    console.log(`[ingest-retry] ${fresh.assemblyai_id} attempt ${failure.attempts + 1} (${trigger})`);
    // Keep the stale-upload reaper off the row while AAI re-uploads.
    const heartbeat = setInterval(() => {
      void updateUploadProgress(fresh.user_id, fresh.assemblyai_id).catch(() => {});
    }, 60_000);
    heartbeat.unref?.();
    try {
      const out = await ingestLocalAudio(fresh.user_id, ingestInput, {
        originalFilename: failure.opts.originalFilename,
        languageCode: failure.opts.languageCode,
        title: failure.opts.title ?? fresh.title ?? null,
        extraKeyterms: failure.opts.extraKeyterms,
        speechModel: failure.opts.speechModel as SpeechModel | undefined,
        gmeetContext: fresh.gmeet_context,
        placeholderAssemblyaiId: fresh.assemblyai_id,
      });
      await clearIngestFailure(fresh.user_id, out.assemblyai_id);
      const relinked = await relinkRecordingTranscript(fresh.assemblyai_id, out.assemblyai_id).catch(
        () => 0
      );
      // `ingestLocalAudio` already synced the promoted row; the recorder
      // relink happens after it and changes `recorder_recording_id`.
      if (relinked) queueRecordingGraphSync(fresh.user_id, out.assemblyai_id, 'ingest-retry/relink');
      console.log(
        `[ingest-retry] ${fresh.assemblyai_id} → ${out.assemblyai_id} submitted` +
          (relinked ? ` (recorder registry relinked ×${relinked})` : '')
      );
      return { ok: true, id: out.assemblyai_id };
    } catch (err) {
      if (err instanceof IngestError && err.keptRow) {
        return { ok: false, error: err.keptRow.gmeet_context?.ingestFailure?.message ?? err.message };
      }
      // Anything else (DB hiccup, ffmpeg) — never leave the row at 'uploading'
      // for the reaper: put the marker back with the next backoff.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ingest-retry] ${fresh.assemblyai_id} crashed:`, err);
      await markIngestFailed(
        fresh.user_id,
        fresh.assemblyai_id,
        {
          ...failure,
          at: new Date().toISOString(),
          attempts: failure.attempts + 1,
          nextAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          message: message.slice(0, 300),
        },
        fresh.local_audio_path
      ).catch(() => {});
      // The row is back at 'error' under its placeholder id — mirror the
      // status so the transcription does not sit at 'processing' forever.
      queueRecordingGraphSync(fresh.user_id, fresh.assemblyai_id, 'ingest-retry/failed');
      return { ok: false, error: message };
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    guard.running.delete(key);
  }
}

/**
 * Retry for a meeting whose bytes and text belong to something else. Never
 * calls `ingestLocalAudio`. The sweeper leaves these alone entirely: a
 * borrower's failure is settled by its recording (the born-bare sweeper and
 * the settle), and re-sending a recording AssemblyAI failed is a human's call.
 */
async function retryBorrower(
  row: TranscriptRow,
  reason: 'made-from-recording' | 'split',
  trigger: 'sweeper' | 'manual'
): Promise<RetryOutcome> {
  if (reason === 'split') {
    return {
      ok: false,
      error: 'This meeting was split off another one — its recording and text belong to that meeting; retry it there.',
    };
  }
  if (trigger === 'sweeper') {
    return { ok: false, error: 'Made from a recording — settled by the recording, not re-sent' };
  }
  const recordingId = madeFromRecordingId(row)!;
  const { retryRecordingForMeeting } = await import('@/lib/server/born-bare');
  const out = await retryRecordingForMeeting(row.user_id, recordingId);
  console.log(
    `[ingest-retry] ${row.assemblyai_id} made from recording ${recordingId} (${trigger}): ${out.kind}`
  );
  if (out.kind === 'settled' || out.kind === 'retrying') return { ok: true, id: row.assemblyai_id };
  return { ok: false, error: out.message };
}

async function tick(): Promise<void> {
  let rows: TranscriptRow[];
  try {
    rows = await listIngestRetryRows(BATCH);
  } catch (err) {
    console.warn('[ingest-retry] query failed:', err);
    return;
  }
  for (const row of rows) {
    const out = await retryIngest(row, 'sweeper');
    if (!out.ok) console.log(`[ingest-retry] ${row.assemblyai_id}: ${out.error}`);
  }
}

export function startIngestRetrySweeper(): void {
  if (guard.timer) return;
  guard.timer = setInterval(unlessDraining('ingest-retry', tick), TICK_MS);
  guard.timer.unref?.();
  setTimeout(unlessDraining('ingest-retry', tick), 90_000).unref?.();
  console.log('[ingest-retry] sweeper armed (every 5 min)');
}
