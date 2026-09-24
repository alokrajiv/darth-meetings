import 'server-only';
import { claimSpeakerId, getForUser } from '@/db-ops/transcripts';
import { getContentCached, identifySpeakers } from '@/lib/server/auto-notes';
import { deleteAtAaiIfSafe } from '@/lib/server/aai-retention';
import { maybeAutoReview } from '@/lib/server/auto-review';
import { suggestSpeakersFromMeet } from '@/lib/server/meet-align';
import { suggestSpeakersForTranscript } from '@/lib/server/voiceprint';
import { resolveMeetingContent } from '@/lib/server/recordings';
import { combineFlagOn } from '@/db-ops/clips';
import { meetingRecordingRef } from '@/db-ops/transcriptions';
import { rematerialiseCombinedMeetings } from '@/lib/server/clip-combine';
import { runPendingAttach } from '@/lib/server/clip-attach';
import { identityForUser } from '@/db-ops/transcript-activity';
import { autoMarkerOf } from '@/lib/auto-marker';
import { notifyUser } from '@/lib/server/darth-notify';
import { dm, meetingLine, openLink, runKey } from '@/lib/server/dm-copy';

/**
 * Fire-and-forget work that should happen once, when a transcript first
 * transitions to `completed`:
 *   0. delete the job at AssemblyAI once our copy is proven safe (DEC-4)
 *   1. claim the speaker-name passes (speaker_id_status NULL -> 'running',
 *      one atomic UPDATE — `claimSpeakerId`); steps 2-5 run only for the
 *      request that won the claim
 *   2. voiceprint-match the diarized speakers and store name suggestions
 *   3. Meet↔AAI timeline alignment votes ('both'-mode imports)
 *   4. the speaker-identification AI pass (text + hints + video frames)
 *   5. auto-review for series-auto-imported rows
 * The ready DM (and, with the combine flag, re-materialise/attach) run on
 * every entry; they are deduped/idempotent on their own.
 * Notes are NOT generated here: they wait for a human to review the
 * suggested speaker labels ("confirm & generate" on the detail page).
 *
 * Everything from step 1 on reads the DB payload and the local recording —
 * nothing here goes back to AssemblyAI, which is why step 0 can run first.
 *
 * There is no job queue in this app — completion is only ever observed
 * inside a request (detail GET / listing GET polling AAI), so this is called
 * from those code paths and must never throw or block the response.
 *
 * Idempotence: the hook re-fires on every request that observes the
 * completion, so the speaker passes are gated on the claim — the first
 * entry flips speaker_id_status to 'running' and runs them, every later
 * entry sees a non-NULL status and skips them (no second voiceprint pass
 * queued behind the sidecar). Claiming BEFORE the voiceprint pass also means
 * the page sees 'running' for the whole window, so it polls and the review
 * dialog says the AI is still guessing. identifySpeakers writes the terminal
 * 'completed'/'error'; if the process dies in between, the row stays
 * 'running' and the notes-sweeper's stuck path re-runs it with force.
 * A re-transcription into a new diarization space clears the status
 * (transcriptions plan), so the hook can claim again.
 */
