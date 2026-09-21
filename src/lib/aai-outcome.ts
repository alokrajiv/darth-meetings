/**
 * What AssemblyAI actually did with a transcription job, read out of the
 * frozen response we already store on the row (`imported_content`).
 *
 * Why this exists: we ask for Universal-3.5 Pro, but AAI silently runs
 * Universal-2 when the detected language is outside 3.5 Pro's 18
 * code-switching languages. On a majority-Indonesian call that downgrade
 * also *translates* the English stretches into Indonesian — the reader sees
 * words nobody said. Until 2026-09-21 the row only stored what we ASKED for
 * (`speech_model`), so the Sources card confidently named the wrong model
 * and dropped AAI's own warnings on the floor.
 * Evidence + experiments: docs/eval-aai-code-switching-2026-09-21.md.
 *
 * No new columns: every field here is already inside the cached AAI payload
 * that the detail page receives, and no listing surfaces them. Pure and
 * client-safe — do not import server-only things here.
 */

import {
  DEFAULT_SPEECH_MODEL,
  canonicalSpeechModel,
  keytermsSupported,
  speechModelLabel,
} from '@/lib/aai-language';
import type { TranscriptResponse } from '@/lib/format';

/** Mean per-word ASR confidence under which we tell the reader not to trust
 * the wording. The 5 forced-Indonesian rows sit at 0.61, the 341 English
 * rows at 0.94 — the gap makes this a reliable automatic trigger. */
export const LOW_ASR_CONFIDENCE = 0.8;

/** Why an outcome is worth flagging, strongest first. */
export type AaiOutcomeReason =
  | 'downgraded'
  | 'non-english'
  | 'low-confidence'
  | 'keyterms-dropped'
  | 'warnings';

export interface AaiOutcome {
  /** Model we asked AAI for (the row's `speech_model`), canonical id. */
  requested: string | null;
  /** Model AAI actually ran (`speech_model_used`), canonical id. */
  used: string | null;
  /** AAI ran a different model than the one we asked for. */
  downgraded: boolean;
  /** Language the transcript was produced in ('id', 'en_us', …). */
  languageCode: string | null;
  /** AAI chose the language itself (we sent `language_detection`). */
  languageDetected: boolean;
  /** Detector confidence, 0–1; null when we forced the language. */
  languageConfidence: number | null;
  /** Mean per-word ASR confidence, 0–1; null on payloads without it. */
  asrConfidence: number | null;
  /** AAI's own warnings about the job, verbatim. */
  warnings: string[];
  /** How many attendee-name hints we sent. */
  keytermsSent: number;
  /** AAI ignored that hint list (it is English-only on Universal-2). */
  keytermsDropped: boolean;
  /** AAI job id, for support tickets. */
  jobId: string | null;
  /** Ordered, strongest first; empty = nothing to say beyond the plain line. */
  reasons: AaiOutcomeReason[];
  /** `reasons.length > 0`. */
  noteworthy: boolean;
}

/** The row shape this reads — a subset of StoredTranscript. */
export interface AaiOutcomeSource {
  assemblyai_id?: string | null;
  /** What we asked for, as stored at submit time. */
  speech_model?: string | null;
  language_code?: string | null;
  imported_content?: TranscriptResponse | null;
}

const ENGLISH_ISH = (code: string | null): boolean =>
  !!code && keytermsSupported(code);

/**
 * Derive the outcome. Never throws and never returns null: rows with no AAI
 * payload (quick Meet/Teams imports, freshly submitted jobs, pre-2026
 * cached payloads) come back with nulls and `noteworthy: false`.
 */
export function aaiOutcome(row: AaiOutcomeSource): AaiOutcome {
  const c = row.imported_content ?? null;

  // Rows that never ran AAI (quick Meet/Teams imports) have a payload with
  // none of these fields — they must stay null, not read as Universal-2.
  const requested = canonicalSpeechModel(
    row.speech_model ?? c?.speech_models?.[0] ?? c?.speech_model ?? null
  );
  const used = canonicalSpeechModel(c?.speech_model_used ?? null);
  const downgraded = !!requested && !!used && requested !== used;

  const languageCode = c?.language_code ?? row.language_code ?? null;
  const languageDetected = c?.language_detection === true;
  const languageConfidence = numberOrNull(c?.language_confidence);
  const asrConfidence = numberOrNull(c?.confidence);

  const warnings = (c?.metadata?.warnings ?? [])
    .map((w) => (typeof w?.message === 'string' ? w.message.trim() : ''))
    .filter((m) => m.length > 0);

  const keytermsSent = c?.keyterms_prompt?.length ?? 0;
  // Two tells, either is enough: AAI says so, or we sent a bias list for a
  // language it only honours in English.
  const keytermsDropped =
    keytermsSent > 0 &&
    (warnings.some((w) => /keyterms_prompt/i.test(w)) || !ENGLISH_ISH(languageCode));

  const reasons: AaiOutcomeReason[] = [];
  if (downgraded) reasons.push('downgraded');
  if (languageCode && !ENGLISH_ISH(languageCode)) reasons.push('non-english');
  // An ASR confidence of exactly 0 means AAI heard nothing at all (empty
  // transcript) — a different problem, and not one this card explains.
  if (asrConfidence !== null && asrConfidence > 0 && asrConfidence < LOW_ASR_CONFIDENCE) {
    reasons.push('low-confidence');
  }
  if (keytermsDropped) reasons.push('keyterms-dropped');
  if (warnings.some(affectsTheText)) reasons.push('warnings');

  return {
    requested,
    used,
    downgraded,
    languageCode,
    languageDetected,
    languageConfidence,
    asrConfidence,
    warnings,
    keytermsSent,
    keytermsDropped,
    jobId: c?.id ?? row.assemblyai_id ?? null,
    reasons,
    noteworthy: reasons.length > 0,
  };
}

