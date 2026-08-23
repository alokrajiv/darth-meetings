import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import {
  OCCURRENCE_WINDOW_MS,
  type RecordingState,
  type TranscriptSource,
  type TranscriptState,
} from '@/lib/meeting-evidence';

// Poll-time metadata snapshot per meeting occurrence — see migration 017.
// Display-only: never a source of content access. The poller fills rows
// once per meeting (artifacts are immutable after the call ends); later
// sweeps only fill gaps (e.g. a recording that finished processing after
// the transcript appeared).

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface GmeetMeetingCacheRow {
  event_key: string;
  meeting_code: string;
  event_start: string | null;
  conference_record: string | null;
  conf_start: string | null;
  conf_end: string | null;
  recording_count: number;
  video_file_id: string | null;
  video_size: number | null;
  video_duration_ms: number | null;
  transcript_doc_ids: string[] | null;
  transcript_parseable: boolean | null;
  utterance_count: number | null;
  word_count: number | null;
  speakers: string[] | null;
  recurring_event_id: string | null;
  ical_uid: string | null;
  organizer_email: string | null;
  captured_at: string;
  // Classified evidence (migration 026) — computed by lib/meeting-evidence
  // at write time; readers must NOT re-derive from the raw counts.
  recordings_listed: number;
  ready_recording_count: number;
  transcripts_listed: number;
  recording_state: RecordingState | null;
  transcript_state: TranscriptState | null;
  transcript_source: TranscriptSource;
}

const ROW_COLUMNS = sql`
  event_key, meeting_code, event_start, conference_record, conf_start,
  conf_end, recording_count, video_file_id,
  video_size::float8 AS video_size,
  video_duration_ms::float8 AS video_duration_ms,
  transcript_doc_ids, transcript_parseable, utterance_count, word_count,
  speakers, recurring_event_id, ical_uid, organizer_email, captured_at,
  recordings_listed, ready_recording_count, transcripts_listed,
  recording_state, transcript_state, transcript_source
`;

export async function getMeetingCacheByKeys(
  keys: string[]
): Promise<Map<string, GmeetMeetingCacheRow>> {
  if (keys.length === 0) return new Map();
  const rows = await sql<GmeetMeetingCacheRow[]>`
    SELECT ${ROW_COLUMNS}
    FROM ${sql(SCHEMA)}.gmeet_meeting_cache
    WHERE event_key = ANY(${keys})
  `;
  return new Map(rows.map((r) => [r.event_key, r]));
}

// ±12h occurrence window: single declaration in lib/meeting-evidence.

/**
 * Cache rows for a list of meeting occurrences, aligned by index (null =
 * nothing captured yet). Matched by meeting code + occurrence time window,
 * not by exact key string.
 */
export async function getMeetingCacheByMeetings(
  meetings: Array<{ code: string; startTime?: string | null }>
): Promise<(GmeetMeetingCacheRow | null)[]> {
  const codes = [...new Set(meetings.map((m) => m.code.trim()).filter(Boolean))];
  if (codes.length === 0) return meetings.map(() => null);
  const rows = await sql<GmeetMeetingCacheRow[]>`
    SELECT ${ROW_COLUMNS}
    FROM ${sql(SCHEMA)}.gmeet_meeting_cache
    WHERE meeting_code = ANY(${codes})
  `;
  return meetings.map((m) => {
    const candidates = rows.filter((r) => r.meeting_code === m.code.trim());
    if (candidates.length === 0) return null;
    const wanted = m.startTime ? Date.parse(m.startTime) : NaN;
    if (Number.isNaN(wanted)) return candidates[0]!;
    return (
      candidates.find((r) => {
        const at = Date.parse(r.event_start ?? r.conf_start ?? '');
        return !Number.isNaN(at) && Math.abs(at - wanted) <= OCCURRENCE_WINDOW_MS;
      }) ?? null
    );
  });
}

/** Graph resolution facts the Teams poller stashes in `raw.teamsResolution`
 * so later sweeps skip the join-URL $filter call (spec §8.4). */
export interface TeamsResolutionCache {
  joinWebUrl: string;
  organizerOid: string;
  graphMeetingId: string;
  /** Graph's numeric meetingCode — display/debug only. */
  meetingCode?: string;
}

