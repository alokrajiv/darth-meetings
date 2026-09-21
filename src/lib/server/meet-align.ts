import 'server-only';
import {
  getForUser as getMappingsForUser,
  setSuggestionsForUser,
} from '@/db-ops/speaker-mappings';
import type {
  GmeetContext,
  MeetUtterance,
  SpeakerSuggestionMap,
  TranscriptResponse,
} from '@/lib/format';
import { computeMeetAlignment, type AlignmentVote } from '@/lib/meet-align-vote';
import {
  planValveChecks,
  runVoiceValve,
  type PooledGroup,
  type ValveCheck,
} from '@/lib/meet-align-valve';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { canonicalMedia, localMsIn, type ResolvedMedia } from '@/lib/server/recordings';
import { embedSegmentsViaSidecar } from '@/lib/server/voiceprint';

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
 * What the pooled-room valve needs to look at audio: the meeting's files and
 * the context markers that say whether they sit on the sidecar's timeline.
 * Absent → the valve never runs and the rule behaves exactly as it always has.
 */
export interface MeetAlignVoiceContext {
  media: ResolvedMedia[];
  gmeetContext: GmeetContext | null;
}

/**
 * The release valve is OFF unless `MW_MEET_ALIGN_VOICE_VALVE` says otherwise.
 *
 * It is built and tested, and on the 2026-09-22 corpus it does not pay:
 * 17 of 19 pooled groups were checkable and 15 scored `split < 0.45` — those
 * rooms really do hold two voices — so at the eval's threshold the valve
 * rescued one name the owner's own labels call WRONG and no right ones
 * (docs/eval-meet-align-voice-valve-2026-09-22.md). Re-measure before
 * flipping this on; the corpus behind it is 23 labels.
 */
