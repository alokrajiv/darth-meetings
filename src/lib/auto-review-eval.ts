import type { SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';
import { splitSpeakerLabel } from '@/lib/recording-clips';

/**
 * The automatic speaker-review DECISION, factored out of
 * lib/server/auto-review.ts (2026-10-27) so it is one pure function with two
 * callers: the series / account auto-import path at completion, and the
 * grace-window auto-proceed for manual uploads (lib/auto-proceed.ts).
 *
 * Rule: every unnamed diarized speaker with at least MIN_UTTERANCES
 * utterances has a suggestion that is either a voiceprint match at
 * ≥ VOICE_MIN or the speaker-ID pass at ≥ ID_MIN. Human-confirmed names count
 * as named and are never overwritten; a label that is already a real name
 * (Meet Doc / Teams VTT imports) needs no resolution; a one-utterance speaker
 * is noise the human reviewer skips too.
 */

/** A voiceprint match (cosine similarity) this sure applies the name. */
export const VOICE_MIN = 0.62;
/** The speaker-ID pass's model-reported confidence this sure applies the name. */
export const ID_MIN = 0.85;
/** Speakers with fewer utterances than this may stay unnamed without blocking. */
export const MIN_UTTERANCES = 2;
/**
 * Enrollment is stricter than naming: a name applied at 0.65 is probably
 * right, but feeding that clip into the person's voiceprint would let a wrong
 * guess poison the print. Only matches this strong enrol; the rest are named
 * and left out of the print until a human confirms them.
 */
export const ENROLL_VOICE_MIN = 0.8;
export const ENROLL_ID_MIN = 0.9;

/**
 * AAI diarization labels look like "A" / "B" / "Speaker 1" — anything else is
 * already a real name (transcript-mode imports).
 *
 * A COMBINED meeting's labels carry the recording namespace
 * (`<recordingId>:A`, Phase 3b), so the prefix comes off first: without that
 * every speaker of a combined meeting reads as "already a real name" and the
 * automatic review would jump the gate having named nobody.
 */
export function isDiarizationLabel(speaker: string): boolean {
  const bare = splitSpeakerLabel(speaker.trim()).speaker.trim();
  return /^[A-Z]{1,2}$/.test(bare) || /^speaker\s*\d+$/i.test(bare);
}

export interface AutoReviewInput {
  utterances: ReadonlyArray<{ speaker: string }>;
  /** The saved labels (human-confirmed names among them). */
  labels: ReadonlyArray<SpeakerLabel>;
  suggestions: SpeakerSuggestionMap | null | undefined;
}

export interface AutoReviewEvaluation {
  passed: boolean;
  /** Why it did not pass — one sentence, the first blocker found. */
  blocker: string | null;
  /** The suggested names the pass would apply (none when blocked). */
  applied: SpeakerLabel[];
  /** The saved labels with `applied` merged in — what gets upserted. */
  merged: SpeakerLabel[];
  /**
   * The APPLIED names safe to ENROL voiceprints from — those whose suggestion
   * met the stricter enrolment thresholds. Human-confirmed names are not in
   * it: the PUT …/speakers that confirmed them enrolled this meeting already,
   * and enrolling it again would double-count. Always a subset of `applied`.
   */
  enroll: SpeakerLabel[];
}

/**
 * Pure. `passed` with an empty `applied` means everyone was already named (or
 * a real name) — nothing to apply, nothing in the way.
 *
 * One more blocker after the merge: two diarized speakers of this meeting
 * ending up with the SAME name (case-insensitive) — the AI putting one person
 * on two voices, or a guess colliding with a confirmed name. That is a
 * question for a human, on both paths.
 */
export function evaluateAutoReview(input: AutoReviewInput): AutoReviewEvaluation {
  const suggestions = input.suggestions ?? {};
  const existing = [...input.labels];
  const named = new Map(existing.filter((l) => l.customName.trim()).map((l) => [l.originalSpeaker, l]));

  const counts = new Map<string, number>();
  for (const u of input.utterances) counts.set(u.speaker, (counts.get(u.speaker) ?? 0) + 1);

  const applied: SpeakerLabel[] = [];
  const strong = new Set<string>();
  let blocker: string | null = null;
  for (const [speaker, n] of counts) {
    if (named.has(speaker)) continue; // human (or a prior pass) already named it
    if (!isDiarizationLabel(speaker)) continue; // already a real name
    if (n < MIN_UTTERANCES) continue; // noise speaker — reviewers skip these too
    const s = suggestions[speaker];
    const confident =
      !!s?.name?.trim() &&
      ((s.source === 'voice' && s.confidence >= VOICE_MIN) ||
        (s.via === 'id' && s.confidence >= ID_MIN));
    if (!confident) {
      blocker = s?.name
        ? `"${speaker}" → ${s.name} only at ${(s.confidence * 100).toFixed(0)}% (${s.via === 'id' ? 'AI pass' : (s.source ?? 'context')})`
        : `no confident identification for speaker "${speaker}"`;
      break;
    }
    applied.push({ originalSpeaker: speaker, customName: s!.name.trim(), description: '' });
    const strongEnough =
      (s!.source === 'voice' && s!.confidence >= ENROLL_VOICE_MIN) ||
      (s!.via === 'id' && s!.confidence >= ENROLL_ID_MIN);
    if (strongEnough) strong.add(speaker);
  }

  if (blocker) return { passed: false, blocker, applied: [], merged: existing, enroll: [] };

  const merged = [...existing];
  for (const l of applied) {
    const i = merged.findIndex((e) => e.originalSpeaker === l.originalSpeaker);
    if (i >= 0) merged[i] = { ...merged[i]!, customName: l.customName };
    else merged.push(l);
  }

  // Duplicate names among the speakers of THIS meeting (a stale label for a
  // speaker with no utterances here does not count).
  const firstSpelling = new Map<string, string>();
  for (const l of merged) {
    if (!counts.has(l.originalSpeaker)) continue;
    const name = l.customName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const seen = firstSpelling.get(key);
    if (seen !== undefined) {
      return {
        passed: false,
        blocker: `two speakers both identified as ${seen}`,
        applied: [],
        merged: existing,
        enroll: [],
      };
    }
    firstSpelling.set(key, name);
  }

  const enroll = applied.filter((l) => strong.has(l.originalSpeaker));
  return { passed: true, blocker: null, applied, merged, enroll };
}
