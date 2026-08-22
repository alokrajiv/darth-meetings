// THE shared "what does this meeting have" model.
//
// Before this module existed, has-recording / has-transcript / importable /
// pending were re-derived inline at ~15 call sites (import dialog ×5, series
// sweep ×4, poller ×3, SQL views ×3) with four mutually incompatible
// definitions of "has a transcript" — see docs/meeting-evidence-consolidation.md
// (D1–D12) for the catalogue of user-visible disagreements that caused.
//
// Rules of the road:
//  - Pure + isomorphic: no fetch, no DB, safe to import from client
//    components, server modules and tests alike.
//  - Every surface that classifies meeting artifacts imports from HERE.
//    Adding a rule (a new Doc title pattern, a new pending state) happens
//    once, in this file, with a test.

// ---------------------------------------------------------------------------
// Occurrence identity
// ---------------------------------------------------------------------------

/** A recurring meeting reuses one Meet code forever; an artifact/import
 * within ±12h of a calendar occurrence's start belongs to that occurrence.
 * Single source of truth — the SQL views import the seconds variant. */
export const OCCURRENCE_WINDOW_MS = 12 * 3600_000;
export const OCCURRENCE_WINDOW_S = OCCURRENCE_WINDOW_MS / 1000;

/** Meet conferenceRecord lookup window around a calendar occurrence's start:
 * a call can start a bit early and run long. ONE declaration (D6) — the
 * import core, the poller, the dialog's evidence route and the series sweep
 * all resolve "which record is this occurrence" with the same bounds. */
export const RECORD_LOOKUP_BEFORE_MS = 6 * 3600_000;
export const RECORD_LOOKUP_AFTER_MS = 12 * 3600_000;

