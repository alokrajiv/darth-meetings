/**
 * Meetings that BORROW a recording's text instead of having a transcription
 * of their own — pure predicates shared by the detail-page poll
 * (`refreshIfPending`), the ingest retry and the tests.
 *
 * A meeting made from a recording (Link to meeting… / Make a meeting —
 * `createMeetingFromRecording`) carries `gmeet_context.fromRecording`, a
 * minted UUID id, NO AssemblyAI job of its own (`aai_job_id` NULL until the
 * settle copies the recording's) and `local_audio_path` = the recording's
 * canonical media file. Everything about its text is the RECORDING's
 * business:
 *   - it is never polled at AssemblyAI (its id is one we minted — prod
 *     2026-10-02, transcripts 1054, was flipped to 'error' by exactly that);
 *   - it is filled in by the settle (`materialiseMeetingsMadeEarly`) when the
 *     recording's transcription lands;
 *   - "Retry" on it retries or settles the recording — it never re-ingests
 *     the file, which would submit a second job for the same bytes AND rename
 *     the recording's canonical file after the meeting.
 */

interface MadeEarlyRow {
  status: string;
  aai_job_id?: string | null;
  deleted_at?: string | Date | null;
  imported_content?: unknown;
  gmeet_context?: {
    fromRecording?: { recordingId?: string | null } | null;
    splitFrom?: unknown;
    clips?: unknown;
  } | null;
}

/** The recording a meeting was MADE from, or null. */
export function madeFromRecordingId(row: Pick<MadeEarlyRow, 'gmeet_context'>): string | null {
  return row.gmeet_context?.fromRecording?.recordingId || null;
}

/**
 * A meeting made from a recording before the recording had text, still
 * without text of its own: its status ('processing', or an 'error' some
 * poller or a failed recording left behind) is the RECORDING's business,
 * never AssemblyAI's.
 */
export function madeEarlyAwaitingText(row: MadeEarlyRow): boolean {
  if (row.deleted_at || row.aai_job_id || row.imported_content) return false;
  if (!madeFromRecordingId(row)) return false;
  return row.status === 'processing' || row.status === 'error';
}

/**
 * Why `ingestLocalAudio` must not run for this row, or null when it may.
 *
 *   - 'made-from-recording': `gmeet_context.fromRecording` — the file is the
 *     recording's canonical media, the text is the recording's transcription.
 *   - 'split': `gmeet_context.splitFrom` — the file and the text belong to the
 *     meeting it was split off.
 *
 * Both re-use another row's bytes under that row's name; re-ingesting would
 * rename the file out from under its owner (ingest renames the stored file
 * after the meeting id) and pay for a second transcription of the same audio.
 */
export function borrowedMediaReason(
  row: Pick<MadeEarlyRow, 'gmeet_context'>
): 'made-from-recording' | 'split' | null {
  if (madeFromRecordingId(row)) return 'made-from-recording';
  if (row.gmeet_context?.splitFrom) return 'split';
  return null;
}
