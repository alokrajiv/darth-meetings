import 'server-only';
import {
  createForUser,
  getForUser,
  markIngestFailed,
  promoteUploadingRow,
  setLocalAudioPathForUser,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import { uploadFile, submitTranscription } from '@/lib/server/assemblyai';
import type { SpeechModel } from '@/lib/aai-language';
import {
  audioFilename,
  deleteAudioFile,
  renameAudioFile,
  resolveAudioPath,
} from '@/lib/server/audio-storage';
import { getForUser as getUserVocab } from '@/db-ops/user-vocab';
import { getCurrentPayload as getOrgVocabPayload } from '@/db-ops/org-vocab';
import { mergeVocabs } from '@/lib/server/vocab-merge';
import { sniffMediaExtension } from '@/lib/server/video-frames';
import { normalizeMultiTrack } from '@/lib/server/multitrack';
import { autoAttachSeries } from '@/lib/server/series-attach';
import { prepareMediaForPlayback } from '@/lib/server/media-sweeper';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';
import { mintedIdsEnabled } from '@/db-ops/aai-job-id';
import { newMeetingId } from '@/lib/meeting-ids';
import type { GmeetContext } from '@/lib/format';

/**
 * Shared ingestion tail for audio that has already landed as a temp file in
 * the audio dir: upload to AssemblyAI (disk-streamed), submit transcription
 * with merged vocab bias, create the DB row, and rename the temp file to its
 * permanent `<meeting id>.<ext>` name — the MEETING's id, which since Phase
 * 1b is only the AssemblyAI job id for rows minting did not touch.
 *
 * Used by both the raw-body upload route (POST /api/transcripts) and the
 * Google Meet import route (which downloads the bytes from Drive first).
 *
 * On failure an IngestError is thrown carrying the stage, so callers can map
 * it to a precise HTTP response. When the call had a placeholder row, the
 * failure is KEPT instead of thrown away (`keptRow`): the bytes are renamed
 * under the placeholder id, the row flips to 'error' with an ingestFailure
 * marker, and the ingest-retry sweeper re-submits it later. Without a
 * placeholder (Meet/Teams import paths) the temp file is deleted as before.
 *
 * Why: on 2026-09-16 AssemblyAI's balance went negative for an afternoon and a
 * colleague's 147 MB recording was accepted, rejected at submit, and vanished
 * from the listing — "it should have just been failed transcribe and be
 * there" (Alok).
 */

export class IngestError extends Error {
  constructor(
    public stage: 'aai-upload' | 'aai-submit',
    message: string,
    public causeErr?: unknown,
    /** Set when the failure was kept as a visible 'error' row owning the file. */
    public keptRow?: TranscriptRow
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/** Retry backoff: 5, 10, 20, 40 min, then hourly; give up after 72 h. */
const RETRY_GIVE_UP_MS = 72 * 3600_000;
function retryDelayMs(attempts: number): number {
  return Math.min(60, 5 * 2 ** Math.max(0, attempts - 1)) * 60_000;
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  return (raw || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Keep a failed hand-off: file → `<placeholderId><ext>`, row → 'error' with
 * the retry marker. Returns null when there is no placeholder to keep it on
 * (or the placeholder is gone), in which case the caller deletes the file.
 */
async function keepFailedIngest(
  userId: string,
  tempFilename: string,
  opts: IngestOptions,
  stage: 'aai-upload' | 'aai-submit',
  causeErr: unknown
): Promise<TranscriptRow | null> {
  const placeholderId = opts.placeholderAssemblyaiId;
  if (!placeholderId) return null;
  const existing = await getForUser(userId, placeholderId);
  if (!existing) return null;
  const prev = existing.gmeet_context?.ingestFailure;
  const now = new Date();
  const firstAt = prev?.firstAt ?? now.toISOString();
  const attempts = (prev?.attempts ?? 0) + 1;
  const retryable = now.getTime() - new Date(firstAt).getTime() < RETRY_GIVE_UP_MS;
  let filename = audioFilename(placeholderId, opts.originalFilename);
  if (filename.endsWith('.bin')) {
    const sniffed = await sniffMediaExtension(tempFilename).catch(() => null);
    if (sniffed) filename = `${placeholderId}${sniffed}`;
  }
  if (filename !== tempFilename) await renameAudioFile(tempFilename, filename);
  const row = await markIngestFailed(
    userId,
    placeholderId,
    {
      stage,
      message: errorText(causeErr),
      firstAt,
      at: now.toISOString(),
      attempts,
      nextAt: retryable ? new Date(now.getTime() + retryDelayMs(attempts)).toISOString() : null,
      retryable,
      opts: {
        originalFilename: opts.originalFilename,
        languageCode: opts.languageCode,
        title: opts.title ?? null,
        extraKeyterms: opts.extraKeyterms,
        speechModel: opts.speechModel,
      },
    },
    filename
  );
  if (!row) {
    // Placeholder reaped between the check and the update: nothing owns the
    // file any more — hand it back under the temp name for the caller's delete.
    if (filename !== tempFilename) await renameAudioFile(filename, tempFilename).catch(() => {});
    return null;
  }
  console.warn(
    `[ingest] ${stage} failed — kept as ${row.assemblyai_id} (attempt ${attempts}, ` +
      `${retryable ? 'retry ' + row.gmeet_context?.ingestFailure?.nextAt : 'gave up'}): ${errorText(causeErr)}`
  );
  // The placeholder now OWNS bytes, so it stops being an empty placeholder
  // and earns a recording. When the retry sweeper later promotes it to the
  // real AssemblyAI id, the sync migrates that recording rather than leaving
  // a second one behind (db-ops/recordings.ts `applyRecordingGraph`).
  queueRecordingGraphSync(userId, row.assemblyai_id, 'ingest/kept-failure');
  return row;
}

/**
 * The recognition-bias hints for one submit: org + user vocab merged, plus
 * whatever extra phrases the caller has (attendee names from the calendar
 * event). Failures are non-fatal — we still submit, just without the bias.
 *
 * Shared with the Phase 2 re-run path (lib/server/transcription-runs.ts): a
 * new transcription of the same recording must be biased exactly as the first
 * one was, or the two versions would differ for a reason nobody asked for.
 * The ENGLISH-only gate on `keyterms_prompt` is applied further down, in
 * `submitTranscription`, where the language is known.
 */
export async function vocabForSubmit(
  userId: string,
  extraKeyterms?: string[]
): Promise<{
  keytermsPrompt: string[] | undefined;
  customSpelling: ReturnType<typeof mergeVocabs>['custom_spelling'] | undefined;
}> {
  let keytermsPrompt: string[] | undefined;
  let customSpelling: ReturnType<typeof mergeVocabs>['custom_spelling'] | undefined;
  try {
    const [orgVocabPayload, userVocab] = await Promise.all([
      getOrgVocabPayload(),
      getUserVocab(userId),
    ]);
    const merged = mergeVocabs(orgVocabPayload, userVocab);
    keytermsPrompt = merged.keyterms_prompt;
    customSpelling = merged.custom_spelling;
  } catch (error) {
    console.warn('[ingest] vocab merge failed (continuing without):', error);
  }

  if (extraKeyterms && extraKeyterms.length > 0) {
    const seen = new Set((keytermsPrompt ?? []).map((t) => t.toLowerCase()));
    const extras = extraKeyterms
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !seen.has(t.toLowerCase()));
    keytermsPrompt = [...(keytermsPrompt ?? []), ...extras].slice(0, 1000);
  }
  return { keytermsPrompt, customSpelling };
}

export interface IngestOptions {
  originalFilename: string | null;
  languageCode?: string;
  title?: string | null;
  /**
   * Extra recognition-bias phrases appended to the merged org+user vocab —
   * e.g. attendee names from the source calendar event. Deduped, capped at
   * AAI's 1000-term limit.
   */
  extraKeyterms?: string[];
  driveFileId?: string | null;
  gmeetContext?: GmeetContext | null;
  /**
   * The `up-<uuid>` id of a live-visibility placeholder row created before
   * the bytes arrived. When set, the placeholder is promoted in place (its
   * assemblyai_id rewritten to the real one, shares intact) instead of
   * inserting a new row.
   */
  placeholderAssemblyaiId?: string | null;
  /** AAI speech model override (re-transcribe-with-newer-model); default = current. */
  speechModel?: SpeechModel;
  /** Temporary transcript (migration 042). A promoted placeholder already
   * carries the flag; this is for the fresh-insert fallback when the
   * placeholder was reaped mid-upload. */
  scratch?: boolean;
}

/**
 * The half of the ingest that has nothing to do with a local file: bias the
 * submit with the merged vocab and hand AssemblyAI a URL it can read.
 *
 * `audioUrl` is AssemblyAI's own upload URL on the local-file path and a
 * read SAS on the permanent media blob under DEC-3 Stage C
 * (`lib/server/aai-from-blob.ts`) — AssemblyAI cannot tell the difference and
 * neither can anything below this line. Throws the raw error: both callers
 * have their own idea of what to keep when a submit fails.
 */
export async function submitForIngest(
  userId: string,
  audioUrl: string,
  opts: IngestOptions
): Promise<{ id: string; status: string; model: SpeechModel }> {
  const { keytermsPrompt, customSpelling } = await vocabForSubmit(userId, opts.extraKeyterms);
  return submitTranscription(audioUrl, {
    languageCode: opts.languageCode,
    keytermsPrompt,
    customSpelling,
    model: opts.speechModel,
  });
}

/**
 * The other reusable half: the row. Promote the placeholder in place when
 * there is one, else insert. Same function on both paths so a Stage C meeting
 * is born exactly as a pull-path one is.
 *
 * `audioUrl` is what lands in `transcripts.audio_url`. Stage C passes NULL on
 * purpose: its URL is a SAS, i.e. a bearer credential for the blob, and the
 * column is read back by the audio route and copied into exports.
 */
export async function createOrPromoteRow(
  userId: string,
  submitted: { id: string; status: string; model: SpeechModel },
  audioUrl: string | null,
  opts: IngestOptions
): Promise<TranscriptRow> {
  let promoted: TranscriptRow | null = null;
  if (opts.placeholderAssemblyaiId) {
    // What the meeting ends up called is decided inside promoteUploadingRow
    // (Phase 1b): the placeholder's own uuid when minted ids are on, the
    // job id when they are not. `submitted.id` is always the JOB.
    promoted = await promoteUploadingRow(userId, opts.placeholderAssemblyaiId, {
      assemblyaiId: submitted.id,
      status: submitted.status,
      audioUrl,
      speechModel: submitted.model,
    });
  }
  // No placeholder, or the sweeper reaped it mid-upload → fresh insert.
  const row =
    promoted ??
    (await createForUser(userId, {
      assemblyaiId: newMeetingId(submitted.id, await mintedIdsEnabled()),
      aaiJobId: submitted.id,
      originalFilename: opts.originalFilename,
      status: submitted.status,
      speechModel: submitted.model,
      languageCode: opts.languageCode ?? null,
      title: opts.title ?? null,
      audioUrl,
      driveFileId: opts.driveFileId ?? null,
      gmeetContext: opts.gmeetContext ?? null,
      scratch: opts.scratch ?? false,
    }));
  return row;
}

/**
 * Attach the new row to its recurring series. Outside `createOrPromoteRow` so
 * that the local path's "a failure here must not delete the temp file"
 * ordering is exactly what it has always been.
 *
 * Uses the ROW's context, not opts — promoted placeholder rows carry the
 * linked-event context stamped at upload start.
 */
export async function attachSeriesForRow(row: TranscriptRow): Promise<void> {
  await autoAttachSeries({
    id: row.id,
    assemblyai_id: row.assemblyai_id,
    gmeet_context: row.gmeet_context,
    title: row.title,
    user_id: row.user_id,
    scratch: row.scratch,
  });
}

export async function ingestLocalAudio(
  userId: string,
  tempFilename: string,
  opts: IngestOptions
): Promise<TranscriptRow> {
  // Multi-track recordings (Darth Recorder: system + mic as separate tracks)
  // must not go to AssemblyAI raw — it hears one track. Mix first; the mix
  // becomes the stored file's default track and the (small) AAI upload.
  // Non-fatal: on any ffmpeg failure the raw file goes up as before.
  let aaiSourceFilename = tempFilename;
  let mixFilename: string | null = null;
  try {
    const mt = await normalizeMultiTrack(tempFilename);
    if (mt.mixed) {
      aaiSourceFilename = mt.aaiSource;
      mixFilename = mt.aaiSource;
      console.log(`[ingest] ${tempFilename}: ${mt.tracks} audio tracks → mixed for transcription + default playback track`);
    }
  } catch (error) {
    console.warn('[ingest] multi-track normalisation failed (uploading raw file):', error);
  }

  let audioUrl: string;
  try {
    // Path input → the SDK streams the file from disk.
    audioUrl = await uploadFile(resolveAudioPath(aaiSourceFilename));
  } catch (error) {
    const kept = await keepFailedIngest(userId, tempFilename, opts, 'aai-upload', error).catch((e) => {
      console.error('[ingest] keeping the failed upload failed too:', e);
      return null;
    });
    if (!kept) await deleteAudioFile(tempFilename);
    throw new IngestError('aai-upload', 'Upload to AssemblyAI failed', error, kept ?? undefined);
  } finally {
    // AAI has the bytes (or the upload failed); the mix lives on inside the
    // re-muxed stored file, so the standalone copy is not needed any more.
    if (mixFilename) await deleteAudioFile(mixFilename).catch(() => {});
  }

  let submitted: { id: string; status: string; model: SpeechModel };
  try {
    submitted = await submitForIngest(userId, audioUrl, opts);
  } catch (error) {
    const kept = await keepFailedIngest(userId, tempFilename, opts, 'aai-submit', error).catch((e) => {
      console.error('[ingest] keeping the failed submit failed too:', e);
      return null;
    });
    if (!kept) await deleteAudioFile(tempFilename);
    throw new IngestError('aai-submit', 'Transcription submission failed', error, kept ?? undefined);
  }

  let row: TranscriptRow;
  try {
    row = await createOrPromoteRow(userId, submitted, audioUrl, opts);
  } catch (error) {
    // Transcription was submitted but we lost the row — don't also leak the
    // temp file on disk.
    await deleteAudioFile(tempFilename);
    throw error;
  }

  await attachSeriesForRow(row);

  // Keep our own copy of the audio. AAI deletes uploaded audio immediately
  // after transcription, so their audio_url is useless for playback. The
  // bytes are already on disk as the temp file — just rename it to its
  // permanent name. We serve it via /api/transcripts/[id]/audio.
  //
  // Named after the MEETING (Phase 1b), which is the job id only for a row
  // minting did not touch. `row.assemblyai_id` is the one source of that —
  // `submitted.id` is the disposable job and must not name a file, a frames
  // directory or an SSE event.
  const meetingId = row.assemblyai_id;
  try {
    let filename = audioFilename(meetingId, opts.originalFilename);
    if (filename.endsWith('.bin')) {
      // Extension-less original name (Drive names Meet recordings that way):
      // sniff the container so video detection and playback Content-Type work.
      const sniffed = await sniffMediaExtension(tempFilename);
      if (sniffed) filename = `${meetingId}${sniffed}`;
    }
    await renameAudioFile(tempFilename, filename);
    await setLocalAudioPathForUser(userId, meetingId, filename);
    row.local_audio_path = filename;
    // Faststart remux + audio-only extract, in the background: AAI already
    // has the bytes, so nothing on the transcription path waits for ffmpeg.
    prepareMediaForPlayback(userId, meetingId);
  } catch (error) {
    // Non-fatal: the transcription itself succeeded. Audio playback for this
    // row will fall back to (broken) remote URL until/unless we re-upload.
    console.error('[ingest] local audio rename failed:', error);
    await deleteAudioFile(tempFilename);
  }

  // Dual-write, last: the row is complete (id promoted or inserted, context
  // stamped, media named) so the derived graph is the final one. Callers that
  // keep writing to the row afterwards — the Meet importer's context merge,
  // the recorder link — fire their own sync.
  queueRecordingGraphSync(userId, row.assemblyai_id, 'ingest');

  return row;
}
