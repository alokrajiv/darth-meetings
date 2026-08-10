import 'server-only';
import {
  createForUser,
  promoteUploadingRow,
  setLocalAudioPathForUser,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import { uploadFile, submitTranscription } from '@/lib/server/assemblyai';
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
import { autoAttachSeries } from '@/lib/server/series-attach';
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
 * On failure the temp file is deleted and an IngestError is thrown carrying
 * the stage, so callers can map it to a precise HTTP response.
 */

export class IngestError extends Error {
  constructor(
    public stage: 'aai-upload' | 'aai-submit',
    message: string,
    public causeErr?: unknown
  ) {
    super(message);
    this.name = 'IngestError';
  }
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
}

export async function ingestLocalAudio(
  userId: string,
  tempFilename: string,
  opts: IngestOptions
): Promise<TranscriptRow> {
  let audioUrl: string;
  try {
    // Path input → the SDK streams the file from disk.
    audioUrl = await uploadFile(resolveAudioPath(tempFilename));
  } catch (error) {
    await deleteAudioFile(tempFilename);
    throw new IngestError('aai-upload', 'Upload to AssemblyAI failed', error);
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

  let submitted: { id: string; status: string };
  try {
    submitted = await submitTranscription(audioUrl, {
      languageCode: opts.languageCode,
      keytermsPrompt,
      customSpelling,
    });
  } catch (error) {
    await deleteAudioFile(tempFilename);
    throw new IngestError('aai-submit', 'Transcription submission failed', error);
  }

  let row: TranscriptRow;
  try {
    let promoted: TranscriptRow | null = null;
    if (opts.placeholderAssemblyaiId) {
      promoted = await promoteUploadingRow(userId, opts.placeholderAssemblyaiId, {
        assemblyaiId: submitted.id,
        status: submitted.status,
        audioUrl,
      });
    }
    // No placeholder, or the sweeper reaped it mid-upload → fresh insert.
    row =
      promoted ??
      (await createForUser(userId, {
        assemblyaiId: submitted.id,
        originalFilename: opts.originalFilename,
        status: submitted.status,
        languageCode: opts.languageCode ?? null,
        title: opts.title ?? null,
        audioUrl: audioUrl,
        driveFileId: opts.driveFileId ?? null,
        gmeetContext: opts.gmeetContext ?? null,
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
  } catch (error) {
    // Non-fatal: the transcription itself succeeded. Audio playback for this
    // row will fall back to (broken) remote URL until/unless we re-upload.
    console.error('[ingest] local audio rename failed:', error);
    await deleteAudioFile(tempFilename);
  }

  return row;
}
