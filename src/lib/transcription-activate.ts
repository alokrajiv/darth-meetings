/**
 * `activate(meeting, T)` as a PURE planner — what a version switch archives,
 * restores and writes (docs/recordings-phase2-spec.md "Model").
 *
 * One mechanism serves both halves of Phase 2: "the new job finished" (create
 * T, then activate) and "switch back to the older version". The bookkeeping is
 * identical, which is exactly why it is worth having one description of it
 * that can be read and unit-tested without a database:
 *
 *   cur = the recording's active transcription
 *   archive  every user's transcript_edits + speaker_mappings → transcription_annotations[cur]
 *   restore  transcription_annotations[T]  → transcript_edits + speaker_mappings
 *            (none for a brand-new T: it has a new index space and a new
 *            label namespace, so nothing may carry over — design §5 D-G)
 *   row      imported_content, aai_job_id, speech_model, language_code,
 *            duration, speaker_count, completed_at ← T
 *   mark     cur.superseded_by = T, but only when T is NEWER than cur
 *   context  notesStale when a summary/report exists (it was written from cur)
 *
 * The one thing that is NOT symmetric: a brand-new T re-runs the speaker
 * passes and can fire the "ready" DM; switching back to a version we have
 * already seen must do neither (`brandNew` below says which).
 *
 * Pure: no db, no fs, no `server-only`. Everything it needs is passed in, and
 * everything it decides comes back as data for `src/db-ops/transcriptions.ts`
 * to execute in ONE transaction.
 */

import type { SpeakerLabel, SpeakerSuggestionMap, TranscriptEditMap } from '@/lib/format';

/** The `speaker_mappings` row, parked verbatim (labels AND suggestions —
 * both are keyed on one job's diarization letters). */
export interface ParkedSpeakerMapping {
  labels: SpeakerLabel[];
  suggestions: SpeakerSuggestionMap | null;
}

/** One user's live annotations on the meeting, or their parked copy. */
export interface AnnotationSet {
  userId: string;
  edits: TranscriptEditMap | null;
  speakers: ParkedSpeakerMapping | null;
}

/** What the planner needs to know about a transcription. */
export interface TranscriptionFacts {
  id: string;
  status: 'processing' | 'completed' | 'error';
  /** ISO. Decides which of two versions is the newer one. */
  createdAt: string;
  providerJobId: string | null;
  speechModel: string | null;
  languageCode: string | null;
  completedAt: string | null;
  /** Seconds, as `transcripts.duration` stores it. */
  durationSec: number | null;
  speakerCount: number | null;
  /**
   * Has this version ever been the active one? (`requested.activatedAt`,
   * stamped by the first activate.) Without it, switching new → old → new
   * would read as "brand new" a second time and pay for the speaker-ID pass
   * again on a version whose labels are already known.
   */
  activatedBefore: boolean;
}

export interface ActivateInput {
  /** `transcripts.id`. */
  transcriptId: number;
  /** The recording's current `active_transcription_id`, resolved. */
  current: TranscriptionFacts | null;
  target: TranscriptionFacts;
  /** Live `transcript_edits` + `speaker_mappings` of this meeting, every user. */
  live: AnnotationSet[];
  /** `transcription_annotations` rows already parked for the TARGET. */
  archived: AnnotationSet[];
  /** Does the meeting carry a summary / a detailed report right now? */
  hasNotes: boolean;
  hasReport: boolean;
  /** ISO — the planner never reads the clock itself. */
  now: string;
}

export interface AnnotationCounts {
  edits: number;
  speakerNames: number;
}

export interface ActivatePlan {
  ok: true;
  transcriptId: number;
  /** Rows to write into `transcription_annotations`, keyed on `fromTranscriptionId`. */
  archive: { transcriptionId: string; sets: AnnotationSet[] };
  /** Users whose live rows must be DELETED (they had annotations, the target
   * has none parked for them). Deleting is not optional: leaving one user's
   * edits behind would apply index-keyed overrides to another version's text. */
  clearUsers: string[];
  /** Rows to write back into the live tables. */
  restore: AnnotationSet[];
  /** The columns to copy onto the meeting row. `status` stays whatever it is
   * ('completed') — a version switch is not a re-transcription of the row. */
  row: {
    payloadFromTranscriptionId: string;
    aaiJobId: string | null;
    speechModel: string | null;
    languageCode: string | null;
    durationSec: number | null;
    speakerCount: number | null;
    completedAt: string | null;
  };
  activeTranscriptionId: string;
  /** Only when the target is NEWER than the one being left: an older version
   * does not supersede the newer one it is being swapped back in front of. */
  supersede: { transcriptionId: string; by: string } | null;
  /** The marker for `gmeet_context`; null when there is nothing to go stale. */
  notesStale: { since: string; fromTranscriptionId: string } | null;
  /** True = this version has never been read on this meeting. Gates the
   * speaker-ID re-run, the voiceprint suggestions and the "ready" DM. */
  brandNew: boolean;
  setAside: AnnotationCounts;
  restored: AnnotationCounts;
}