export async function getTeamsResolutionByKeys(
  keys: string[]
): Promise<Map<string, TeamsResolutionCache>> {
  if (keys.length === 0) return new Map();
  const rows = await sql<Array<{ event_key: string; res: TeamsResolutionCache | null }>>`
    SELECT event_key, raw->'teamsResolution' AS res
    FROM ${sql(SCHEMA)}.gmeet_meeting_cache
    WHERE event_key = ANY(${keys})
  `;
  return new Map(
    rows.filter((r) => r.res?.graphMeetingId).map((r) => [r.event_key, r.res!])
  );
}

/** The canonical Teams join URL a past probe stashed for a `teams-…` code
 * (any occurrence within ±12h of `startTime`, else any occurrence of the
 * code — one recurring series = one URL). Lets a "Check…" that only knows
 * the cache code re-probe without a Calendar round-trip. */
export async function getTeamsJoinUrlByMeeting(
  code: string,
  startTime: string | null
): Promise<string | null> {
  const rows = await sql<Array<{ url: string | null; event_start: string | null }>>`
    SELECT raw->'teamsResolution'->>'joinWebUrl' AS url, event_start
    FROM ${sql(SCHEMA)}.gmeet_meeting_cache
    WHERE meeting_code = ${code}
      AND raw->'teamsResolution'->>'joinWebUrl' IS NOT NULL
    ORDER BY ${
      startTime
        ? sql`abs(extract(epoch FROM (COALESCE(event_start, conf_start) - ${startTime}::timestamptz)))`
        : sql`updated_at DESC`
    }
    LIMIT 1
  `;
  return rows[0]?.url ?? null;
}

/**
 * Fill-gaps upsert: null inputs never clobber previously captured values —
 * a sweep that couldn't read the Doc must not erase last week's counts.
 */
