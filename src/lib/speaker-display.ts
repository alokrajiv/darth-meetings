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
