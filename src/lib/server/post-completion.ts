import 'server-only';
import { getForUser } from '@/db-ops/transcripts';
import { getContentCached, identifySpeakers } from '@/lib/server/auto-notes';
import { maybeAutoReview } from '@/lib/server/auto-review';
import { suggestSpeakersFromMeet } from '@/lib/server/meet-align';
import { suggestSpeakersForTranscript } from '@/lib/server/voiceprint';
import { identityForUser } from '@/db-ops/transcript-activity';
import { autoMarkerOf } from '@/lib/auto-marker';
import { notifyUser } from '@/lib/server/darth-notify';
import { dm, meetingLine, openLink } from '@/lib/server/dm-copy';

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

        // Series-auto-imported rows only: when every speaker that matters is
        // identified with high confidence, apply the names and generate the
        // configured summary/report unattended; otherwise DM the owner to
        // come review. No-op without the gmeet_context.autoImport marker.
        await maybeAutoReview(ownerUserId, full.assemblyai_id).catch((err) =>
          console.warn('[post-completion] auto-review failed:', err)
        );

        // Hand-started work (drag-drop upload, manual import): tell the
        // owner it's done so they can close the tab and come back on the
        // DM. Auto paths have their own needs_review / report_ready DMs.
        // plagueis dedupes on the key, so re-entering this hook is safe.
        if (!autoMarkerOf(full.gmeet_context)) {
          await notifyTranscriptReady(ownerUserId, full).catch((err) =>
            console.warn('[post-completion] ready DM failed:', err)
          );
        }
      } catch (err) {
        console.warn('[post-completion] hook failed:', err);
      }
    })();
  }, 0);
}

async function notifyTranscriptReady(
  ownerUserId: string,
  row: NonNullable<Awaited<ReturnType<typeof getForUser>>>
): Promise<void> {
  const owner = await identityForUser(ownerUserId);
  if (!owner) return;
  const title = row.title?.trim() || row.original_filename?.trim() || 'Untitled meeting';
  const how =
    row.source === 'imported' || row.gmeet_context?.provider
      ? `Imported from ${row.gmeet_context?.provider === 'teams' ? 'Microsoft Teams' : 'Google Meet'}`
      : `Uploaded file: ${row.original_filename ?? 'recording'}`;
  const link = await openLink(row.assemblyai_id, 'Review speakers & generate notes');
  await notifyUser({
    kind: 'transcript_ready',
    toEmail: owner.email,
    text: dm(
      `🎙 *Transcript ready*`,
      meetingLine({
        title,
        when: row.recorded_at ?? row.created_at,
        duration: row.duration,
        speakerCount: row.speaker_count,
      }),
      `${how}. Speaker names are suggested where voices matched — confirm them and the notes generate → ${link}`
    ),
    dedupeKey: `mw-transcript-ready:${row.assemblyai_id}:${owner.email}`,
  });
}
