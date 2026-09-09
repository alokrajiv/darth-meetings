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
export const SPEECH_MODEL_LABELS: Record<SpeechModel, string> = {
  universal: 'Universal-2',
  'universal-3-5-pro': 'Universal-3.5 Pro',
};
/** Human-name of a model, tolerant of the pre-column NULL. */
export function speechModelLabel(model: string | null | undefined): string {
  return SPEECH_MODEL_LABELS[(model ?? LEGACY_SPEECH_MODEL) as SpeechModel] ?? String(model);
}
