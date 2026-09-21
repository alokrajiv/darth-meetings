import 'server-only';
import { getTranscript } from '@/lib/server/assemblyai';
import {
  setCachedContentForUser,
  updateStatusForUser,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import { onTranscriptCompleted } from '@/lib/server/post-completion';

/**
 * If the stored row is still queued/processing, fetch the latest state from
 * AssemblyAI and persist it. Returns the (possibly updated) row. Swallows
 * upstream errors so a transient AAI hiccup doesn't break the list endpoint.
 */
export async function refreshIfPending(
  userId: string,
  row: TranscriptRow
): Promise<TranscriptRow> {
  // 'uploading' / 'waiting' rows have a synthetic `up-…` / `defer-…` id that
  // AAI has never heard of — nothing to refresh until they're promoted.
  if (
    row.status === 'completed' ||
    row.status === 'error' ||
    row.status === 'uploading' ||
    row.status === 'waiting'
  ) {
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

    // First observation of the completed state → kick off auto-notes and
    // voiceprint speaker suggestions (fire-and-forget).
    if (aai.status === 'completed') {
      onTranscriptCompleted(userId, row.assemblyai_id);
      // Freeze the payload now rather than on the first content fetch. AAI
      // content is immutable once completed, and the payload is the only
      // record of what AAI actually DID — which model ran, which language it
      // chose, which warnings it raised (lib/aai-outcome.ts). Caching it here
      // means the Sources card can tell the truth on the very first page
      // load instead of one refresh later.
      await setCachedContentForUser(userId, row.assemblyai_id, aai).catch((err) =>
        console.warn('[transcript-sync] caching the AAI payload failed:', err)
      );
      if (updated) return { ...updated, imported_content: aai };
    }

    return updated ?? row;
  } catch (error) {
    console.warn('[transcript-sync] refresh failed:', error);
    return row;
  }
}
