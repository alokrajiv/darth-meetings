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
import { audioFileExists } from '@/lib/server/audio-storage';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import type { SpeechModel } from '@/lib/aai-language';

/**
 * Re-submits kept-failure rows (status 'error' + gmeet_context.ingestFailure,
 * see ingest.ts) to AssemblyAI. The bytes never move: the stored file IS the
 * temp file of the replay, the placeholder is promoted in place on success
 * (same /m link, same shares, recorder registry relinked), and on another
 * failure `keepFailedIngest` re-marks the row with the next backoff.
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
    if (!fresh.local_audio_path || !(await audioFileExists(fresh.local_audio_path))) {
      await markIngestFailed(
        fresh.user_id,
        fresh.assemblyai_id,
        { ...failure, retryable: false, nextAt: null, message: `${failure.message} (stored file missing)` },
        fresh.local_audio_path ?? ''
      );
      return { ok: false, error: 'Stored file is missing — cannot retry' };
    }
    if (!(await resetForIngestRetry(fresh.user_id, fresh.assemblyai_id))) {
      return { ok: false, error: 'Row changed under us' };
    }
    console.log(`[ingest-retry] ${fresh.assemblyai_id} attempt ${failure.attempts + 1} (${trigger})`);
    // Keep the stale-upload reaper off the row while AAI re-uploads.
    const heartbeat = setInterval(() => {
      void updateUploadProgress(fresh.user_id, fresh.assemblyai_id).catch(() => {});
    }, 60_000);
    heartbeat.unref?.();
    try {
      const out = await ingestLocalAudio(fresh.user_id, fresh.local_audio_path, {
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
      return { ok: false, error: message };
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    guard.running.delete(key);
  }
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
  guard.timer = setInterval(() => void tick(), TICK_MS);
  guard.timer.unref?.();
  setTimeout(() => void tick(), 90_000).unref?.();
  console.log('[ingest-retry] sweeper armed (every 5 min)');
}
