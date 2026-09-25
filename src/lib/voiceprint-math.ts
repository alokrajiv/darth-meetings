/**
 * The pure half of voiceprints: which speech to embed, how samples combine,
 * which spelling names an identity, and how a match verdict reads in the log.
 * No I/O, client-safe — shared by `lib/server/voiceprint.ts`,
 * `db-ops/voiceprints.ts` and `scripts/rebuild-voiceprints.ts`.
 *
 * Why duration matters (2026-09-24, "rescore the fingerprints on long rants"):
 * ECAPA averages per-segment embeddings, and a print built from 90 s of
 * someone talking is far steadier than one built from 6 × 2 s of "yeah, ok".
 * So the picker takes speech by a TIME budget, and enrolment weights each
 * sample by the seconds behind it instead of counting every meeting as one.
 */

import { personNameKey } from '@/lib/person-identity';

/** Shorter utterances are mostly backchannel ("yes", "mm") — useless for ECAPA. */
export const MIN_UTTERANCE_MS = 1500;
/** Stop picking once this much speech is in hand… */
export const SPEECH_BUDGET_MS = 90_000;
/** …or this many segments (= voiceprint/server.py MAX_SEGMENTS). */
export const MAX_PICKED_SEGMENTS = 12;
/** The sidecar embeds at most this much of any one segment (MAX_SEGMENT_MS). */
export const SIDECAR_MAX_SEGMENT_MS = 20_000;
/** One sample never counts for more than this, so a 2-hour monologue cannot own a print. */
export const MAX_SAMPLE_WEIGHT_SECS = 180;

export interface TimedUtterance {
  start: number;
  end: number;
  speaker: string;
}

export interface PickedSpeech<U extends TimedUtterance> {
  /** Longest first. */
  utterances: U[];
  /** Seconds of audio the sidecar will actually embed (each segment capped at 20 s). */
  seconds: number;
  /** The speaker's longest utterance, any length — for the "no-segment(0.8s)" verdict. */
  longestMs: number;
}

/**
 * The speaker's longest utterances (≥ 1.5 s), longest first, until 90 s of
 * speech or 12 segments — whichever comes first. The longest one is always
 * taken when it qualifies, however long it is.
 */
export function pickSpeechByBudget<U extends TimedUtterance>(
  utterances: readonly U[],
  speaker: string
): PickedSpeech<U> {
  const mine = utterances.filter((u) => u.speaker === speaker);
  const longestMs = mine.reduce((m, u) => Math.max(m, u.end - u.start), 0);
  const eligible = mine
    .filter((u) => u.end - u.start >= MIN_UTTERANCE_MS)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const picked: U[] = [];
  let usedMs = 0;
  for (const u of eligible) {
    if (picked.length >= MAX_PICKED_SEGMENTS || usedMs >= SPEECH_BUDGET_MS) break;
    picked.push(u);
    usedMs += Math.min(u.end - u.start, SIDECAR_MAX_SEGMENT_MS);
  }
  return { utterances: picked, seconds: usedMs / 1000, longestMs };
}

/** How much one sample of `seconds` counts in a running mean. */
export function sampleWeight(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, MAX_SAMPLE_WEIGHT_SECS);
}

/**
 * The weight behind a stored print. Rows enrolled before migration 050 have
 * `weight_secs = 0`; they fall back to their sample count.
 */
