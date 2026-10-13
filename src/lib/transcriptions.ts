/**
 * Transcription versions of a meeting — the wire contract shared by the
 * server routes and the transcript page (Phase 2,
 * docs/recordings-phase2-spec.md).
 *
 * A meeting is stable; a TRANSCRIPTION is a version of what was heard on its
 * recording. "Transcribe again" adds a version while the meeting stays
 * readable on the current one; switching versions swaps the payload on the
 * meeting row and sets the edits and speaker names of the version being left
 * aside (they are index- and label-keyed, so they belong to one version only)
 * and brings back those of the version being entered.
 *
 * Pure types + small pure helpers: importable from client components.
 */

import type { TranscriptHealth } from '@/lib/transcript-health';
import type { MergeOptions, MergeStats } from '@/lib/transcript-merge';

/**
 * `'auto'` = let AssemblyAI detect (with its code-switching options).
 * `'auto-en'` = detection on Universal-3.5 Pro told to EXPECT English
 * (docs/transcription-merge-spec.md Amendment A): the English base pass of a
 * mixed-language call. Forced `'en'` drops the other language's speech
 * (−28% coverage in the probe); this keeps it, garbled but present, which is
 * what a merge needs. Anything else is a language code that is FORCED.
 */
export type TranscriptionLanguageChoice = 'auto' | 'auto-en' | string;

/**
 * What a run does when it lands (spec §3a):
 *  - `replace` — today's behaviour: the new version becomes the one shown;
 *  - `helper`  — kept as a version, NOT shown (a fill pass to merge later);
 *  - `merge`   — merged with the version that was active at the start
 *                (oriented by language, Amendment A) and the MERGED version
 *                is shown. A forced other-language pass is never shown raw:
 *                it would translate the English.
 */
export type TranscriptionRunMode = 'replace' | 'helper' | 'merge';

/** POST /api/transcripts/:id/retranscribe — body. All fields optional. */
export interface RetranscribeRequest {
  /** Default: the server's current default model. */
  speechModel?: string;
  /** Default: 'auto'. A code forces that language (the fix for a wrong detection). */
  languageCode?: TranscriptionLanguageChoice;
  /** Free text shown in the versions list ("wrong language", "newer model"). */
  reason?: string;
  /** Required to repeat a run with the same model AND language as the active version. */
  force?: boolean;
  /** Default 'replace'. */
  mode?: TranscriptionRunMode;
  /** Only read for mode 'merge'. */
  mergeOptions?: MergeOptions;
}

/** POST /api/transcripts/:id/retranscribe — responses. */
export type RetranscribeResponse =
  /** 202 — a version is now being transcribed on THIS meeting. */
  | {
      ok: true;
      mode: 'version';
      transcriptionId: string;
      running: RunningTranscription;
      /** What happens when it lands (absent from servers before the merge spec = 'replace'). */
      runMode?: TranscriptionRunMode;
    }
  /** 202 — the pre-Phase-2 path ran (tables/flags absent): a NEW meeting row. */
  | { ok: true; mode: 'new-row'; newId: string }
  /** 200 — legacy rows that were already re-run the old way. */
  | { ok: true; already: true; newId: string }
  /** 409 — same model + language as the active version; resend with force. */
  | { error: string; sameSettings: true }
  /** 409 — a run is already in flight. */
  | { error: string; running: RunningTranscription }
  /** 4xx/5xx */
  | { error: string };

/** `gmeet_context.retranscribing` and the `running` field of the list. */
export interface RunningTranscription {
  transcriptionId: string;
  startedAt: string;
  /** Person display input — the UI renders people as people. */
  by: { email: string | null; name: string | null };
  speechModel: string;
  /** What was ASKED for: 'auto', 'auto-en' or a code. */
  languageCode: TranscriptionLanguageChoice;
  /** Absent = 'replace' (markers written before the merge spec). */
  mode?: TranscriptionRunMode;
}

export type TranscriptionStatus = 'processing' | 'completed' | 'error';

