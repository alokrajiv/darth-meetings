import 'server-only';
import {
  getForUser as getMappingsForUser,
  setSuggestionsForUser,
} from '@/db-ops/speaker-mappings';
import type { MeetUtterance, SpeakerSuggestionMap, TranscriptResponse } from '@/lib/format';
import { computeMeetAlignment, type AlignmentVote } from '@/lib/meet-align-vote';

/**
 * Meet ↔ AAI speaker alignment.
 *
 * When a meeting was imported in 'both' mode we hold two transcripts of the
 * same audio: AAI's (acoustic diarization, anonymous "A"/"B" labels) and
 * Google Meet's (REAL names, device-level attribution, same nominal timebase
 * — the recording start is the anchor used when capturing actuals).
 *
 * `content` is whatever the resolver served (callers get it from
 * `getContentCached`), so its ms are MEETING time; Meet's sidecar is in the
 * same timebase because the anchor is the recording start either way. This
 * module stays pure over the two utterance lists — it has no business
 * knowing which recordings they came from.
 *
 * Overlap voting lives in `lib/meet-align-vote.ts`, which also explains why
 * each Meet window is weighted by its character density instead of counting
 * for its full duration: the windows are caption flushes or interpolated
 * Doc blocks, not turns. A decisive winner (share of voted time >= 60%,
 * >= 20 s of density-weighted overlap) names that speaker.
 *
 * Pooled-room detection: Meet attributes per DEVICE, so five people on one
 * meeting-room mic are a single Meet name. If one Meet name decisively wins
 * MULTIPLE AAI speakers, those are different voices behind one device —
 * naming them all after the device owner would be wrong, so all of them are
 * dropped (voiceprints / manual naming take over).
 */

const MIN_SHARE = 0.6;
const MIN_OVERLAP_MS = 20_000;

export { computeMeetAlignment };
export type { AlignmentVote };

/**
 * Run the alignment and merge decisive results into the transcript's
 * speaker suggestions. Never overrides confirmed labels or voiceprint
 * matches. Returns the number of suggestions written.
 */
export async function suggestSpeakersFromMeet(
  ownerUserId: string,
  assemblyaiId: string,
  content: TranscriptResponse,
  meetUtterances: MeetUtterance[]
): Promise<number> {
  const aaiUtterances = (content.utterances ?? []).map((u) => ({
    speaker: u.speaker,
    start: u.start,
    end: u.end,
  }));
  if (aaiUtterances.length === 0 || meetUtterances.length === 0) return 0;

  const alignment = computeMeetAlignment(aaiUtterances, meetUtterances);

  // Decisive winners only.
  const decisive = new Map<string, AlignmentVote>();
  for (const [speaker, vote] of alignment) {
    if (vote.share >= MIN_SHARE && vote.overlapMs >= MIN_OVERLAP_MS) {
      decisive.set(speaker, vote);
    }
  }
  if (decisive.size === 0) return 0;

  // Pooled-room detection: one Meet name decisively claiming 2+ AAI speakers.
  const byName = new Map<string, string[]>();
  for (const [speaker, vote] of decisive) {
    const list = byName.get(vote.name) ?? [];
    list.push(speaker);
    byName.set(vote.name, list);
  }
  for (const [name, speakers] of byName) {
    if (speakers.length > 1) {
      console.log(
        `[meet-align] ${assemblyaiId}: "${name}" spans ${speakers.length} diarized speakers (pooled room) — skipping`
      );
      for (const s of speakers) decisive.delete(s);
    }
  }
  if (decisive.size === 0) return 0;

  const mappings = await getMappingsForUser(ownerUserId, assemblyaiId);
  const confirmed = new Set(
    (mappings?.speaker_labels ?? [])
      .filter((l) => l.customName.trim())
      .map((l) => l.originalSpeaker)
  );
  const merged: SpeakerSuggestionMap = { ...(mappings?.suggestions ?? {}) };

  let written = 0;
  for (const [speaker, vote] of decisive) {
    if (confirmed.has(speaker)) continue;
    // Voiceprint matches outrank timeline overlap.
    if (merged[speaker]?.source === 'voice') continue;
    merged[speaker] = {
      name: vote.name,
      confidence: Math.round(vote.share * 100) / 100,
      source: 'context',
      evidence: `${Math.round(vote.share * 100)}% of this speaker's time lines up with ${vote.name}'s speech in the meeting's own named transcript`,
    };
    written++;
  }
  if (written > 0) {
    await setSuggestionsForUser(ownerUserId, assemblyaiId, merged);
    console.log(`[meet-align] ${assemblyaiId}: named ${written} speaker(s) from Meet overlap`);
  }
  return written;
}
