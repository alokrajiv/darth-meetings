/**
 * AssemblyAI's universal speech model accepts `keyterms_prompt` only for
 * English (`en`, `en_au`, `en_uk`, `en_us`). Sending it with any other
 * language_code fails the whole submit with a 400 — this was the
 * "Transcription submission failed" seen on a Mandarin upload (2026-09-09).
 * Unset language means AAI's default (en), so the bias list is fine there.
 */
export function keytermsSupported(languageCode: string | undefined | null): boolean {
  if (!languageCode) return true;
  const lc = languageCode.toLowerCase();
  return lc === 'en' || lc.startsWith('en_');
}

/** AssemblyAI speech models we submit to. */
export type SpeechModel = 'universal' | 'universal-3-5-pro';
/** Default for every new submit (uploads, imports, re-runs). */
export const DEFAULT_SPEECH_MODEL: SpeechModel = 'universal-3-5-pro';
/** Rows created before speech_model existed all ran on 'universal'. */
export const LEGACY_SPEECH_MODEL: SpeechModel = 'universal';
/**
 * Labels are keyed by the ids we SEND ('universal') *and* the ids AAI
 * reports back in `speech_model_used` ('universal-2') — they name the same
 * model under two spellings.
 */
export const SPEECH_MODEL_LABELS: Record<string, string> = {
  universal: 'Universal-2',
  'universal-2': 'Universal-2',
  'universal-3-5-pro': 'Universal-3.5 Pro',
};
/** Human-name of a model, tolerant of the pre-column NULL. */
export function speechModelLabel(model: string | null | undefined): string {
  return SPEECH_MODEL_LABELS[model ?? LEGACY_SPEECH_MODEL] ?? String(model);
}

/**
 * One canonical id per actual model, so "what we asked for" and "what AAI
 * ran" can be compared. Our legacy submit id 'universal' IS Universal-2 —
 * without this every pre-2026-09 row would read as a downgrade.
 */
export function canonicalSpeechModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model === 'universal' ? 'universal-2' : model;
}

/**
 * The `speech_models` list to submit for a given primary model: AAI reads it
 * as a preference order and falls back down it for languages the primary
 * doesn't cover. Naming the fallback explicitly is AAI's documented form —
 * it silences the "'id' is not supported in universal-3-5-pro" warning and
 * makes the Universal-2 downgrade a deliberate choice instead of an
 * accident we only discover afterwards (docs/eval-aai-code-switching-2026-09-21.md).
 * Behaviour-neutral: probes f ≡ g in that eval are byte-identical.
 */
export function speechModelsRequest(model: SpeechModel): string[] {
  return model === 'universal-3-5-pro' ? ['universal-3-5-pro', 'universal-2'] : [model];
}
