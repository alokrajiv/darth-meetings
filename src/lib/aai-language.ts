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
