/**
 * "Is this transcription probably a mixed-language call read in ONE
 * language?" — the signal an agent (or a person) reads before deciding to run
 * a second pass and merge (docs/transcription-merge-spec.md §2).
 *
 * Three independent tells, any one of which is enough:
 *  - a big share of the speech sits in utterances the recogniser itself was
 *    unsure of (the English pass on Indonesian speech: < 0.75);
 *  - an English transcript containing Thai / Devanagari / CJK script or
 *    Vietnamese-only letters — what AssemblyAI invents when it hears a
 *    language it was not told about (row 1134: 34 such lines in 31 minutes);
 *  - auto-detection that was itself unsure of the language (row 1134: 0.28).
 *
 * Pure and client-safe.
 */

import type { TranscriptResponse } from '@/lib/format';

export interface TranscriptHealth {
  /** `payload.confidence` — AssemblyAI's mean word confidence. */
  asrConfidence: number | null;
  /** `payload.language_confidence` — only present when the language was detected. */
  languageConfidence: number | null;
  /** Share of SPEECH time (the sum of utterance durations) in utterances whose
   * mean word confidence is below 0.75. */
  lowConfidenceShare: number;
  /** Share of utterances containing foreign script, when the payload is en*; 0 otherwise. */
  foreignScriptShare: number;
  mixedLanguageSuspected: boolean;
}

export const LOW_UTTERANCE_CONFIDENCE = 0.75;
export const LOW_CONFIDENCE_SHARE_TRIGGER = 0.1;
export const FOREIGN_SCRIPT_SHARE_TRIGGER = 0.03;
export const LANGUAGE_CONFIDENCE_TRIGGER = 0.5;

/**
 * Scripts an English transcript has no business containing: Thai,
 * Devanagari, Hiragana/Katakana, CJK ideographs, Hangul — and the letters
 * only Vietnamese uses (ơ ư ă đ and the stacked-tone block U+1EA0–U+1EF9).
 * Plain accented Latin (é, ü) is NOT here: names and loanwords carry it.
 */
const FOREIGN_SCRIPT_RE =
  /[฀-๿ऀ-ॿ぀-ヿ㐀-䶿一-鿿가-힯ƠơƯưĂăĐđẠ-ỹ]/;

export function hasForeignScript(text: string): boolean {
  return FOREIGN_SCRIPT_RE.test(text);
}

type HealthUtterance = NonNullable<TranscriptResponse['utterances']>[number] & {
  words?: Array<{ confidence?: number }>;
  confidence?: number;
};

/** Mean word confidence of an utterance; its own `confidence` when it has no words. */
function utteranceConfidence(u: HealthUtterance): number | null {
  const ws = (u.words ?? []).filter((w) => typeof w.confidence === 'number');
  if (ws.length > 0) return ws.reduce((a, w) => a + (w.confidence as number), 0) / ws.length;
  return typeof u.confidence === 'number' ? u.confidence : null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function transcriptHealth(payload: TranscriptResponse): TranscriptHealth {
  const utterances = (payload.utterances ?? []) as HealthUtterance[];

  let speechMs = 0;
  let lowMs = 0;
  for (const u of utterances) {
    const ms = Math.max(0, (u.end ?? 0) - (u.start ?? 0));
    speechMs += ms;
    const c = utteranceConfidence(u);
    if (c !== null && c < LOW_UTTERANCE_CONFIDENCE) lowMs += ms;
  }
  const lowConfidenceShare = speechMs > 0 ? lowMs / speechMs : 0;

  const english = (payload.language_code ?? '').toLowerCase().startsWith('en');
  const foreign = english ? utterances.filter((u) => hasForeignScript(u.text ?? '')).length : 0;
  const foreignScriptShare = english && utterances.length > 0 ? foreign / utterances.length : 0;

  const languageConfidence = num(payload.language_confidence);
  const detectedUnsure =
    payload.language_detection === true &&
    languageConfidence !== null &&
    languageConfidence < LANGUAGE_CONFIDENCE_TRIGGER;

  // A MERGED version is the remedy already applied (lib/transcript-merge.ts):
  // it inherits its base's unsure detection verbatim, and the fill words it
  // carries are a forced pass's (0.6-ish confidence even when right). Its
  // shares are still reported, but flagging it would send an agent round the
  // "run a second pass and merge" loop forever.
  const merged = !!(payload as { merge?: unknown }).merge;

  return {
    asrConfidence: num(payload.confidence),
    languageConfidence,
    lowConfidenceShare,
    foreignScriptShare,
    mixedLanguageSuspected:
      !merged &&
      (lowConfidenceShare >= LOW_CONFIDENCE_SHARE_TRIGGER ||
        foreignScriptShare >= FOREIGN_SCRIPT_SHARE_TRIGGER ||
        detectedUnsure),
  };
}
