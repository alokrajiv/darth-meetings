/**
 * The ONE merge of confirmed labels + guesses every speaker surface reads
 * (docs/transcript-page-redesign.md §4): the People rows, the Identify-
 * speakers dialog, the inline badge editor in the transcript, the review
 * gate. Until 2026-09-21 the People rows merged `suggestions` in but the
 * edit dialog and the inline editor only looked at `speaker_labels`, so a
 * guessed name vanished the moment you clicked the pencil.
 *
 * Pure, client-safe.
 */

import type { SpeakerLabel, SpeakerSuggestion, SpeakerSuggestionMap } from '@/lib/format';
import { defaultSpeakerLabel } from '@/lib/speaker-display';
import { groupLabelDisplay, speakerNameKind } from '@/lib/speaker-name-kind';

export type SpeakerNameStatus = 'confirmed' | 'guess' | 'unknown' | 'group';

export interface SpeakerNameState {
  speaker: string;
  status: SpeakerNameStatus;
  /** What an editor is seeded with: the confirmed name, the guess, the group
   * label as typed; '' when unknown. */
  name: string;
  /** What a read-only row shows: the name, "Speaker E" when unknown, the
   * group label's meaning ("Several voices · shared mic"). */
  display: string;
  description: string;
  /** The usable suggestion (a person's name) — null when confirmed, unknown,
   * or when the only guess is a group word ("mixed 85 %" is not a name). */
  suggestion: SpeakerSuggestion | null;
  /** One short line for the edit form, saying where the name came from. */
  caption: string;
}

export function speakerNameState(
  speaker: string,
  labels: SpeakerLabel[],
  suggestions?: SpeakerSuggestionMap | null
): SpeakerNameState {
  const label = labels.find((l) => l.originalSpeaker === speaker);
  const confirmed = (label?.customName ?? '').trim();
  const description = (label?.description ?? '').trim();
  const raw = suggestions?.[speaker] ?? null;
  const suggestion = raw && speakerNameKind(raw.name) === 'person' ? raw : null;

  if (confirmed) {
    if (speakerNameKind(confirmed) === 'group') {
      return {
        speaker,
        status: 'group',
        name: confirmed,
        display: groupLabelDisplay(confirmed),
        description,
        suggestion: null,
        caption: 'a shared mic, not a person — not enrolled as a voiceprint',
      };
    }
    return {
      speaker,
      status: 'confirmed',
      name: confirmed,
      display: confirmed,
      description,
      suggestion: null,
      caption: 'confirmed',
    };
  }

  if (suggestion) {
    const name = suggestion.name.trim();
    return {
      speaker,
      status: 'guess',
      name,
      display: name,
      description,
      suggestion,
      caption: guessCaption(suggestion),
    };
  }

  return {
    speaker,
    status: 'unknown',
    name: '',
    display: defaultSpeakerLabel(speaker),
    description,
    suggestion: null,
    caption: raw
      ? 'the voice matched a shared-mic sample, not a person — name them if you can'
      : 'no guess — name them if you can',
  };
}

/** "guessed — 85% voice match, a hint not proof" / "guessed from the transcript — …evidence…". */
export function guessCaption(s: SpeakerSuggestion): string {
  if (s.source === 'voice' || (!s.source && s.confidence > 0 && !s.evidence)) {
    return `guessed — ${Math.round(s.confidence * 100)}% voice match, a hint not proof`;
  }
  const evidence = (s.evidence ?? '').trim();
  return evidence ? `guessed from the transcript — ${evidence}` : 'guessed from the transcript';
}

/** States for every diarized speaker, in the given order. */
export function speakerNameStates(
  speakers: string[],
  labels: SpeakerLabel[],
  suggestions?: SpeakerSuggestionMap | null
): SpeakerNameState[] {
  return speakers.map((sp) => speakerNameState(sp, labels, suggestions));
}

/** How many voices are people (group labels excluded) — the "6 voices" number. */
export function countVoices(states: SpeakerNameState[]): number {
  return states.filter((s) => s.status !== 'group').length;
}

/** Distinct confirmed person names, for "who spoke" lists. */
export function confirmedPersonNames(states: SpeakerNameState[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of states) {
    if (s.status !== 'confirmed') continue;
    const key = s.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.name);
  }
  return out;
}
