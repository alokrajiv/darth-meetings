// Wire shapes for the meeting-discovery service (lib/server/meeting-discovery)
// and its routes (/api/calendar/discover, /api/meet/records,
// /api/meet/evidence). Pure types — imported by the browser dialog and the
// server alike. Shapes mirror what the import dialog has always rendered, so
// the client is a thin fetch-and-render over these.

import type {
  ClassifiedAttachments,
  EvidenceVerdict,
  RecordingEvidence,
  TranscriptEvidence,
} from '@/lib/meeting-evidence';

export interface DiscoveredAttachment {
  fileId?: string;
  title?: string;
  mimeType?: string;
}

/** A calendar event as the dialog renders it (Google Calendar `events`
 * resource subset, unchanged field names so import bodies stay identical). */
export interface DiscoveredEvent {
  id: string;
  summary?: string;
  recurringEventId?: string;
  iCalUID?: string;
  htmlLink?: string;
  organizer?: { email?: string; self?: boolean };
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    resource?: boolean;
  }>;
  attachments?: DiscoveredAttachment[];
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: { key?: { type?: string } };
    entryPoints?: Array<{ uri?: string }>;
  };
}

/** Meet API artifact info joined to a row by a record sweep / probe. */
export interface DiscoveredMeetInfo {
  recordName: string;
  videoFileId: string | null;
  transcriptDocId: string | null;
  /** Listed at Google, file not generated yet. */
  videoPending: boolean;
  transcriptPending: boolean;
  /** False = the artifact listing was NOT inventoried (recents rows — resolved
   * on pick) or the listing call failed; "nothing found" is only trustworthy
   * when this is true (D5). */
  checked: boolean;
}

/** One pickable row: a calendar event (with classified attachments), a
 * Meet-API-only conference (`offCalendar`), or a Teams event. */
export interface DiscoveredRow {
  event: DiscoveredEvent;
  video: DiscoveredAttachment | null;
  transcriptDoc: DiscoveredAttachment | null;
  geminiNotes: DiscoveredAttachment | null;
  videoCount: number;
  meet: DiscoveredMeetInfo | null;
  /** Raw Teams meetup-join link found on the event (null = not Teams). */
  teamsUrl: string | null;
  /** Conference record with no matching calendar event. */
  offCalendar: boolean;
}

export interface DiscoverWindowResponse {
  rows: DiscoveredRow[];
  /** The Meet-record sweep for the window ran and succeeded — only then may
   * "no record = never started" be concluded. */
  meetChecked: boolean;
  /** Server time of the discovery pass (everything above was written back to
   * the caches at this instant). */
  checkedAt: string;
}

export interface MeetRecordsResponse {
  rows: DiscoveredRow[];
  checkedAt: string;
}

/** Poller/probe-cached metadata the options step shows (duration, counts). */
export interface CachedMeetingMeta {
  conferenceRecord: string | null;
  confStart: string | null;
  confEnd: string | null;
  recordingCount: number;
  readyRecordingCount: number;
  recordingState: string | null;
  transcriptState: string | null;
  transcriptSource: string | null;
  videoFileId: string | null;
  videoSize: number | null;
  videoDurationMs: number | null;
  transcriptDocIds: string[] | null;
  transcriptParseable: boolean | null;
  utteranceCount: number | null;
  wordCount: number | null;
  speakerCount: number | null;
}

export interface EvidenceRequest {
  meetingCode: string;
  /** The occurrence's calendar start — anchors the record lookup (D6) and
   * the cache key. */
  startTime?: string | null;
  /** Skip the record lookup when the client already knows it. */
  recordName?: string | null;
  /** Calendar attachments on the event, when the client has them. */
  attachments?: DiscoveredAttachment[] | null;
  /** Display metadata for the cache row (title goes to reminders, not here). */
  event?: {
    id?: string | null;
    recurringEventId?: string | null;
    iCalUID?: string | null;
    organizerEmail?: string | null;
  } | null;
}

export interface EvidenceResponse {
  recordName: string | null;
  confStart: string | null;
  confEnd: string | null;
  recording: RecordingEvidence;
  transcript: TranscriptEvidence;
  verdict: EvidenceVerdict;
  attachments: ClassifiedAttachments;
  /** Either listing call failed — treat absent evidence as "unknown". */
  checkFailed: boolean;
  /** Drive metadata for the first recording file (null when unreadable). */
  video: { fileId: string; name: string; size: number | null; durationMs: number | null } | null;
  /** The cache row after this probe wrote back (turn/word counts etc.). */
  meta: CachedMeetingMeta | null;
  checkedAt: string;
}
