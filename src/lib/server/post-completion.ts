import 'server-only';
import { getForUser } from '@/db-ops/transcripts';
import { getContentCached, identifySpeakers } from '@/lib/server/auto-notes';
import { suggestSpeakersFromMeet } from '@/lib/server/meet-align';
import { suggestSpeakersForTranscript } from '@/lib/server/voiceprint';

/**
 * Fire-and-forget work that should happen once, when a transcript first
 * transitions to `completed`:
 *   1. voiceprint-match the diarized speakers and store name suggestions
 *   2. Meet↔AAI timeline alignment votes ('both'-mode imports)
 *   3. the speaker-identification AI pass (text + hints + video frames)
 * Notes are NOT generated here: they wait for a human to review the
 * suggested speaker labels ("confirm & generate" on the detail page).
 *
 * There is no job queue in this app — completion is only ever observed
 * inside a request (detail GET / listing GET polling AAI), so this is called
 * from those code paths and must never throw or block the response.
 *
 * Idempotence: the ID pass is guarded by speaker_id_status + an in-flight
 * set; suggestions are cheap and just overwrite. All no-op harmlessly if
 * re-triggered.
 */
export function onTranscriptCompleted(ownerUserId: string, assemblyaiId: string): void {
  setTimeout(() => {
    void (async () => {
      try {
        // Re-read so we have local_audio_path + any cached content even when
        // the caller only had a skinny listing row.
        const full = await getForUser(ownerUserId, assemblyaiId);
        if (!full || full.status !== 'completed') return;

        // Content is usually not cached yet at the moment of completion —
        // fetch (and cache) it once here so both steps below have it.
        const content = await getContentCached(ownerUserId, full);

        // Voiceprint speaker suggestions (fast, seconds). AI notes are NOT
        // auto-generated any more — the user triggers them from the detail
        // page, so they can attach context (decks, pasted docs) first and
        // review the transcript before spending the tokens.
        await suggestSpeakersForTranscript(
          ownerUserId,
          full.assemblyai_id,
          full.local_audio_path,
          content
        ).catch((err) => console.warn('[post-completion] suggest failed:', err));

        // Meet↔AAI alignment: when the import kept the Google Meet transcript
        // as a sidecar ('both' mode), name diarized speakers by timeline
        // overlap against Meet's named utterances. Runs after voiceprints —
        // voice matches outrank overlap votes in the merge.
        const meetT = full.gmeet_context?.meetTranscript;
        if (
          meetT?.utterances?.length &&
          content?.utterances?.length &&
          !full.assemblyai_id.startsWith('gmeet-')
        ) {
          await suggestSpeakersFromMeet(
            ownerUserId,
            full.assemblyai_id,
            content,
            meetT.utterances
          ).catch((err) => console.warn('[post-completion] meet-align failed:', err));
        }

        // Speaker-identification AI pass, AFTER the cheap passes so it can
        // weigh their hints. Guarded by speaker_id_status — runs once.
        await identifySpeakers(ownerUserId, full.assemblyai_id).catch((err) =>
          console.warn('[post-completion] speaker-id failed:', err)
        );
      } catch (err) {
        console.warn('[post-completion] hook failed:', err);
      }
    })();
  }, 0);
}
