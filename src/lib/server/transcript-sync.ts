import 'server-only';
import { getTranscript } from '@/lib/server/assemblyai';
import { updateStatusForUser, type TranscriptRow } from '@/db-ops/transcripts';
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

    const completed = aai.status === 'completed';
    const updated = await updateStatusForUser(userId, row.assemblyai_id, {
      status: aai.status,
      completedAt: aai.completed ? new Date(aai.completed) : null,
      duration: aai.audio_duration ?? null,
      speakerCount,
      languageCode: aai.language_code ?? null,
      // DEC-4: the payload is written in the SAME statement that flips the
      // row to completed — never lazily on the first content fetch. It is
      // also the only record of what AAI actually DID (which model ran,
      // which language it chose, which warnings it raised —
      // lib/aai-outcome.ts), and after this poll we never ask AAI again.
      content: completed ? aai : null,
    });

    // First observation of the completed state → the post-completion hook
    // (speaker suggestions, ID pass) and the AAI-side delete, both
    // fire-and-forget. The observed utterance count travels with it so the
    // delete can prove our copy matches what AAI returned.
    if (completed) {
      onTranscriptCompleted(userId, row.assemblyai_id, {
        utterances: aai.utterances?.length ?? null,
      });
      if (updated) return { ...updated, imported_content: aai };
    }

    return updated ?? row;
  } catch (error) {
    console.warn('[transcript-sync] refresh failed:', error);
    return row;
  }
}
