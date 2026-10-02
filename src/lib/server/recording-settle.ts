import 'server-only';
import { failMeetingsMadeEarly, materialiseMeetingsMadeEarly } from '@/db-ops/standalone-recordings';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import { prepareMediaForPlayback } from '@/lib/server/media-sweeper';
import { queueClipPrecut } from '@/lib/server/clip-precut';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';
import { publishEvent } from '@/lib/server/event-bus';

/**
 * Meetings made from a recording BEFORE it was transcribed (Link to
 * meeting… / Make a meeting while "uploading" or "transcribing" — Alok,
 * 2026-09-30) get their text here, the moment the recording's own
 * transcription settles. Called from `refreshBornBare` (the poll that
 * observes the completion) and, with no id, from the born-bare sweeper as
 * the backstop for a process that died between the two writes.
 *
 * What runs for each meeting is exactly what `makeMeeting` runs for a ready
 * recording: playback prep, the graph sync and the SILENT completion hook
 * (speaker passes; no DM — the recording sent the one "transcribed" DM it
 * gets). The page is nudged over the event bus so its poll ends now.
 */
export async function settleMeetingsMadeEarly(
  recordingId: string | null,
  outcome: { status: 'completed' } | { status: 'error'; reason: string }
): Promise<number> {
  const rows =
    outcome.status === 'completed'
      ? await materialiseMeetingsMadeEarly(recordingId)
      : recordingId
        ? await failMeetingsMadeEarly(recordingId, outcome.reason)
        : [];
  for (const m of rows) {
    console.log(
      `[recording-settle] meeting ${m.assemblyai_id} (owner ${m.user_id}) made early from recording ${recordingId ?? '?'}: ${outcome.status}`
    );
    publishEvent({ kind: 'status', assemblyaiId: m.assemblyai_id });
    if (outcome.status !== 'completed') continue;
    queueRecordingGraphSync(m.user_id, m.assemblyai_id, 'recording-settle');
    prepareMediaForPlayback(m.user_id, m.assemblyai_id);
    queueClipPrecut(m.assemblyai_id, 'recording-settle');
    onTranscriptCompleted(m.user_id, m.assemblyai_id, { utterances: null, silent: true });
  }
  // Recordings that JOINED another meeting of the same occurrence while they
  // were still on their way: their text is merged now (or marked failed), and
  // reservations made while MW_COMBINE was off are finished once it is on.
  // Loaded lazily — the join module pulls in the whole clip machinery, which
  // this module (imported by the upload pipeline) must not drag along.
  try {
    const { settleOccurrenceJoins } = await import('@/lib/server/occurrence-join');
    await settleOccurrenceJoins(recordingId, outcome);
  } catch (err) {
    console.warn(`[recording-settle] occurrence joins for ${recordingId ?? 'any recording'} failed:`, err);
  }
  return rows.length;
}
