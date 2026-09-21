/**
 * "A voice is not always a person" (docs/transcript-page-redesign.md §5).
 *
 * People type speaker labels such as `mixed`, `room mic`, `several people`
 * when several voices share one microphone. Those labels are useful in the
 * transcript, but they are not names: the People card must not list them as
 * a person, the voice count must not count them, the Sources card must not
 * offer "mixed 85 %" as a voiceprint match, and the server must never enrol
 * them as a voiceprint (the `mixed` enrolment of 2026-09-14 is how that
 * label started being *suggested* on other meetings).
 *
 * Deliberately NOT "a single lower-case word": `pratiksha`, `rick`, `laz`
 * are people whose names were typed in lower case. The rule is a small
 * vocabulary of group words, alone or with a qualifier. Pure, client-safe.
 */

export type SpeakerNameKind = 'person' | 'group' | 'empty';

/** Words that, on their own or with a qualifier, describe a group or a non-voice. */
const GROUP_WORDS = new Set([
  'mixed',
  'mix',
  'multiple',
  'several',
  'many',
  'various',
  'group',
  'room',
  'crowd',
  'everyone',
  'everybody',
  'all',
  'audience',
  'crosstalk',
  'cross-talk',
  'overlap',
  'overlapping',
  'background',
  'noise',
  'music',
  'unknown',
  'unclear',
  'unidentified',
  'inaudible',
  'shared',
  'other',
  'others',
  'misc',
  'n/a',
  'na',
  'tbd',
  'tbc',
  'none',
  '?',
  '??',
  '???',
]);

/** Tokens that qualify a group word without making it a name ("mixed voices", "room mic"). */
const QUALIFIERS = new Set([
  'voice',
  'voices',
  'speaker',
  'speakers',
  'people',
  'person',
  'persons',
  'mic',
  'mics',
  'microphone',
  'audio',
  'chatter',
  'talk',
  'talking',
  'sound',
  'sounds',
  'of',
  'the',
  'a',
  'an',
  'in',
  'on',
  'and',
  '&',
]);

/** "Speaker C" / "speaker 2" — AssemblyAI's default label typed back in as a name. */
const DEFAULT_LABEL_RE = /^speaker\s*([a-z]|\d{1,2})$/;

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[()\[\]{}.,;:!"'`_]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Classify a stored speaker label or a suggested name.
 * - `empty`  — nothing typed.
 * - `group`  — a group / non-voice label: every non-qualifier token is a
 *              group word (or the whole thing is a default "Speaker C").
 * - `person` — everything else. When in doubt, a person: the cost of hiding
 *              a real name is higher than the cost of showing an odd label.
 */
export function speakerNameKind(name: string | null | undefined): SpeakerNameKind {
  const raw = (name ?? '').trim();
  if (!raw) return 'empty';
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');
  if (DEFAULT_LABEL_RE.test(lower)) return 'group';
  if (/^[\d?\-–—]+$/.test(lower)) return 'group';
  const toks = tokens(lower);
  if (toks.length === 0) return 'group';
  const meaningful = toks.filter((t) => !QUALIFIERS.has(t));
  if (meaningful.length === 0) return 'group'; // "voices", "room mic" → all qualifiers
  return meaningful.every((t) => GROUP_WORDS.has(t)) ? 'group' : 'person';
}

export function isGroupLabel(name: string | null | undefined): boolean {
  return speakerNameKind(name) === 'group';
}

export function isPersonName(name: string | null | undefined): boolean {
  return speakerNameKind(name) === 'person';
}

/**
 * What a group label reads as in the People card — the stored word stays in
 * the tooltip and in the edit form; the row says what it means.
 */
export function groupLabelDisplay(name: string | null | undefined): string {
  const lower = (name ?? '').toLowerCase();
  if (/unknown|unclear|unidentified|inaudible|\?|tbd|tbc|n\/a|\bna\b/.test(lower)) {
    return 'Unidentified voice';
  }
  if (/noise|music|background/.test(lower)) return 'Background sound';
  if (/mic|microphone|room|shared/.test(lower)) return 'Several voices · shared mic';
  return 'Several voices';
}