/** Is `recordStartIso` the occurrence that started at `eventStartIso`? */
export function recordMatchesOccurrence(
  recordStartIso: string | null | undefined,
  eventStartIso: string | null | undefined
): boolean {
  if (!recordStartIso || !eventStartIso) return false;
  const r = Date.parse(recordStartIso);
  const e = Date.parse(eventStartIso);
  if (Number.isNaN(r) || Number.isNaN(e)) return false;
  return r >= e - RECORD_LOOKUP_BEFORE_MS && r <= e + RECORD_LOOKUP_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Calendar attachments (Meet's post-call uploads: recording videos, the
// "<title> - Transcript" Doc, the "Notes by Gemini" Doc)
// ---------------------------------------------------------------------------

export interface CalendarAttachmentLike {
  fileId?: string | null;
  title?: string | null;
  mimeType?: string | null;
}

export interface ClassifiedAttachments {
  /** First video attachment's Drive file id. */
  videoFileId: string | null;
  videoCount: number;
  /** The transcript-bearing Doc: an explicit "… Transcript" Doc wins,
   * otherwise the Gemini-notes Doc (its "Transcript" tab holds the full
   * transcript — verified 2026-08-21: for Gemini-notes-only series the Meet
   * API's own transcript docId IS the Gemini Doc). */
  transcriptDocId: string | null;
  /** True when the transcript Doc is the Gemini-notes Doc (no plain
   * transcript Doc attached). */
  geminiNotes: boolean;
}

/**
 * One regex set for everyone. History: the dialog used unanchored
 * /transcript/i with gemini tested first; the series sweep used anchored
 * /transcript\s*$/i with transcript first — so "Transcript of X" and
 * "Gemini notes — Transcript" classified differently per surface (D7).
 * Resolution: unanchored match (broader; a Doc titled around "transcript"
 * is one), explicit-transcript beats gemini (both import identically —
 * the flag only affects labels/tooltips).
 */
export function classifyCalendarAttachments(
  atts: readonly CalendarAttachmentLike[] | null | undefined
): ClassifiedAttachments {
  let videoFileId: string | null = null;
  let videoCount = 0;
  let transcriptDoc: string | null = null;
  let geminiDoc: string | null = null;
  for (const a of atts ?? []) {
    if (!a.fileId) continue;
    if (a.mimeType?.startsWith('video/')) {
      videoCount++;
      if (!videoFileId) videoFileId = a.fileId;
    } else if (a.mimeType === 'application/vnd.google-apps.document') {
      const title = a.title ?? '';
      if (/transcript/i.test(title) && !/gemini/i.test(title)) {
        if (!transcriptDoc) transcriptDoc = a.fileId;
      } else if (/gemini/i.test(title)) {
        if (!geminiDoc) geminiDoc = a.fileId;
      }
    }
  }
  return {
    videoFileId,
    videoCount,
    transcriptDocId: transcriptDoc ?? geminiDoc,
    geminiNotes: !transcriptDoc && geminiDoc !== null,
  };
}

// ---------------------------------------------------------------------------
// Meet API artifacts (conferenceRecords/{id}/recordings + /transcripts)
// ---------------------------------------------------------------------------

/** Meet lists artifact entries BEFORE the files exist (STARTED → ENDED →
 * FILE_GENERATED); "generating" = listed but no destination file yet. */
export type RecordingState = 'none' | 'generating' | 'partial' | 'ready';
export type TranscriptState = 'none' | 'generating' | 'ready' | 'unparseable';
export type TranscriptSource = 'meet' | 'gemini' | 'teams' | null;

export interface RecordingEvidence {
  state: RecordingState;
  /** Entries Google lists, files or not (the old `recording_count`). */
  listed: number;
  /** Entries with an actual Drive file. */
  ready: number;
  fileIds: string[];
}

/**
 * Classify a recordings listing. `partial` = some segments have files, some
 * are still generating (stop/restart meetings) — treat as "usable now, more
 * coming": the recording-poller keeps polling, the UI shows the recording.
 * History (D4/D11): `recording_count > 0` used to read as "has recording"
 * even when NO file ever appeared (20/138 prod rows), and the dialog's
 * pending test (`!some(file)`) contradicted the server's (`some(!file)`).
 */
export function classifyRecordings(
  recordings: readonly { fileId?: string | null }[] | null | undefined,
  /** Calendar attachments for the same event — an attached video is a ready
   * recording (the only recording evidence once the Meet record ages out).
   * Without this, every surface patched attachment video in by hand (N3). */
  attachments?: ClassifiedAttachments | null
): RecordingEvidence {
  const list = recordings ?? [];
  const apiFiles = list.flatMap((r) => (r.fileId ? [r.fileId] : []));
  const fileIds = [...apiFiles];
  const attVideo = attachments?.videoFileId ?? null;
  if (attVideo && !fileIds.includes(attVideo)) fileIds.push(attVideo);
  const state: RecordingState =
    fileIds.length === 0
      ? list.length > 0
        ? 'generating'
        : 'none'
      : apiFiles.length < list.length
        ? 'partial'
        : 'ready';
  return {
    state,
    listed: Math.max(list.length, fileIds.length),
    ready: fileIds.length,
    fileIds,
  };
}

export interface TranscriptEvidence {
  state: TranscriptState;
  /** Sessions Google lists, Docs or not. */
  listed: number;
  docIds: string[];
  source: TranscriptSource;
}

/**
 * Classify transcript evidence from every place it can come from: Meet API
 * sessions (may be listed-but-generating), calendar-attachment Docs (the only
 * evidence left once the Meet record ages out after ~30d, and the ONLY
 * evidence Gemini-notes-only meetings ever get — D1), and the
 * parseable-probe result (false = Doc exists but zero utterances — D8).
 */
export function classifyTranscripts(input: {
  docIds?: readonly string[] | null;
  listed?: number | null;
  parseable?: boolean | null;
  attachments?: ClassifiedAttachments | null;
}): TranscriptEvidence {
  const apiDocs = [...(input.docIds ?? [])];
  const att = input.attachments;
  const docIds = [...apiDocs];
  if (att?.transcriptDocId && !docIds.includes(att.transcriptDocId)) {
    docIds.push(att.transcriptDocId);
  }
  const listed = Math.max(input.listed ?? 0, docIds.length);
  const state: TranscriptState =
    docIds.length > 0
      ? input.parseable === false
        ? 'unparseable'
        : 'ready'
      : listed > 0
        ? 'generating'
        : 'none';
  const source: TranscriptSource =
    docIds.length === 0
      ? null
      : apiDocs.length > 0
        ? 'meet'
        : att?.geminiNotes
          ? 'gemini'
          : 'meet';
  return { state, listed, docIds, source };
}

// ---------------------------------------------------------------------------
// The rolled-up verdict
// ---------------------------------------------------------------------------

export interface MeetingEvidence {
  recording: RecordingEvidence;
  transcript: TranscriptEvidence;
}

export interface EvidenceVerdict {
  /** A recording file you can pull right now. */
  hasRecording: boolean;
  /** A transcript Doc you can import right now (parseable not known-false). */
  hasTranscript: boolean;
  /** Something is listed at the provider but not materialized yet. */
  pending: boolean;
  /** Anything to act on — now or once generation finishes. */
  importable: boolean;
}

export function classifyEvidence(e: MeetingEvidence): EvidenceVerdict {
  const hasRecording = e.recording.ready > 0;
  const hasTranscript = e.transcript.state === 'ready';
  const pending =
    e.recording.state === 'generating' ||
    e.recording.state === 'partial' ||
    e.transcript.state === 'generating';
  return {
    hasRecording,
    hasTranscript,
    pending,
    importable: hasRecording || hasTranscript || pending,
  };
}
