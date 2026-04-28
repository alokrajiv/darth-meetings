/**
 * Shared (client + server) types and formatters for transcripts.
 *
 * Do NOT put anything here that touches the AssemblyAI SDK or server-only
 * state — this file is imported from client components.
 */

/** A row from our `transcripts` table, as returned by /api/transcripts. */
export interface StoredTranscript {
  id: number;
  user_id: string;
  assemblyai_id: string;
  original_filename: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  duration: number | null;
  speaker_count: number | null;
  language_code: string | null;
  title: string | null;
  description: string | null;
  last_accessed: string;
  source: 'uploaded' | 'imported';
  /** present only when source = 'imported'; the full AAI payload frozen at import time */
  imported_content: TranscriptResponse | null;
  /** cached AAI audio_url at the time of upload/import (may stop working over time) */
  audio_url: string | null;
  /** server-local fallback audio file (set during import after we download the bytes) */
  local_audio_path: string | null;
}

/** Access level for the current user on a transcript. */
export type TranscriptAccess = 'owner' | 'edit' | 'read';

/**
 * What the listing and detail endpoints return to the client: the row plus
 * the caller's computed access level and, for shared rows, the owner's name
 * to show in the UI.
 */
export interface TranscriptWithAccess extends StoredTranscript {
  access: TranscriptAccess;
  owner_email: string | null;
  owner_name: string | null;
}

/**
 * Skinny row returned by the listing endpoint. Deliberately excludes the
 * enormous `imported_content` JSONB, `audio_url`, and `local_audio_path`
 * fields — the listing page doesn't need them and they bloat responses to
 * tens of MB per row.
 */
export interface TranscriptListRow {
  id: number;
  user_id: string;
  assemblyai_id: string;
  original_filename: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  duration: number | null;
  speaker_count: number | null;
  language_code: string | null;
  title: string | null;
  description: string | null;
  last_accessed: string;
  source: 'uploaded' | 'imported';
  access: TranscriptAccess;
  owner_email: string | null;
  owner_name: string | null;
}

/** A row from `transcript_shares`, as returned by /api/transcripts/:id/shares. */
export interface TranscriptShare {
  id: number;
  transcript_id: number;
  shared_with_email: string;
  shared_with_name: string | null;
  shared_with_ppl_id: number | null;
  access: 'edit' | 'read';
  shared_at: string;
}

/**
 * A user's speaker-label customisation for one transcript.
 * `description` is freeform notes — useful as LLM-postfix context (role, voice
 * description, "this is the engineer not the founder", etc.).
 */
export interface SpeakerLabel {
  originalSpeaker: string;
  customName: string;
  description: string;
}

/** Per-utterance edit override stored in `transcript_edits.edits`. */
export interface UtteranceEdit {
  text?: string;
  speaker?: string;
}

/** Map of utterance index → override. */
export type TranscriptEditMap = Record<string, UtteranceEdit>;

/** A custom-spelling entry — replace any of `from[]` with `to`. */
export interface CustomSpellingEntry {
  to: string;
  from: string[];
}

/**
 * Vocab payload (per-user or org-wide).
 *
 * `keyterms_prompt` replaces the old `word_boost` (deprecated by AAI
 * 2026-Q2). It's a flat string array of phrases (up to 1000 entries, up
 * to 6 words per entry) that AAI uses to bias recognition when you submit
 * with the Universal-3 Pro / Slam-1 speech model. No per-entry weights,
 * no global boost param.
 */
export interface VocabPayload {
  keyterms_prompt: string[];
  custom_spelling: CustomSpellingEntry[];
}

export interface TranscriptResponse {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  audio_url?: string;
  created: string;
  completed?: string;
  audio_duration?: number;
  utterances?: Array<{
    text: string;
    start: number;
    end: number;
    speaker: string;
  }>;
  error?: string;
  audio_start_from?: number;
  audio_end_at?: number;
  language_code?: string;
  confidence?: number;
  words?: Array<{
    text: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: string;
  }>;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  } else if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
}

export function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}