export function onTranscriptCompleted(
  ownerUserId: string,
  assemblyaiId: string,
  /** What the completing AAI poll returned, when the caller saw it — the
   * DEC-4 delete refuses to run unless the stored payload matches it. Absent
   * for paths that never touched AAI (text imports). */
  observed?: {
    utterances: number | null;
    /**
     * Phase 2: which TRANSCRIPTION just became live. Absent for a meeting's
     * first (and usually only) transcription; set when a re-run was activated,
     * and then it goes into every DM dedupe key this hook sends — landmine #9:
     * `mw-transcript-ready:<meeting>:<email>` would otherwise silence the
     * second "ready" DM for a meeting that has been transcribed twice.
     */
    transcriptionId?: string | null;
    /**
     * Design P7: the meeting was just MADE from a standalone recording (Link /
     * Make a meeting). The recording already sent the one "transcribed" DM it
     * gets; making a meeting sends none (risk §6.1: never twice).
     */
    silent?: boolean;
  }
): void {
  setTimeout(() => {
    void (async () => {
      try {
        // Re-read so we have the media + the payload the completion write
        // stored, even when the caller only had a skinny listing row.
        const full = await getForUser(ownerUserId, assemblyaiId);
        if (!full || full.status !== 'completed') return;

        // DEC-4 step 0: our copy is on disk and in Postgres — take the job
        // off AssemblyAI. Off unless MW_AAI_DELETE_ON_COMPLETE is set, and a
        // failure here is logged and retried by the sweeper, never fatal.
        await deleteAtAaiIfSafe(ownerUserId, assemblyaiId, observed?.utterances ?? null).catch(
          (err) => console.warn('[post-completion] AAI delete failed:', err)
        );

        // Step 1: only the entry that flips speaker_id_status NULL -> 'running'
        // runs the speaker passes below. A failed claim (DB hiccup) leaves the
        // row NULL, which the notes-sweeper picks up after its grace window.
        const claimed = await claimSpeakerId(ownerUserId, assemblyaiId).catch((err) => {
          console.warn('[post-completion] speaker-id claim failed:', err);
          return false;
        });

        // The payload and the media, from the DB through the resolver —
        // completion is the payload's only writer now.
        const [content, resolved] = await Promise.all([
          getContentCached(ownerUserId, full),
          resolveMeetingContent(full),
        ]);

        // Phase 3b: a recording added to ANOTHER meeting as a clip while it
        // was still transcribing (the "playable now, text later" case, only
        // legal with `exclude`) — that meeting's text is rebuilt now the
        // transcription has landed. A no-op for every meeting that is not
        // part of a combined one, which is every row on prod.
        if (combineFlagOn()) {
          await (async () => {
            const ref = await meetingRecordingRef(full.id);
            if (ref) await rematerialiseCombinedMeetings(ref.recordingId, full.id);
          })().catch((err) =>
            console.warn('[post-completion] combined re-materialise failed:', err)
          );

          // Phase 3b source (c): this upload was opened with `attachTo` — it
          // is a second capture OF another meeting, and now that its own
          // transcription has landed it joins that meeting as a clip
          // (`lib/server/clip-attach.ts`). The uploaded meeting stays an
          // ordinary meeting either way: it is also this recording's own
          // document. No new DM — the "Transcript ready" one below covers it,
          // and a refusal leaves the marker with its sentence for the card.
          await runPendingAttach(ownerUserId, full).catch((err) =>
            console.warn('[post-completion] attach failed:', err)
          );
        }

        if (claimed) {
          // Voiceprint speaker suggestions (fast, seconds). AI notes are NOT
          // auto-generated any more — the user triggers them from the detail
          // page, so they can attach context (decks, pasted docs) first and
          // review the transcript before spending the tokens.
          await suggestSpeakersForTranscript(
            ownerUserId,
            full.assemblyai_id,
            resolved.media /* every file: a combined meeting embeds each recording's voices from ITS OWN file (mediaForSpeaker) */,
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
              meetT.utterances,
              // The media, for the pooled-room release valve: when the rule is
              // about to drop a name because it spans two diarized speakers,
              // it can cut a few seconds of that name's own dense speech and
              // ask the ECAPA sidecar whether it is one voice after all
              // (lib/meet-align-valve.ts). Off unless
              // MW_MEET_ALIGN_VOICE_VALVE is set; capped at 3 checks, ~2 s of
              // CPU each, audio only, nothing enrolled.
              { media: resolved.media, gmeetContext: full.gmeet_context ?? null }
            ).catch((err) => console.warn('[post-completion] meet-align failed:', err));
          }

          // Speaker-identification AI pass, AFTER the cheap passes so it can
          // weigh their hints. `claimed` tells it the row's 'running' is ours.
          await identifySpeakers(ownerUserId, full.assemblyai_id, { claimed: true }).catch((err) =>
            console.warn('[post-completion] speaker-id failed:', err)
          );

          // Series-auto-imported rows only: when every speaker that matters is
          // identified with high confidence, apply the names and generate the
          // configured summary/report unattended; otherwise DM the owner to
          // come review. No-op without the gmeet_context.autoImport marker.
          await maybeAutoReview(ownerUserId, full.assemblyai_id, observed?.transcriptionId).catch(
            (err) => console.warn('[post-completion] auto-review failed:', err)
          );
        }

        // Hand-started work (drag-drop upload, manual import): tell the
        // owner it's done so they can close the tab and come back on the
        // DM. Auto paths have their own needs_review / report_ready DMs.
        // plagueis dedupes on the key, so re-entering this hook is safe.
        if (!autoMarkerOf(full.gmeet_context) && !observed?.silent) {
          await notifyTranscriptReady(ownerUserId, full, observed?.transcriptionId).catch((err) =>
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
  row: NonNullable<Awaited<ReturnType<typeof getForUser>>>,
  transcriptionId?: string | null
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
    dedupeKey: `mw-transcript-ready:${row.assemblyai_id}${runKey(transcriptionId)}:${owner.email}`,
  });
}