export function voiceValveEnabled(): boolean {
  const v = (process.env.MW_MEET_ALIGN_VOICE_VALVE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * A meeting whose media and Meet sidecar are NOT on one timeline: several
 * files, a concatenation, extra Meet videos, or a re-cut upload whose
 * canonical is windowed. The vote is already known to be unreliable on these
 * (dense-windows eval §6) and a snippet cut at a Meet window's ms would be
 * the wrong audio, so the valve refuses to look.
 */
function timelineShifted(voice: MeetAlignVoiceContext, primary: ResolvedMedia | null): boolean {
  const ctx = voice.gmeetContext;
  return (
    voice.media.length > 1 ||
    (ctx?.combinedParts ?? 0) > 0 ||
    (ctx?.videoParts?.length ?? 0) > 0 ||
    primary?.windowFromMs != null
  );
}

/**
 * Ask the audio whether each pooled Meet name really is two voices, and
 * return the labels whose suggestion survives (`split >= 0.45` = one voice =
 * the rule was a false alarm).
 *
 * Best-effort throughout: no media, a shifted timeline, a sidecar that is
 * down, too little dense speech — every one of those means "keep dropping",
 * never "keep the name".
 */
async function runPooledRoomValve(
  assemblyaiId: string,
  pooled: PooledGroup[],
  aaiUtterances: Array<{ speaker: string; start: number; end: number }>,
  meetUtterances: MeetUtterance[],
  voice: MeetAlignVoiceContext
): Promise<Set<string>> {
  const primary = canonicalMedia(voice.media) ?? voice.media[0] ?? null;
  let audioPath: string | null = null;
  try {
    audioPath = primary ? resolveAudioPath(primary.filename) : null;
  } catch {
    audioPath = null;
  }

  const plan = planValveChecks(pooled, {
    meetUtterances,
    aaiUtterances,
    hasLocalMedia: Boolean(audioPath && primary),
    timelineShifted: timelineShifted(voice, primary),
  });
  for (const s of plan.skipped) {
    console.log(
      `[meet-align] ${assemblyaiId}: voice valve skipped "${s.name}" (${s.reason}, alignment ${plan.alignment.toFixed(2)})`
    );
  }
  if (plan.candidates.length === 0 || !audioPath || !primary) return new Set();

  const log = (check: ValveCheck) => {
    const c = check.candidate;
    console.log(
      `[meet-align] ${assemblyaiId}: voice valve "${c.name}" split=${check.split === null ? 'n/a' : check.split.toFixed(3)} ` +
        `(${check.embeddings} snippets, ${c.denseWindows} dense windows, ${Math.round(c.denseMs / 1000)}s) -> ${check.verdict}`
    );
  };

  const checks = await runVoiceValve(
    plan,
    async (candidate) =>
      embedSegmentsViaSidecar(
        audioPath,
        candidate.snippets.map((sn) => ({
          start_ms: localMsIn(primary, sn.startMs),
          end_ms: localMsIn(primary, sn.endMs),
        }))
      ),
    log
  );

  const kept = new Set<string>();
  for (const check of checks) {
    if (check.verdict === 'single-voice') kept.add(check.candidate.winner);
  }
  return kept;
}

/**
 * Run the alignment and merge decisive results into the transcript's
 * speaker suggestions. Never overrides confirmed labels or voiceprint
 * matches. Returns the number of suggestions written.
 */
export async function suggestSpeakersFromMeet(
  ownerUserId: string,
  assemblyaiId: string,
  content: TranscriptResponse,
  meetUtterances: MeetUtterance[],
  /** The meeting's media, so the pooled-room rule can consult the audio
   * before it throws a name away. Omit and the rule behaves as it always
   * has; the valve is also off by default (`voiceValveEnabled`). */
  voice?: MeetAlignVoiceContext
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
  const pooled: PooledGroup[] = [];
  for (const [name, speakers] of byName) {
    if (speakers.length > 1) {
      console.log(
        `[meet-align] ${assemblyaiId}: "${name}" spans ${speakers.length} diarized speakers (pooled room) — skipping`
      );
      pooled.push({
        name,
        entries: speakers.map((s) => ({ speaker: s, vote: decisive.get(s)! })),
      });
      for (const s of speakers) decisive.delete(s);
    }
  }

  // The release valve: the rule above infers "two voices behind one device"
  // from the alignment alone. When there is local audio on the sidecar's own
  // timeline, ask the audio instead — one voice means the rule misfired and
  // the strongest label keeps its name.
  const rescued = new Set<string>();
  if (pooled.length > 0 && voice && voiceValveEnabled()) {
    try {
      const kept = await runPooledRoomValve(
        assemblyaiId,
        pooled,
        aaiUtterances,
        meetUtterances,
        voice
      );
      for (const group of pooled) {
        for (const entry of group.entries) {
          if (!kept.has(entry.speaker)) continue;
          decisive.set(entry.speaker, entry.vote);
          rescued.add(entry.speaker);
        }
      }
    } catch (err) {
      console.warn(`[meet-align] ${assemblyaiId}: voice valve failed:`, err);
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
    // `source` stays 'context' — it is the People card's filter key and the
    // rescue is still an overlap vote. What the voice check added goes in the
    // evidence, which is the sentence the card shows.
    const voiceNote = rescued.has(speaker)
      ? `; ${vote.name}'s own speech in this meeting sounds like one voice, so the shared-device guard was released (meet-align+voice)`
      : '';
    merged[speaker] = {
      name: vote.name,
      confidence: Math.round(vote.share * 100) / 100,
      source: 'context',
      evidence: `${Math.round(vote.share * 100)}% of this speaker's time lines up with ${vote.name}'s speech in the meeting's own named transcript${voiceNote}`,
    };
    written++;
  }
  if (written > 0) {
    await setSuggestionsForUser(ownerUserId, assemblyaiId, merged);
    console.log(`[meet-align] ${assemblyaiId}: named ${written} speaker(s) from Meet overlap`);
  }
  return written;
}
