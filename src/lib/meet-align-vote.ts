import type { MeetUtterance } from '@/lib/format';

/**
 * The overlap vote behind Meet ↔ AssemblyAI speaker alignment.
 *
 * Pure and dependency-free (no `server-only`) so it can be unit-tested
 * directly and re-run offline against exported prod rows;
 * `lib/server/meet-align.ts` owns the IO around it.
 *
 * ## Why the windows are weighted by character density
 *
 * `meetTranscript.utterances` is NOT a list of speaker turns, whatever its
 * shape suggests. It has three producers and only one of them is turn-level:
 *
 *  - **Meet REST API entries** (`actuals.transcriptEntries`, the preferred
 *    source at import) are ~30-second CAPTION-FLUSH windows — median span
 *    26 s, exactly contiguous per participant, so once someone's caption
 *    stream opens it tiles their whole session. Different names' windows
 *    therefore overlap each other heavily (median 88% in the 2026-09-21
 *    eval), and `utterancesFromEntries` then merges consecutive same-speaker
 *    entries, making them longer still.
 *  - **The Meet transcript Doc** carries only 5-minute block timestamps;
 *    `parseMeetTranscriptDoc` interpolates inside a block by character
 *    weight. A block the speakers actually filled interpolates well; a block
 *    that was mostly silence does not.
 *  - **Teams VTT cues** are real turn-level cues.
 *
 * A flat overlap vote treats all three as speech, so on the caption-window
 * source every AAI speaker overlaps every name and the vote is decided by
 * whose captions tile more of the meeting. What rescues it is the entry's
 * character COUNT: continuous speech runs at ~15 chars/s (the Doc parser
 * assumes 14), so `chars / span` says how much of its own window the named
 * person actually filled. A window is therefore worth that fraction, not its
 * full duration.
 *
 * Measured over the 46 prod rows this code runs on (docs/eval-meet-align-
 * dense-windows-2026-09-22.md): on the caption-window source the vote goes
 * from 3 suggestions at 0.67 precision to 14 at 0.93, and on the Doc source
 * nothing regresses (0.95 → 0.96 precision, same coverage). A HARD dense-only
 * cut — the shared-mic eval's rule — was measured too and is worse overall:
 * it costs 12 good Doc-derived suggestions.
 */

/** Characters per second of continuous speech. A window whose text implies
 * at least this rate counts for its whole duration. */
export const DENSITY_REF_CHARS_PER_S = 15;

/** Below this a window is caption noise (a backchannel inside someone else's
 * 30-second flush) and is worth nothing. */
export const MIN_DENSITY_CHARS_PER_S = 2;

/** A sidecar whose windows never reach this density carries no usable text
 * signal at all — a producer that stored times without text, say. Weighting
 * would silence it entirely, so the vote falls back to flat overlap. */
const SIGNAL_PRESENT_CHARS_PER_S = MIN_DENSITY_CHARS_PER_S;

export interface AlignmentVote {
  name: string;
  share: number;
  /** Density-weighted overlap with the winning name, in ms of speech-equivalent
   * time — NOT wall-clock overlap. */
  overlapMs: number;
}

/**
 * How much one Meet window is worth: the fraction of it the named speaker
 * could have filled at `DENSITY_REF_CHARS_PER_S`, clamped to [0, 1], and 0
 * below `MIN_DENSITY_CHARS_PER_S`.
 */
export function windowWeight(spanMs: number, textLength: number): number {
  if (spanMs <= 0) return 0;
  const density = textLength / (spanMs / 1000);
  if (density < MIN_DENSITY_CHARS_PER_S) return 0;
  return Math.min(1, density / DENSITY_REF_CHARS_PER_S);
}

/** True when at least one window carries enough text for density to mean
 * anything. False → weighting is skipped (every window counts flat). */
export function hasDensitySignal(meetUtterances: MeetUtterance[]): boolean {
  for (const m of meetUtterances) {
    const span = m.end - m.start;
    if (span > 0 && m.text.length / (span / 1000) >= SIGNAL_PRESENT_CHARS_PER_S) return true;
  }
  return false;
}

export function computeMeetAlignment(
  aaiUtterances: Array<{ speaker: string; start: number; end: number }>,
  meetUtterances: MeetUtterance[]
): Map<string, AlignmentVote> {
  const meet = [...meetUtterances].sort((a, b) => a.start - b.start);
  const weighted = hasDensitySignal(meet);
  const weights = meet.map((m) => (weighted ? windowWeight(m.end - m.start, m.text.length) : 1));
  const votes = new Map<string, Map<string, number>>();

  let mi = 0;
  const aai = [...aaiUtterances].sort((a, b) => a.start - b.start);
  for (const u of aai) {
    // advance to the first meet utterance that could overlap
    while (mi < meet.length && meet[mi]!.end <= u.start) mi++;
    for (let j = mi; j < meet.length && meet[j]!.start < u.end; j++) {
      const w = weights[j]!;
      if (w <= 0) continue;
      const m = meet[j]!;
      const overlap = Math.min(u.end, m.end) - Math.max(u.start, m.start);
      if (overlap <= 0) continue;
      let perName = votes.get(u.speaker);
      if (!perName) {
        perName = new Map();
        votes.set(u.speaker, perName);
      }
      perName.set(m.speaker, (perName.get(m.speaker) ?? 0) + overlap * w);
    }
  }

  const result = new Map<string, AlignmentVote>();
  for (const [speaker, perName] of votes) {
    let total = 0;
    let topName = '';
    let topMs = 0;
    for (const [name, ms] of perName) {
      total += ms;
      if (ms > topMs) {
        topMs = ms;
        topName = name;
      }
    }
    if (total === 0 || !topName) continue;
    result.set(speaker, { name: topName, share: topMs / total, overlapMs: topMs });
  }
  return result;
}
