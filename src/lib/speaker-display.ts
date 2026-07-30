/**
 * Pretty display for the raw speaker keys AssemblyAI emits ("A", "B", ...).
 * When there's no custom name, show "Speaker A" instead of a lone letter so
 * the UI reads naturally. For speaker labels that are already verbose (e.g.
 * from an imported transcript that already had names), leave them alone.
 */
export function defaultSpeakerLabel(raw: string): string {
  if (/^[A-Z]$/.test(raw)) return `Speaker ${raw}`;
  return raw;
}

/**
 * Stable 1..8 color slot for a raw speaker key. Same hash everywhere so the
 * dot in the Speakers panel and the label color in the transcript always
 * agree for a given speaker.
 */
export function speakerColorIndex(originalSpeaker: string): number {
  let hash = 0;
  for (let i = 0; i < originalSpeaker.length; i++) {
    hash = (hash * 31 + originalSpeaker.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 8) + 1;
}

/** CSS var reference for the speaker's color slot — e.g. `var(--speaker-3)`. */
export function speakerColorVar(originalSpeaker: string): string {
  return `var(--speaker-${speakerColorIndex(originalSpeaker)})`;
}