/**
 * Not every AAI warning is about the transcript. "For highest accuracy and
 * broadest language coverage: set speech_models to […]" is a nudge aimed at
 * US, the operator — it sits on ~300 perfectly good English rows and must
 * not put an amber note in front of a reader. It still shows verbatim under
 * Advanced details; acting on it is what speechModelsRequest() does.
 */
function affectsTheText(warning: string): boolean {
  return !/^For highest accuracy/i.test(warning);
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "62%" — percentages are how confidences read in the rest of the UI. */
export function pctLabel(v: number | null): string | null {
  return v === null ? null : `${Math.round(v * 100)}%`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  en_au: 'English',
  en_uk: 'English',
  en_us: 'English',
  id: 'Indonesian',
  ms: 'Malay',
  zh: 'Mandarin',
  hi: 'Hindi',
  ta: 'Tamil',
  th: 'Thai',
  vi: 'Vietnamese',
  ja: 'Japanese',
  ko: 'Korean',
};

/** Human name of an AAI language code; falls back to the code itself. */
export function languageLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const lc = code.toLowerCase();
  if (LANGUAGE_NAMES[lc]) return LANGUAGE_NAMES[lc];
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(
      lc.replace('_', '-')
    );
    if (name && name.toLowerCase() !== lc.replace('_', '-')) return name;
  } catch {
    // Intl.DisplayNames missing or given a code it can't parse — use the raw code.
  }
  return code;
}

/**
 * The one plain sentence everyone sees. Names the model that ACTUALLY ran,
 * the language it ran in, and — when they differ — why it isn't the model
 * we asked for. Returns null when we know nothing (quick imports).
 */
export function aaiOutcomeSentence(o: AaiOutcome): string | null {
  const model = o.used ?? o.requested;
  if (!model) return null;
  const lang = languageLabel(o.languageCode);

  const where = lang
    ? `Transcribed in ${lang}${o.languageDetected ? ' (auto-detected)' : ''}`
    : 'Transcribed';
  const head = `${where} by AssemblyAI ${speechModelLabel(model)}`;

  if (o.downgraded) {
    const asked = speechModelLabel(o.requested);
    return lang
      ? `${head} — ${asked} was asked for but does not support ${lang} yet, so AssemblyAI fell back.`
      : `${head} — ${asked} was asked for, but AssemblyAI fell back for this language.`;
  }
  if (o.requested && canonicalSpeechModel(DEFAULT_SPEECH_MODEL) !== o.requested) {
    return `${head} (older model).`;
  }
  return `${head}.`;
}

/**
 * The calm amber line, one sentence, only when something is worth saying.
 * Deliberately reason-specific: "your English may read as a translation"
 * and "the audio was hard to hear" are not the same warning.
 */
export function aaiOutcomeNote(o: AaiOutcome): string | null {
  const reason = o.reasons[0];
  if (!reason) return null;
  switch (reason) {
    case 'downgraded':
      return (
        'Mixed-language calls come out in the detected language; English stretches may read ' +
        'as translations. Not fixable with a re-run today — see Advanced details.'
      );
    case 'non-english':
      return (
        `This meeting was transcribed as one language (${languageLabel(o.languageCode)}); ` +
        'anything said in another language may read as a translation. See Advanced details.'
      );
    case 'low-confidence':
      return (
        `AssemblyAI's confidence in these words is only ${pctLabel(o.asrConfidence)} — ` +
        'expect misheard words and names. See Advanced details.'
      );
    case 'keyterms-dropped':
      return (
        'The attendee-name hint list was not applied to this language, so names and company ' +
        'words are likely garbled. See Advanced details.'
      );
    case 'warnings':
      return 'AssemblyAI reported something about this job — see Advanced details.';
  }
}