export function storedWeight(row: { weight_secs?: number | null; sample_count: number }): number {
  const w = Number(row.weight_secs ?? 0);
  return w > 0 ? w : Math.max(0, row.sample_count);
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** `(old·W + next·w) / (W + w)`, re-normalised to unit length. */
export function weightedMerge(
  old: readonly number[],
  oldWeight: number,
  next: readonly number[],
  nextWeight: number
): number[] {
  const total = oldWeight + nextWeight;
  if (!(total > 0)) return normalize([...next]);
  return normalize(old.map((v, i) => (v * oldWeight + (next[i] ?? 0) * nextWeight) / total));
}

/** Invisible characters out, single spaces, trimmed — the spelling as a person would type it. */
export function cleanDisplayName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Karnica Katiyar" rather than "karnica.katiyar": has a space and a capital. */
export function looksLikeDisplayName(name: string): boolean {
  return /\s/.test(name) && /\p{Lu}/u.test(name);
}

/**
 * The spelling an identity is shown under: the most-used spelling that has a
 * space and capitals, else the most-used spelling of all. Ties go to the
 * longer, then the alphabetically first, so the choice is deterministic.
 */
export function chooseDisplayName(spellings: ReadonlyMap<string, number>): string {
  const all = [...spellings.entries()].filter(([n]) => n.trim());
  if (all.length === 0) return '';
  const pretty = all.filter(([n]) => looksLikeDisplayName(n));
  const pool = pretty.length > 0 ? pretty : all;
  pool.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
  return pool[0]![0];
}

/** A stored print keeps its name unless the incoming spelling is the nicer one. */
export function preferDisplayName(current: string, incoming: string): string {
  const next = cleanDisplayName(incoming);
  if (!next) return current;
  if (looksLikeDisplayName(current) && !looksLikeDisplayName(next)) return current;
  return next;
}

export interface VoiceSample {
  /** The confirmed label as typed. */
  name: string;
  embedding: number[];
  /** Seconds of speech behind the embedding (uncapped). */
  seconds: number;
}

export interface AggregatedIdentity {
  key: string;
  name: string;
  /** Cleaned spelling → labels carrying it. */
  spellings: Map<string, number>;
  embedding: number[];
  /** Σ capped sample weights — what goes into `weight_secs`. */
  weightSecs: number;
  /** Σ raw seconds, for the report. */
  seconds: number;
  samples: number;
}

/**
 * Fold samples into one print per `personNameKey`: a duration-weighted mean
 * (each sample capped at 180 s), normalised once at the end. `extraSpellings`
 * lets the caller count spellings from labels that yielded no audio, so the
 * display name reflects every confirmed label, not just the embeddable ones.
 */
export function aggregateSamples(
  samples: readonly VoiceSample[],
  extraSpellings: readonly string[] = []
): AggregatedIdentity[] {
  const byKey = new Map<string, { sum: number[]; weight: number; seconds: number; samples: number; spellings: Map<string, number> }>();
  const bump = (m: Map<string, number>, n: string) => m.set(n, (m.get(n) ?? 0) + 1);

  for (const s of samples) {
    const key = personNameKey(s.name);
    if (!key) continue;
    let acc = byKey.get(key);
    if (!acc) {
      acc = { sum: new Array(s.embedding.length).fill(0), weight: 0, seconds: 0, samples: 0, spellings: new Map() };
      byKey.set(key, acc);
    }
    const w = sampleWeight(s.seconds);
    s.embedding.forEach((v, i) => (acc!.sum[i] = (acc!.sum[i] ?? 0) + v * w));
    acc.weight += w;
    acc.seconds += s.seconds;
    acc.samples += 1;
    bump(acc.spellings, cleanDisplayName(s.name));
  }
  for (const n of extraSpellings) {
    const acc = byKey.get(personNameKey(n));
    if (acc) bump(acc.spellings, cleanDisplayName(n));
  }

  return [...byKey.entries()]
    .filter(([, a]) => a.weight > 0)
    .map(([key, a]) => ({
      key,
      name: chooseDisplayName(a.spellings),
      spellings: a.spellings,
      embedding: normalize(a.sum),
      weightSecs: a.weight,
      seconds: a.seconds,
      samples: a.samples,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One speaker's outcome in `suggestSpeakersForTranscript`, for the log line. */
export type SpeakerVerdict =
  | {
      kind: 'match';
      name: string;
      score: number;
      /** Set when a margin tie was broken by the call roster — see `resolveMarginByRoster`. */
      rosterOver?: { name: string; score: number };
      /** The meeting has an invite and this person is not on it (kept: the score cleared OFF_ROSTER_MIN_SCORE). */
      offRoster?: boolean;
    }
  | {
      /** A match to someone NOT on the invite, too weak to surface (`decideVoiceMatch`). */
      kind: 'off-roster';
      best: { name: string; score: number };
      second?: { name: string; score: number };
    }
  | { kind: 'below-threshold'; best: { name: string; score: number } | null }
  | { kind: 'margin'; best: { name: string; score: number }; second: { name: string; score: number } }
  | { kind: 'no-segment'; longestMs: number }
  | { kind: 'no-media' }
  | { kind: 'error' };

const two = (n: number) => n.toFixed(2);

export function formatVerdict(speaker: string, v: SpeakerVerdict): string {
  switch (v.kind) {
    case 'match':
      return v.rosterOver
        ? `${speaker}=${v.name} ${two(v.score)} ✓ (on the call; over ${v.rosterOver.name} ${two(v.rosterOver.score)})`
        : v.offRoster
          ? `${speaker}=${v.name} ${two(v.score)} ✓ (not on the invite)`
          : `${speaker}=${v.name} ${two(v.score)} ✓`;
    case 'off-roster':
      return v.second
        ? `${speaker}=off-roster(${v.best.name} ${two(v.best.score)} vs ${v.second.name} ${two(v.second.score)}, neither invited)`
        : `${speaker}=off-roster(${v.best.name} ${two(v.best.score)}, not invited)`;
    case 'below-threshold':
      return v.best
        ? `${speaker}=below-threshold(best ${v.best.name} ${two(v.best.score)})`
        : `${speaker}=below-threshold`;
    case 'margin':
      return `${speaker}=margin(${v.best.name} ${two(v.best.score)} vs ${v.second.name} ${two(v.second.score)})`;
    case 'no-segment':
      return `${speaker}=no-segment(${(v.longestMs / 1000).toFixed(1)}s)`;
    case 'no-media':
      return `${speaker}=no-media`;
    case 'error':
      return `${speaker}=error`;
  }
}

/**
 * Break a margin tie with WHO WAS ON THE CALL.
 *
 * The margin guard exists because two enrolled prints can score alike on one
 * voice; when the recorder (or the calendar) says who the participants were,
 * a candidate that is on that roster beats one that is not — the rival is
 * a print of someone who was not in the room. Returns the winner only when
 * EXACTLY one of the two is on the roster (both on it, or neither: still
 * ambiguous, the caller keeps the 'margin' verdict).
 *
 * 2026-09-25, transcript 973: A = Yadu N M 0.77 vs "Pratiksha Mali" 0.72 on a
 * WhatsApp call titled "Yadu N M - WhatsApp voice call". The rival print was
 * Yadu's own voice enrolled under Pratiksha's name from Meet imports where
 * the two share a room mic (cosine 0.87 to Yadu's print, 0.60 to the real
 * pratiksha's) — the roster is the only signal that could tell them apart.
 */
export function resolveMarginByRoster(
  best: { name: string; score: number },
  second: { name: string; score: number },
  roster: readonly string[],
  samePerson: (a: string, b: string) => boolean
): { name: string; score: number } | null {
  if (roster.length === 0) return null;
  const onRoster = (name: string) => roster.some((r) => samePerson(r, name));
  const bestOn = onRoster(best.name);
  const secondOn = onRoster(second.name);
  if (bestOn === secondOn) return null;
  return bestOn ? best : second;
}


/**
 * A voice match below this is WEAK: the review UI says so, and the speaker-ID
 * pass may overrule it at a modest confidence (lib/speaker-id-merge.ts).
 * Observed on prod: genuine cross-meeting matches mostly score 0.7+; the two
 * wrong guesses on transcript 980 scored 0.53 and 0.63.
 */
export const WEAK_VOICE_SCORE = 0.7;

/**
 * A voice match to someone who is NOT on the meeting's invite is surfaced only
 * at or above this score. 2026-09-25, transcript 980 (a Teams call with nine
 * invitees, mostly Danone): "Yan-Simon Saragih 0.53" and "Hitesh Ambaliya
 * 0.63" — Trames colleagues who were not on the call — were surfaced as
 * guesses; the invited Ivan Seow scored 0.91. An uninvited colleague who
 * really joined still clears 0.75 when their print is any good. Tune with
 * MW_VOICEPRINT_OFF_ROSTER_MIN.
 */
export const OFF_ROSTER_MIN_SCORE = 0.75;

/**
 * Is the roster worth gating on? Only when it names people BESIDES the
 * recording owner (an invite, a call counterpart) — an ad-hoc call with no
 * invite has a roster of one, and gating on it would reject every other voice.
 */
export function rosterIsInformative(roster: readonly string[]): boolean {
  return roster.length >= 2;
}

export interface VoiceDecision {
  verdict: SpeakerVerdict;
  /** What to surface as the speaker's voice suggestion, or null. */
  suggestion: { name: string; score: number; offRoster?: boolean } | null;
}

/**
 * The whole verdict for one speaker from its scored candidates (best first,
 * `second` = best-scoring DISTINCT person). Pure so the rules are tested:
 *
 *   1. below `threshold` → nothing;
 *   2. within `margin` of the runner-up → ambiguous, unless the roster
 *      settles it (`resolveMarginByRoster`); when NEITHER is invited on a
 *      meeting with an invite, it reads as off-roster;
 *   3. a clear winner who is not on an informative roster → surfaced only at
 *      `offRosterMin` or above, flagged `offRoster`; otherwise an
 *      'off-roster' verdict (the ID pass still sees it in the verdict line);
 *   4. otherwise a match.
 */
export function decideVoiceMatch(
  best: { name: string; score: number },
  second: { name: string; score: number } | undefined,
  opts: {
    threshold: number;
    margin: number;
    roster: readonly string[];
    samePerson: (a: string, b: string) => boolean;
    offRosterMin?: number;
  }
): VoiceDecision {
  const offRosterMin = opts.offRosterMin ?? OFF_ROSTER_MIN_SCORE;
  const gate = rosterIsInformative(opts.roster);
  const invited = (name: string) => opts.roster.some((r) => opts.samePerson(r, name));

  if (best.score < opts.threshold) {
    return { verdict: { kind: 'below-threshold', best }, suggestion: null };
  }
  if (second && best.score - second.score < opts.margin) {
    const winner = resolveMarginByRoster(best, second, opts.roster, opts.samePerson);
    if (winner && winner.score >= opts.threshold) {
      const loser = winner === best ? second : best;
      return {
        verdict: { kind: 'match', name: winner.name, score: winner.score, rosterOver: loser },
        suggestion: { name: winner.name, score: winner.score },
      };
    }
    if (gate && !invited(best.name) && !invited(second.name)) {
      return { verdict: { kind: 'off-roster', best, second }, suggestion: null };
    }
    return { verdict: { kind: 'margin', best, second }, suggestion: null };
  }
  if (gate && !invited(best.name)) {
    if (best.score >= offRosterMin) {
      return {
        verdict: { kind: 'match', name: best.name, score: best.score, offRoster: true },
        suggestion: { name: best.name, score: best.score, offRoster: true },
      };
    }
    return { verdict: { kind: 'off-roster', best }, suggestion: null };
  }
  return {
    verdict: { kind: 'match', name: best.name, score: best.score },
    suggestion: { name: best.name, score: best.score },
  };
}
