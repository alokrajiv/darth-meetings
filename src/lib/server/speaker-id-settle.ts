import 'server-only';
import { setSpeakerIdForUser } from '@/db-ops/transcripts';
import { diarizedSpeakers, shouldSettleSpeakerId } from '@/lib/speaker-id-settle';
import type { SpeakerLabel, StoredTranscript, TranscriptResponse } from '@/lib/format';

/**
 * After `PUT …/speakers` saved `labels`: when every diarized speaker now has
 * a name and the pass is still null / running / errored, mark the pass
 * 'completed'. `setSpeakerIdForUser` publishes the `notes` live event, so the
 * detail page drops "Identifying speakers first…" without a reload.
 *
 * `content` is the read the route already does for voiceprint enrollment
 * (`getContentCached`) — no second fetch. Null content = nothing to decide
 * on, nothing written. Notes are NOT generated from here: a summary stays a
 * user's action.
 *
 * Returns true iff the status was written.
 */
export async function settleSpeakerIdAfterNaming(
  ownerUserId: string,
  row: StoredTranscript,
  labels: ReadonlyArray<SpeakerLabel>,
  content: TranscriptResponse | null
): Promise<boolean> {
  if (!content?.utterances?.length) return false;
  const settle = shouldSettleSpeakerId({
    rowStatus: row.status,
    speakerIdStatus: row.speaker_id_status,
    speakers: diarizedSpeakers(content.utterances),
    labels,
  });
  if (!settle) return false;
  await setSpeakerIdForUser(ownerUserId, row.assemblyai_id, { status: 'completed', error: null });
  return true;
}
