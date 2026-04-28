import 'server-only';
import { getTranscript } from '@/lib/server/assemblyai';
import {
  updateStatusForUser,
  type TranscriptRow,
} from '@/db-ops/transcripts';

/**
 * If the stored row is still queued/processing, fetch the latest state from
 * AssemblyAI and persist it. Returns the (possibly updated) row. Swallows
 * upstream errors so a transient AAI hiccup doesn't break the list endpoint.
 */
export async function refreshIfPending(
  userId: string,
  row: TranscriptRow
): Promise<TranscriptRow> {
  if (row.status === 'completed' || row.status === 'error') {
    return row;
  }

  try {
    const aai = await getTranscript(row.assemblyai_id);
    const speakerCount = aai.utterances
      ? new Set(aai.utterances.map((u) => u.speaker)).size
      : null;

    const updated = await updateStatusForUser(userId, row.assemblyai_id, {
      status: aai.status,
      completedAt: aai.completed ? new Date(aai.completed) : null,
      duration: aai.audio_duration ?? null,
      speakerCount,
      languageCode: aai.language_code ?? null,
    });
    return updated ?? row;
  } catch (error) {
    console.warn('[transcript-sync] refresh failed:', error);
    return row;
  }
}
