/**
 * The words the transcript page says about transcription VERSIONS
 * (docs/recordings-phase2-spec.md §UI) — the running line, one line per
 * version, and the sentence shown after switching.
 *
 * Pure and client-safe: every sentence here is a function of the wire
 * contract in `lib/transcriptions.ts`, so the copy can be read (and tested)
 * without a browser. Tone follows docs/transcript-page-redesign.md — plain
 * sentences, people as people, 24-hour times, no filenames, no filler.
 */

import {
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  canonicalSpeechModel,
  speechModelLabel,
} from '@/lib/aai-language';
import { languageLabel } from '@/lib/aai-outcome';
import { personDisplay } from '@/lib/person-display';
import { clock24, dayLabel, safeDate } from '@/lib/when';
import type {
  ActivateTranscriptionResponse,
  RunningTranscription,
  TranscriptionLanguageChoice,
  TranscriptionVersion,
} from '@/lib/transcriptions';

/** The notes/report tabs' one quiet line when `notesStale` is set. */
export const NOTES_FROM_PREVIOUS_TRANSCRIPTION = 'Written from the previous transcription';

/** "1 edit" / "12 edits" — counts read as English, not as data. */
function countPhrase(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** "Mon 21 Sep 2026 · 16:41", or null when the instant is unusable. */
export function whenStamp(iso: string | null | undefined): string | null {
  const d = safeDate(iso);
  return d ? `${dayLabel(d)} · ${clock24(d)}` : null;
}

/** "English" / "language auto-detected" — what a run was ASKED for. */
function askedLanguage(choice: TranscriptionLanguageChoice): string {
  if (!choice || choice === 'auto') return 'language auto-detected';
  return languageLabel(choice) ?? choice;
}

/**
 * The calm line while a re-run is in flight. No spinner, no percentage: the
 * meeting stays readable on the current version the whole time, and saying
 * so is the point.
 *   "Transcribing again — Universal-3.5 Pro, English · started 14:02 · you can keep reading"
 */
export function runningLine(r: RunningTranscription): string {
  const started = safeDate(r.startedAt);
  const head = `Transcribing again — ${speechModelLabel(r.speechModel)}, ${askedLanguage(r.languageCode)}`;
  return started
    ? `${head} · started ${clock24(started)} · you can keep reading`
    : `${head} · you can keep reading`;
}

/** Who asked for a run, as a person: "Atira", or "You" for the reader. */
export function askedBy(
  who: { email: string | null; name: string | null } | null,
  selfEmail?: string | null
): string | null {
  if (!who || (!who.email && !who.name)) return null;
  if (who.email && selfEmail && who.email.toLowerCase() === selfEmail.toLowerCase()) return 'You';
  return personDisplay(who.email, who.name).first;
}

/** One version, in the words its line uses. Nulls are simply not shown. */
export interface VersionCopy {
  /** "Universal-2 — asked for Universal-3.5 Pro" (the fallback, said out loud). */
  model: string;
  /** "Indonesian (auto)" / "English (chosen)". */
  language: string | null;
  /** "Mon 21 Sep 2026 · 16:41" — when this text came into being. */
  when: string | null;
  /** "Atira" / "You". */
  who: string | null;
  reason: string | null;
  /** "12 edits · 3 names set aside". */
  setAside: string | null;
  /** The plain failure reason, only on a failed version. */
  error: string | null;
}

export function versionCopy(v: TranscriptionVersion, selfEmail?: string | null): VersionCopy {
  // A version that is still running has no model of its own yet — what was
  // asked for is the only honest thing to name.
  const ran = canonicalSpeechModel(v.speechModel);
  const asked = canonicalSpeechModel(v.speechModelRequested);
  let model: string;
  if (ran && asked && ran !== asked) {
    model = `${speechModelLabel(ran)} — asked for ${speechModelLabel(asked)}`;
  } else if (ran || asked) {
    model = speechModelLabel(ran ?? asked);
  } else {
    model = 'Model not recorded';
  }

  const lang = languageLabel(v.languageCode);
  const language = lang ? `${lang} (${v.languageDetected ? 'auto' : 'chosen'})` : null;

  const parked: string[] = [];
  if (v.editsSetAside > 0) parked.push(countPhrase(v.editsSetAside, 'edit'));
  if (v.speakerNamesSetAside > 0) parked.push(countPhrase(v.speakerNamesSetAside, 'name'));

  const err = (v.error ?? '').trim();

  return {
    model,
    language,
    when: whenStamp(v.completedAt ?? v.createdAt),
    who: askedBy(v.requestedBy, selfEmail),
    reason: (v.reason ?? '').trim() || null,
    setAside: parked.length > 0 ? `${parked.join(' · ')} set aside` : null,
    error:
      v.status === 'error' ? err || 'It did not finish — no reason was recorded.' : null,
  };
}

/** Only worth a disclosure when there is more than one, or one that failed. */
export function versionsWorthShowing(versions: TranscriptionVersion[]): boolean {
  return versions.length > 1 || versions.some((v) => v.status === 'error');
}

/**
 * One sentence after a switch: what stayed behind, what came back. Edits are
 * index-keyed and speaker labels are per-job, so they can only ever belong
 * to one version — this says that in the words of the person who made them.
 */
export function setAsideSentence(
  res: Extract<ActivateTranscriptionResponse, { ok: true }>
): string {
  const parked = phraseFor(res.setAside);
  const back = phraseFor(res.restored);
  if (!parked && !back) return 'Now reading this version. No edits or speaker names were affected.';
  // "1 edit stays", "12 edits and 3 speaker names stay".
  const stay = parked && res.setAside.edits + res.setAside.speakerNames === 1 ? 'stays' : 'stay';
  if (parked && back) {
    return `Now reading this version. ${back} came back; ${parked} ${stay} with the version you left.`;
  }
  if (parked) {
    return `Now reading this version. ${parked} ${stay} with the version you left — switch back any time.`;
  }
  return `Now reading this version. ${back} came back with it.`;
}

/** "12 edits and 3 speaker names" — null when nothing was touched. */
function phraseFor({ edits, speakerNames }: { edits: number; speakerNames: number }): string | null {
  const parts: string[] = [];
  if (edits > 0) parts.push(countPhrase(edits, 'edit'));
  if (speakerNames > 0) parts.push(countPhrase(speakerNames, 'speaker name'));
  return parts.length > 0 ? parts.join(' and ') : null;
}

/** One option of the dialog's Language field. `value` is what we send. */
export interface LanguageChoice {
  value: TranscriptionLanguageChoice;
  label: string;
}

/**
 * Auto-detect, then the app's languages, with the one this meeting is in
 * marked — "the current language" is the choice people actually reach for,
 * and a language we don't list (AAI detected it) still has to be offerable.
 */
export function languageChoices(activeCode?: string | null): LanguageChoice[] {
  const active = (activeCode ?? '').trim().toLowerCase();
  // 'en_us' and 'en' name the same choice as far as this field is concerned.
  const base = active.split('_')[0] ?? '';
  const known = TRANSCRIPTION_LANGUAGE_OPTIONS.some((o) => o.code && o.code === base);
  const choices: LanguageChoice[] = TRANSCRIPTION_LANGUAGE_OPTIONS.map((o) => ({
    value: o.code === '' ? 'auto' : o.code,
    label: o.code && o.code === base ? `${o.label} — the current language` : o.label,
  }));
  if (active && !known) {
    choices.splice(1, 0, {
      value: active,
      label: `${languageLabel(active) ?? active} — the current language`,
    });
  }
  return choices;
}
