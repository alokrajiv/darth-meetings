/**
 * The speaker-ID pass's guesses merged onto the CURRENT suggestions map.
 * Pure, client-safe; `identifySpeakers` (lib/server/auto-notes.ts) is the
 * only caller.
 *
 * Rules: a human-confirmed speaker is never touched; a voiceprint match of
 * the SAME person (`samePerson` — "karnica.katiyar" vs "Karnica Katiyar")
 * is kept, name and all, and only gains the pass's evidence; a different
 * name overrules a voice match only at confidence >= 0.7.
 */
import type { SpeakerSuggestionMap } from '@/lib/format';
import { samePerson } from '@/lib/person-identity';

export type IdPassGuesses = Record<string, { name?: unknown; confidence?: unknown; evidence?: unknown }>;

export function mergeIdPassGuesses(
  current: SpeakerSuggestionMap,
  guessed: IdPassGuesses,
  ctx: { resolve: (key: string) => string | null | undefined; named: Set<string>; allSpeakers: Set<string> }
): { merged: SpeakerSuggestionMap; added: number; changed: boolean } {
  const merged: SpeakerSuggestionMap = { ...current };
  let added = 0;
  let changed = false;
  for (const [key, g] of Object.entries(guessed ?? {})) {
    const sp = ctx.resolve(key);
    const name = typeof g?.name === 'string' ? g.name.trim().slice(0, 80) : '';
    if (!sp || !name || ctx.named.has(sp) || !ctx.allSpeakers.has(sp)) continue;
    const confidence = Math.max(0, Math.min(1, typeof g?.confidence === 'number' ? g.confidence : 0));
    const evidence = typeof g?.evidence === 'string' ? g.evidence.slice(0, 300) : undefined;
    const existing = merged[sp];
    if (existing?.source === 'voice') {
      if (samePerson(existing.name, name)) {
        // Agreement: keep the voice match (its name is the enrolled one) and
        // show the pass's reasoning beside it.
        if (evidence && evidence !== existing.evidence) {
          merged[sp] = { ...existing, evidence };
          changed = true;
        }
        continue;
      }
      if (confidence < 0.7) continue; // not confident enough to overrule a voiceprint
    }
    merged[sp] = { name, confidence, source: 'context', via: 'id', evidence };
    added++;
    changed = true;
  }
  return { merged, added, changed };
}
