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

/** `'auto'` = let AssemblyAI detect (with its code-switching options). */
export type TranscriptionLanguageChoice = 'auto' | string;

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
}

/** POST /api/transcripts/:id/retranscribe — responses. */
export type RetranscribeResponse =
  /** 202 — a version is now being transcribed on THIS meeting. */
  | { ok: true; mode: 'version'; transcriptionId: string; running: RunningTranscription }
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
  /** What was ASKED for: 'auto' or a code. */
  languageCode: TranscriptionLanguageChoice;
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

/** True when asking again would reproduce the active version. */
export function sameTranscriptionSettings(
  active: Pick<TranscriptionVersion, 'speechModel' | 'speechModelRequested' | 'languageCode' | 'languageDetected'> | null,
  ask: { speechModel: string; languageCode: TranscriptionLanguageChoice }
): boolean {
  if (!active) return false;
  const model = active.speechModelRequested ?? active.speechModel;
  if (model !== ask.speechModel) return false;
  return ask.languageCode === 'auto'
    ? active.languageDetected
    : !active.languageDetected && active.languageCode === ask.languageCode;
}
