/**
 * How the speaker-ID pass's guesses and the voiceprint pass's matches share
 * one suggestions map. Pure, client-safe; `identifySpeakers`
 * (lib/server/auto-notes.ts) and `suggestSpeakersForTranscript`
 * (lib/server/voiceprint.ts) are the callers.
 *
 * Rules: a human-confirmed speaker is never touched; a voiceprint match of
 * the SAME person (`samePerson` — "karnica.katiyar" vs "Karnica Katiyar")
 * is kept, name and all, and only gains the pass's evidence; a different
 * name overrules a voice match when `idMayOverruleVoice` says so — easily
 * for a match to someone not on the invite, at a modest confidence for a
 * weak (< 0.7) match, and only at >= 0.7 for a strong one.
 */
import type { SpeakerSuggestion, SpeakerSuggestionMap } from '@/lib/format';
import { samePerson } from '@/lib/person-identity';
import { WEAK_VOICE_SCORE } from '@/lib/voiceprint-math';

export type IdPassGuesses = Record<string, { name?: unknown; confidence?: unknown; evidence?: unknown }>;

/** The ID pass's confidence needed to overrule a voice match to someone not on the invite. */
export const OVERRULE_OFF_ROSTER_AT = 0.5;
/** …a weak voice match (< WEAK_VOICE_SCORE). */
export const OVERRULE_WEAK_AT = 0.6;
/** …any other voice match. */
export const OVERRULE_STRONG_AT = 0.7;

/**
 * May an ID-pass guess of a DIFFERENT person at `idConfidence` replace this
 * voice suggestion? 2026-09-25, transcript 980: voice said "Hitesh Ambaliya
 * 0.63" (not invited) and the pass had "Agung Prihatmoko 0.85" from the
 * transcript; the old flat >= 0.7 rule let a 0.65 transcript-and-video guess
 * lose to a 0.53 voice hint of a colleague who was not on the call.
 */
export function idMayOverruleVoice(voice: SpeakerSuggestion, idConfidence: number): boolean {
  if (voice.offRoster) return idConfidence >= OVERRULE_OFF_ROSTER_AT;
  if (voice.confidence < WEAK_VOICE_SCORE) return idConfidence >= OVERRULE_WEAK_AT;
  return idConfidence >= OVERRULE_STRONG_AT;
}

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
      if (!idMayOverruleVoice(existing, confidence)) continue;
    }
    merged[sp] = { name, confidence, source: 'context', via: 'id', evidence };
    added++;
    changed = true;
  }
  return { merged, added, changed };
}

/**
 * A fresh voice pass merged onto what is stored. The voice pass owns voice
 * entries (a stale one is replaced or dropped); context entries (the ID pass,
 * Meet alignment) stay for speakers it has no match for; an ID-pass name that
 * had overruled a voice match keeps doing so while the same rule would still
 * let it (`idMayOverruleVoice`) — otherwise every "Guess names" click or notes
 * run re-surfaced the weak wrong match the pass had just replaced. The ID
 * pass's agreement note on a voice match carries over to the same person.
 */
export function mergeVoiceSuggestions(
  voice: SpeakerSuggestionMap,
  existing: SpeakerSuggestionMap
): SpeakerSuggestionMap {
  const merged: SpeakerSuggestionMap = { ...voice };
  for (const [sp, s] of Object.entries(existing ?? {})) {
    const v = merged[sp];
    if (s.source === 'context') {
      if (!v) merged[sp] = s;
      else if (s.via === 'id' && !samePerson(v.name, s.name) && idMayOverruleVoice(v, s.confidence)) {
        merged[sp] = s;
      }
    } else if (v && v.source === 'voice' && s.evidence && !v.evidence && samePerson(v.name, s.name)) {
      merged[sp] = { ...v, evidence: s.evidence };
    }
  }
  return merged;
}
