import type { SpeakerLabel } from '@/lib/format';

/**
 * When naming the speakers by hand settles the speaker-identification pass.
 *
 * `speaker_id_status` gates the detail page ("Identifying speakers first…"
 * hides Generate while it reads 'running') and `listSpeakerIdBacklog` re-runs
 * a 'running' row after 30 minutes. Neither used to notice that a person had
 * already answered the question the pass was asking: name every diarized
 * speaker through `PUT …/speakers` (the review dialog, `darth-cli meetings
 * set-speakers`) and the page kept waiting for a model call that, when it
 * finally came, found nothing left to do (`identifySpeakers` exits early when
 * `unnamed.length === 0`).
 *
 * Pure: the route hands it the row's status, the pass status, the distinct
 * speaker labels of the meeting's utterances and the labels just saved.
 */

/** The pass statuses a complete set of names may close. 'completed' already is. */
const SETTLEABLE = new Set<string | null>([null, 'running', 'error']);

/** Distinct `speaker` labels of a meeting's utterances, in first-seen order. */
export function diarizedSpeakers(utterances: ReadonlyArray<{ speaker: string }>): string[] {
  const seen = new Set<string>();
  for (const u of utterances) if (u.speaker) seen.add(u.speaker);
  return [...seen];
}

/** The diarized speakers no saved label gives a non-empty name. */
export function unnamedSpeakers(
  speakers: Iterable<string>,
  labels: ReadonlyArray<SpeakerLabel>
): string[] {
  const named = new Set(
    labels.filter((l) => l.customName?.trim()).map((l) => l.originalSpeaker)
  );
  return [...speakers].filter((sp) => !named.has(sp));
}

export interface SettleSpeakerIdInput {
  /** `transcripts.status` — only a completed meeting has a pass to settle. */
  rowStatus: string;
  /** `transcripts.speaker_id_status`. */
  speakerIdStatus: string | null;
  /** Distinct diarized speakers (`diarizedSpeakers`). */
  speakers: Iterable<string>;
  /** The labels as just saved. */
  labels: ReadonlyArray<SpeakerLabel>;
}

/**
 * True iff saving these labels should flip `speaker_id_status` to
 * 'completed': the meeting is completed, the pass is null / running / errored,
 * there is at least one diarized speaker, and every one of them is named.
 * A partial set of names changes nothing — the pass may still have work.
 */
export function shouldSettleSpeakerId(input: SettleSpeakerIdInput): boolean {
  if (input.rowStatus !== 'completed') return false;
  if (!SETTLEABLE.has(input.speakerIdStatus)) return false;
  const speakers = [...input.speakers];
  if (speakers.length === 0) return false;
  return unnamedSpeakers(speakers, input.labels).length === 0;
}
