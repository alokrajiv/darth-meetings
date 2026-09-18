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
import type { GmeetContext } from '@/lib/format';

/**
 * Shared ingestion tail for audio that has already landed as a temp file in
 * the audio dir: upload to AssemblyAI (disk-streamed), submit transcription
 * with merged vocab bias, create the DB row, and rename the temp file to its
 * permanent `<aai-id>.<ext>` name.
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
  return row;
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

  // Merge org + user vocab and pass to AAI as keyterms_prompt / custom_spelling.
  // Failures are non-fatal: we still submit, just without the bias hints.
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

  if (opts.extraKeyterms && opts.extraKeyterms.length > 0) {
    const seen = new Set((keytermsPrompt ?? []).map((t) => t.toLowerCase()));
    const extras = opts.extraKeyterms
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !seen.has(t.toLowerCase()));
    keytermsPrompt = [...(keytermsPrompt ?? []), ...extras].slice(0, 1000);
  }

  let submitted: { id: string; status: string; model: SpeechModel };
  try {
    submitted = await submitTranscription(audioUrl, {
      languageCode: opts.languageCode,
      keytermsPrompt,
      customSpelling,
      model: opts.speechModel,
    });
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
    let promoted: TranscriptRow | null = null;
    if (opts.placeholderAssemblyaiId) {
      promoted = await promoteUploadingRow(userId, opts.placeholderAssemblyaiId, {
        assemblyaiId: submitted.id,
        status: submitted.status,
        audioUrl,
        speechModel: submitted.model,
      });
    }
    // No placeholder, or the sweeper reaped it mid-upload → fresh insert.
    row =
      promoted ??
      (await createForUser(userId, {
        assemblyaiId: submitted.id,
        originalFilename: opts.originalFilename,
        status: submitted.status,
        speechModel: submitted.model,
        languageCode: opts.languageCode ?? null,
        title: opts.title ?? null,
        audioUrl: audioUrl,
        driveFileId: opts.driveFileId ?? null,
        gmeetContext: opts.gmeetContext ?? null,
        scratch: opts.scratch ?? false,
      }));
  } catch (error) {
    // Transcription was submitted but we lost the row — don't also leak the
    // temp file on disk.
    await deleteAudioFile(tempFilename);
    throw error;
  }

  // Use the ROW's context, not opts — promoted placeholder rows carry the
  // linked-event context stamped at upload start.
  await autoAttachSeries({
    id: row.id,
    assemblyai_id: row.assemblyai_id,
    gmeet_context: row.gmeet_context,
    title: row.title,
    user_id: row.user_id,
    scratch: row.scratch,
  });

  // Keep our own copy of the audio. AAI deletes uploaded audio immediately
  // after transcription, so their audio_url is useless for playback. The
  // bytes are already on disk as the temp file — just rename it to its
  // permanent name. We serve it via /api/transcripts/[id]/audio.
  try {
    let filename = audioFilename(submitted.id, opts.originalFilename);
    if (filename.endsWith('.bin')) {
      // Extension-less original name (Drive names Meet recordings that way):
      // sniff the container so video detection and playback Content-Type work.
      const sniffed = await sniffMediaExtension(tempFilename);
      if (sniffed) filename = `${submitted.id}${sniffed}`;
    }
    await renameAudioFile(tempFilename, filename);
    await setLocalAudioPathForUser(userId, submitted.id, filename);
    row.local_audio_path = filename;
    // Faststart remux + audio-only extract, in the background: AAI already
    // has the bytes, so nothing on the transcription path waits for ffmpeg.
    prepareMediaForPlayback(userId, submitted.id);
  } catch (error) {
    // Non-fatal: the transcription itself succeeded. Audio playback for this
    // row will fall back to (broken) remote URL until/unless we re-upload.
    console.error('[ingest] local audio rename failed:', error);
    await deleteAudioFile(tempFilename);
  }

  return row;
}