export async function upsertMeetingCache(input: {
  eventKey: string;
  meetingCode: string;
  eventStart: string | null;
  conferenceRecord: string | null;
  confStart?: string | null;
  confEnd?: string | null;
  recordingCount?: number | null;
  videoFileId?: string | null;
  videoSize?: number | null;
  videoDurationMs?: number | null;
  transcriptDocIds?: string[] | null;
  transcriptParseable?: boolean | null;
  utteranceCount?: number | null;
  wordCount?: number | null;
  speakers?: string[] | null;
  recurringEventId?: string | null;
  iCalUID?: string | null;
  organizerEmail?: string | null;
  /** Verbatim API payloads fetched this round — jsonb-merged into `raw`. */
  raw?: Record<string, unknown> | null;
  capturedBy?: string | null;
  // Classified evidence — pass what this sweep proved; merge never regresses
  // a state (states only advance: none → generating → partial/ready, and
  // ready → unparseable once the Doc is probed).
  recordingsListed?: number | null;
  readyRecordingCount?: number | null;
  transcriptsListed?: number | null;
  recordingState?: RecordingState | null;
  transcriptState?: TranscriptState | null;
  transcriptSource?: TranscriptSource | null;
}): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.gmeet_meeting_cache
      (event_key, meeting_code, event_start, conference_record, conf_start,
       conf_end, recording_count, video_file_id, video_size, video_duration_ms,
       transcript_doc_ids, transcript_parseable, utterance_count, word_count,
       speakers, recurring_event_id, ical_uid, organizer_email, raw, captured_by,
       recordings_listed, ready_recording_count, transcripts_listed,
       recording_state, transcript_state, transcript_source)
    VALUES
      (${input.eventKey}, ${input.meetingCode}, ${input.eventStart},
       ${input.conferenceRecord}, ${input.confStart ?? null}, ${input.confEnd ?? null},
       ${input.recordingCount ?? 0}, ${input.videoFileId ?? null},
       ${input.videoSize ?? null}, ${input.videoDurationMs ?? null},
       ${input.transcriptDocIds ? sql.json(input.transcriptDocIds as unknown as never) : null},
       ${input.transcriptParseable ?? null}, ${input.utteranceCount ?? null},
       ${input.wordCount ?? null},
       ${input.speakers ? sql.json(input.speakers as unknown as never) : null},
       ${input.recurringEventId ?? null}, ${input.iCalUID ?? null},
       ${input.organizerEmail ?? null},
       ${input.raw ? sql.json(input.raw as unknown as never) : null},
       ${input.capturedBy ?? null},
       ${input.recordingsListed ?? 0}, ${input.readyRecordingCount ?? 0},
       ${input.transcriptsListed ?? 0}, ${input.recordingState ?? null},
       ${input.transcriptState ?? null}, ${input.transcriptSource ?? null})
    ON CONFLICT (event_key) DO UPDATE SET
      conference_record    = COALESCE(EXCLUDED.conference_record, gmeet_meeting_cache.conference_record),
      conf_start           = COALESCE(EXCLUDED.conf_start, gmeet_meeting_cache.conf_start),
      conf_end             = COALESCE(EXCLUDED.conf_end, gmeet_meeting_cache.conf_end),
      recording_count      = GREATEST(EXCLUDED.recording_count, gmeet_meeting_cache.recording_count),
      video_file_id        = COALESCE(EXCLUDED.video_file_id, gmeet_meeting_cache.video_file_id),
      video_size           = COALESCE(EXCLUDED.video_size, gmeet_meeting_cache.video_size),
      video_duration_ms    = COALESCE(EXCLUDED.video_duration_ms, gmeet_meeting_cache.video_duration_ms),
      transcript_doc_ids   = COALESCE(EXCLUDED.transcript_doc_ids, gmeet_meeting_cache.transcript_doc_ids),
      transcript_parseable = COALESCE(EXCLUDED.transcript_parseable, gmeet_meeting_cache.transcript_parseable),
      utterance_count      = COALESCE(EXCLUDED.utterance_count, gmeet_meeting_cache.utterance_count),
      word_count           = COALESCE(EXCLUDED.word_count, gmeet_meeting_cache.word_count),
      speakers             = COALESCE(EXCLUDED.speakers, gmeet_meeting_cache.speakers),
      recurring_event_id   = COALESCE(EXCLUDED.recurring_event_id, gmeet_meeting_cache.recurring_event_id),
      ical_uid             = COALESCE(EXCLUDED.ical_uid, gmeet_meeting_cache.ical_uid),
      organizer_email      = COALESCE(EXCLUDED.organizer_email, gmeet_meeting_cache.organizer_email),
      raw                  = CASE
                               WHEN EXCLUDED.raw IS NULL THEN gmeet_meeting_cache.raw
                               ELSE COALESCE(gmeet_meeting_cache.raw, '{}'::jsonb) || EXCLUDED.raw
                             END,
      recordings_listed     = GREATEST(EXCLUDED.recordings_listed, gmeet_meeting_cache.recordings_listed),
      ready_recording_count = GREATEST(EXCLUDED.ready_recording_count, gmeet_meeting_cache.ready_recording_count),
      transcripts_listed    = GREATEST(EXCLUDED.transcripts_listed, gmeet_meeting_cache.transcripts_listed),
      recording_state = CASE
        WHEN EXCLUDED.recording_state IS NULL THEN gmeet_meeting_cache.recording_state
        WHEN gmeet_meeting_cache.recording_state IS NULL THEN EXCLUDED.recording_state
        WHEN array_position(ARRAY['none','generating','partial','ready'], EXCLUDED.recording_state)
           >= array_position(ARRAY['none','generating','partial','ready'], gmeet_meeting_cache.recording_state)
          THEN EXCLUDED.recording_state
        ELSE gmeet_meeting_cache.recording_state
      END,
      transcript_state = CASE
        WHEN EXCLUDED.transcript_state IS NULL THEN gmeet_meeting_cache.transcript_state
        WHEN gmeet_meeting_cache.transcript_state IS NULL THEN EXCLUDED.transcript_state
        WHEN array_position(ARRAY['none','generating','ready','unparseable'], EXCLUDED.transcript_state)
           >= array_position(ARRAY['none','generating','ready','unparseable'], gmeet_meeting_cache.transcript_state)
          THEN EXCLUDED.transcript_state
        ELSE gmeet_meeting_cache.transcript_state
      END,
      transcript_source    = COALESCE(EXCLUDED.transcript_source, gmeet_meeting_cache.transcript_source),
      updated_at           = now()
  `;
}