/** One line of the Versions list. Newest first. */
export interface TranscriptionVersion {
  id: string;
  active: boolean;
  status: TranscriptionStatus;
  /** assemblyai | meet-doc | teams-vtt | text */
  provider: string;
  /** The model that actually ran (may differ from the one asked for — fallback). */
  speechModel: string | null;
  speechModelRequested: string | null;
  /** The language the result is in, and whether it was detected or forced. */
  languageCode: string | null;
  languageDetected: boolean;
  languageConfidence: number | null;
  speakerCount: number | null;
  createdAt: string;
  completedAt: string | null;
  requestedBy: { email: string | null; name: string | null } | null;
  reason: string | null;
  /** Utterance edits and named speakers parked with this version (0 for the active one). */
  editsSetAside: number;
  speakerNamesSetAside: number;
  /** Plain reason when status is 'error'. */
  error: string | null;
  /** What the run was ASKED for ('auto', 'auto-en', a code); null when not recorded. */
  languageRequested: string | null;
  /** `payload.confidence` — mean word confidence; null while running / for imports without it. */
  asrConfidence: number | null;
  /** The mixed-language signal (lib/transcript-health). Computed for the newest
   * few completed versions only — null on the rest and on unfinished ones. */
  health: TranscriptHealth | null;
  /** Set on `provider = 'merge'` versions: what was merged into what. */
  merge: TranscriptionMergeInfo | null;
}

/** `requested.merge` of a merged version, as the wire shows it. */
export interface TranscriptionMergeInfo {
  /** The version kept as the skeleton (speakers, utterances). */
  base: string;
  /** The version whose words replaced the base's unsure spans. */
  fill: string;
  fillLanguage: string | null;
  stats: MergeStats;
}

/** GET /api/transcripts/:id/transcriptions */
export interface TranscriptionsResponse {
  /** False = the fallback path is in force (tables/flags absent): hide the Versions UI, keep the old button. */
  versioned: boolean;
  canEdit: boolean;
  running: RunningTranscription | null;
  versions: TranscriptionVersion[];
  /** Set when the summary/report were written from another version — or, as
   * of Phase 3a, from a WIDER window of the same recording (a part of this
   * meeting was split off). `reason`, when present, is the sentence to show
   * instead of the default "Written from the previous transcription". */
  notesStale: { since: string; fromTranscriptionId: string; reason?: string } | null;
}

/** POST /api/transcripts/:id/transcriptions/:tid/activate — response. */
export type ActivateTranscriptionResponse =
  | {
      ok: true;
      activeId: string;
      /** For the one-sentence toast: what happened to the annotations. */
      setAside: { edits: number; speakerNames: number };
      restored: { edits: number; speakerNames: number };
    }
  | { error: string };

/**
 * True when asking again would reproduce the active version.
 *
 * A MERGED active version is never "the same settings" — no single run
 * reproduces it — and `'auto-en'` is told apart from plain `'auto'` by what
 * the version was asked for (both come back with detection on).
 */
export function sameTranscriptionSettings(
  active:
    | (Pick<TranscriptionVersion, 'speechModel' | 'speechModelRequested' | 'languageCode' | 'languageDetected'> &
        Partial<Pick<TranscriptionVersion, 'provider' | 'languageRequested'>>)
    | null,
  ask: { speechModel: string; languageCode: TranscriptionLanguageChoice }
): boolean {
  if (!active) return false;
  if (active.provider === 'merge') return false;
  const model = active.speechModelRequested ?? active.speechModel;
  if (model !== ask.speechModel) return false;
  if (ask.languageCode === 'auto-en') return active.languageRequested === 'auto-en';
  return ask.languageCode === 'auto'
    ? active.languageDetected && active.languageRequested !== 'auto-en'
    : !active.languageDetected && active.languageCode === ask.languageCode;
}

// ---------------------------------------------------------------------------
// Merge + version content (docs/transcription-merge-spec.md §3b)
// ---------------------------------------------------------------------------

/** POST …/transcriptions/merge — body. */
export interface MergeTranscriptionsRequest {
  base: string;
  fill: string;
  options?: MergeOptions;
  reason?: string;
  /** Make the merged version the one shown. Default false. */
  activate?: boolean;
  /** Compute and preview only; nothing is written. */
  dryRun?: boolean;
}

/** POST …/transcriptions/merge — responses. */
export type MergeTranscriptionsResponse =
  /** 200 — dry run. */
  | {
      dryRun: true;
      stats: MergeStats;
      /** Touched utterances (max 40), texts truncated to 300 chars. */
      preview: Array<{ start: number; speaker: string; before: string; after: string }>;
      /** Amendment A: "base is not an English version", "fill is English", … */
      warnings: string[];
    }
  /** 201 — the merged version exists (and is live when `activated`). */
  | { ok: true; transcriptionId: string; stats: MergeStats; activated: boolean; warnings: string[] }
  | { error: string };

/** GET …/transcriptions/:tid/content — one version's text, active or not. */
export interface TranscriptionContentResponse {
  transcriptionId: string;
  active: boolean;
  utterances: Array<{
    start: number;
    end: number;
    /** The diarization label — or the confirmed name, when this version shares
     * the active version's labels (merged from it, or the active one itself). */
    speaker: string;
    text: string;
    merged?: boolean;
  }>;
  languageCode: string | null;
  provider: string;
}
