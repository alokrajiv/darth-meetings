// THE "is this meeting occurrence already imported?" rule — pure, shared by
// the SQL-side lookup (db-ops/imported-occurrences) and the series sweep's
// in-memory matcher (docs/meeting-evidence-consolidation.md, Phase 3).
//
// Before this module the rule lived in four places with four windows:
// gmeet-sync (code ±12h), teams-import (join URL ±12h), the calendar SQL
// views (inline anti-joins, eventId only in one of them — D9) and
// series-occurrences.matchImported (DAY_MS/2). One definition now.

import { OCCURRENCE_WINDOW_MS } from '@/lib/meeting-evidence';

/** What a caller knows about the occurrence it is asking about. Strong ids
 * (eventId, Teams callId, transcript Doc, video file) match exactly with no
 * time check; provider keys (meeting code, Teams join URL) are reused across
 * a recurring series and need `startTime` to pin the occurrence. */
export interface OccurrenceQuery {
  meetingCode?: string | null;
  joinWebUrl?: string | null;
  eventId?: string | null;
  videoFileId?: string | null;
  transcriptDocId?: string | null;
  teamsCallId?: string | null;
  /** Occurrence start. Without it, code/URL queries match ANY occurrence
   * (pasted links with no calendar context). */
  startTime?: string | null;
}

/** The identity facts a stored import carries (transcripts.gmeet_context). */
export interface ImportedCandidate {
  meeting_code: string | null;
  join_web_url: string | null;
  event_id: string | null;
  video_file_id: string | null;
  drive_file_id: string | null;
  transcript_doc_id: string | null;
  teams_call_id: string | null;
  /** COALESCE(startTime, actuals.conferenceStart, recorded_at) — see
   * IMPORTED_OCCURRENCE_START in db-ops/imported-occurrences. */
  occurrence_start: string | null;
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return Math.abs(x - y) <= OCCURRENCE_WINDOW_MS;
}

export function importedOccurrenceMatches(c: ImportedCandidate, q: OccurrenceQuery): boolean {
  if (q.eventId && c.event_id && c.event_id === q.eventId) return true;
  if (q.teamsCallId && c.teams_call_id && c.teams_call_id === q.teamsCallId) return true;
  if (q.transcriptDocId && c.transcript_doc_id && c.transcript_doc_id === q.transcriptDocId) {
    return true;
  }
  if (q.videoFileId && (c.video_file_id === q.videoFileId || c.drive_file_id === q.videoFileId)) {
    return true;
  }
  const codeHit = !!q.meetingCode && c.meeting_code === q.meetingCode;
  const urlHit = !!q.joinWebUrl && c.join_web_url === q.joinWebUrl;
  if (codeHit || urlHit) {
    // No usable start (missing or unparseable) → code/URL-only match, as the
    // pre-consolidation lookups did; never let a garbage date hide a dupe.
    if (!q.startTime || Number.isNaN(Date.parse(q.startTime))) return true;
    return sameInstant(c.occurrence_start, q.startTime);
  }
  return false;
}