export interface ActivateRefusal {
  ok: false;
  /** Shown to the user verbatim. */
  error: string;
  /** 409 for "not in a state to activate", 200-ish for "already active". */
  alreadyActive?: true;
}

export type ActivateDecision = ActivatePlan | ActivateRefusal;

/** Edits are a map of utterance key → override; the count is the keys. */
function countEdits(set: AnnotationSet | undefined | null): number {
  return set?.edits ? Object.keys(set.edits).length : 0;
}

/**
 * Named speakers only. An empty `customName` is a row the UI wrote and never
 * filled in; counting it would tell the user "3 names set aside" when they
 * named nobody. Suggestions are NOT counted — they are machine output that
 * the next run reproduces — but they ARE parked, so switching back restores
 * the exact review state.
 */
function countNames(set: AnnotationSet | undefined | null): number {
  return (set?.speakers?.labels ?? []).filter((l) => l.customName?.trim()).length;
}

function total(sets: AnnotationSet[]): AnnotationCounts {
  return {
    edits: sets.reduce((n, s) => n + countEdits(s), 0),
    speakerNames: sets.reduce((n, s) => n + countNames(s), 0),
  };
}

/** Anything worth parking at all — an empty set is not written. */
function isEmpty(set: AnnotationSet): boolean {
  return countEdits(set) === 0 && (set.speakers?.labels ?? []).length === 0 && !set.speakers?.suggestions;
}

function msOf(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Decide what activating `target` does. Refuses rather than guesses: a
 * transcription that is still running or that failed has no payload to put on
 * the meeting, and re-activating the live one would archive the user's
 * annotations and then restore nothing.
 */
export function planActivate(input: ActivateInput): ActivateDecision {
  const { target, current } = input;

  if (current && current.id === target.id) {
    return { ok: false, error: 'That version is already the one being shown.', alreadyActive: true };
  }
  if (target.status !== 'completed') {
    return {
      ok: false,
      error:
        target.status === 'processing'
          ? 'That version is still being transcribed.'
          : 'That version failed — there is nothing to show.',
    };
  }

  // Park what is on the meeting now. With no current transcription there is
  // nothing to park it UNDER, so the live rows are left alone: that is a
  // meeting whose recording has one transcription and no active pointer, and
  // its annotations belong to the version that is about to become active only
  // if they were made against it — which is exactly the case when `current`
  // is null and `archived` is empty for the target.
  const liveNonEmpty = input.live.filter((s) => !isEmpty(s));
  const archive =
    current && liveNonEmpty.length > 0
      ? { transcriptionId: current.id, sets: liveNonEmpty }
      : { transcriptionId: current?.id ?? target.id, sets: [] as AnnotationSet[] };

  const restore = input.archived.filter((s) => !isEmpty(s));
  const restoreUsers = new Set(restore.map((s) => s.userId));
  // Every user who has something live and nothing coming back loses their
  // rows. Users on BOTH sides are overwritten by the restore, so they are not
  // listed here (one statement instead of a delete + an insert).
  const clearUsers = input.live
    .filter((s) => !isEmpty(s) && !restoreUsers.has(s.userId))
    .map((s) => s.userId);

  // The "the re-run finished" case: newer than the one being left, never
  // activated before, and with nothing parked against it. Switching BACK to an
  // older version is never brand new, and neither is switching forward a
  // second time to a version whose speakers have already been worked out.
  const newer = msOf(target.createdAt) > msOf(current?.createdAt ?? null);
  const brandNew = newer && !target.activatedBefore && input.archived.length === 0;

  const setAside = total(archive.sets);
  const restored = total(restore);

  return {
    ok: true,
    transcriptId: input.transcriptId,
    archive,
    clearUsers,
    restore,
    row: {
      payloadFromTranscriptionId: target.id,
      aaiJobId: target.providerJobId,
      speechModel: target.speechModel,
      languageCode: target.languageCode,
      durationSec: target.durationSec,
      speakerCount: target.speakerCount,
      completedAt: target.completedAt,
    },
    activeTranscriptionId: target.id,
    supersede: current && newer ? { transcriptionId: current.id, by: target.id } : null,
    // The summary and the report were written from `current`. They are not
    // regenerated automatically — that costs money and they are still mostly
    // right — so the page says so instead (spec Flow 4).
    notesStale:
      current && (input.hasNotes || input.hasReport)
        ? { since: input.now, fromTranscriptionId: current.id }
        : null,
    brandNew,
    setAside,
    restored,
  };
}
