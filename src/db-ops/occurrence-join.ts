import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { IMPORTED_OCCURRENCE_START } from '@/db-ops/imported-occurrences';
import { publishEvent } from '@/lib/server/event-bus';
import type { OccurrenceJoinMarker, OccurrenceKey } from '@/lib/occurrence-join';
import type { SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';

/**
 * The SQL half of "this occurrence already has a meeting — add my recording
 * to it" (lib/occurrence-join.ts, lib/server/occurrence-join.ts).
 *
 * PRIVACY (feedback_privacy_caller_scoping_gate): the candidate lookup is
 * CALLER-SCOPED in SQL with the same owner-or-share predicate every listing
 * uses (`resolveAccess`, `meetingsHoldingRecording`): a meeting the caller
 * cannot open is never returned, never counted, never named. Being an
 * invitee of the occurrence gives nobody a meeting they were not shared —
 * Ka Wen's meeting is a candidate for Ivan only because the link shared it
 * with him (or because she shared it by hand).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface OccurrenceMeetingRow {
  id: number;
  assemblyai_id: string;
  title: string | null;
  user_id: string;
  status: string;
  created_at: string;
  /** The caller's access: owner, or their share's level. */
  access: 'owner' | 'edit' | 'read';
  event_id: string | null;
  ical_uid: string | null;
  meeting_code: string | null;
  join_web_url: string | null;
  occurrence_start: string | null;
  /** The caller's email is on the meeting's own invite list. */
  caller_invited: boolean;
  clip_count: number;
  recording_ids: string[] | null;
}

/**
 * CALLER-SCOPED — live meetings the caller can open that carry one of the
 * occurrence's keys. The final "is it the same occurrence" call (start within
 * the window) is `sameOccurrence` in JS, as the import lookup does it, so the
 * rule lives in one pure, tested place.
 *
 * Trashed and temporary (scratch) rows never count, exactly as for "already
 * imported?". Only the arms with values are emitted, so each probes its
 * expression index; the iCalUID arm (no index) only when nothing better is
 * known.
 */
export async function findOccurrenceMeetings(
  caller: { userId: string; email: string },
  key: OccurrenceKey,
  opts?: { excludeTranscriptIds?: number[]; limit?: number }
): Promise<OccurrenceMeetingRow[]> {
  const arms: Array<ReturnType<typeof sql>> = [];
  if (key.eventId) arms.push(sql`t.gmeet_context->>'eventId' = ${key.eventId}`);
  if (key.meetingCode) arms.push(sql`t.gmeet_context->>'meetingCode' = ${key.meetingCode}`);
  if (key.joinWebUrl) arms.push(sql`t.gmeet_context->'teams'->>'joinWebUrl' = ${key.joinWebUrl}`);
  if (key.iCalUID && arms.length === 0) arms.push(sql`t.gmeet_context->>'iCalUID' = ${key.iCalUID}`);
  if (arms.length === 0) return [];
  const where = arms.reduce((acc, a) => sql`${acc} OR ${a}`);
  const normEmail = caller.email.trim().toLowerCase();
  const exclude = (opts?.excludeTranscriptIds ?? []).filter((n) => Number.isInteger(n));

  return sql<OccurrenceMeetingRow[]>`
    SELECT t.id, t.assemblyai_id, t.title, t.user_id, t.status, t.created_at,
           CASE WHEN t.user_id = ${caller.userId} THEN 'owner' ELSE COALESCE(s.access, 'read') END AS access,
           t.gmeet_context->>'eventId'              AS event_id,
           t.gmeet_context->>'iCalUID'              AS ical_uid,
           t.gmeet_context->>'meetingCode'          AS meeting_code,
           t.gmeet_context->'teams'->>'joinWebUrl'  AS join_web_url,
           ${IMPORTED_OCCURRENCE_START}             AS occurrence_start,
           EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(t.gmeet_context->'attendees') = 'array'
                    THEN t.gmeet_context->'attendees' ELSE '[]'::jsonb END) a
             WHERE lower(a->>'email') = ${normEmail}
           ) AS caller_invited,
           (SELECT count(*)::int FROM ${sql(SCHEMA)}.meeting_clips c
             WHERE c.transcript_id = t.id) AS clip_count,
           (SELECT array_agg(DISTINCT c.recording_id::text) FROM ${sql(SCHEMA)}.meeting_clips c
             WHERE c.transcript_id = t.id) AS recording_ids
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id AND s.shared_with_email = ${normEmail}
    WHERE t.deleted_at IS NULL AND NOT t.scratch
      AND t.gmeet_context IS NOT NULL
      AND (t.user_id = ${caller.userId} OR s.id IS NOT NULL)
      AND (${where})
      ${exclude.length > 0 ? sql`AND NOT (t.id = ANY(${exclude}))` : sql``}
    ORDER BY (t.user_id = ${caller.userId}) DESC, t.created_at ASC, t.id ASC
    LIMIT ${opts?.limit ?? 20}
  `;
}

/**
 * Where a recording stands before a link: how many LIVE meetings hold a clip
 * on it, and which meeting (if any) holds a `waiting-combine` reservation for
 * it. INTERNAL — the caller has already proved they own the recording.
 */
export async function recordingLinkState(
  recordingId: string
): Promise<{ liveMeetings: number; reservedIn: string | null }> {
  const rows = await sql<Array<{ live: number; reserved: string | null }>>`
    SELECT
      (SELECT count(DISTINCT c.transcript_id)::int
         FROM ${sql(SCHEMA)}.meeting_clips c
         JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
        WHERE c.recording_id = ${recordingId}::uuid AND t.deleted_at IS NULL) AS live,
      (SELECT t.assemblyai_id FROM ${sql(SCHEMA)}.transcripts t
        WHERE t.deleted_at IS NULL
          AND t.gmeet_context ? 'occurrenceJoins'
          AND t.gmeet_context->'occurrenceJoins'->${recordingId}::text->>'text' = 'waiting-combine'
        LIMIT 1) AS reserved
  `;
  return { liveMeetings: rows[0]?.live ?? 0, reservedIn: rows[0]?.reserved ?? null };
}

// ---------------------------------------------------------------------------
// The marker (`gmeet_context.occurrenceJoins.<recordingId>`)
// ---------------------------------------------------------------------------

/** Write (replace) the marker for one recording on the joined meeting. */
export async function setOccurrenceJoinMarker(
  transcriptId: number,
  assemblyaiId: string,
  recordingId: string,
  marker: OccurrenceJoinMarker
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = jsonb_set(
          COALESCE(gmeet_context, '{}'::jsonb),
          '{occurrenceJoins}',
          COALESCE(gmeet_context->'occurrenceJoins', '{}'::jsonb)
            || jsonb_build_object(${recordingId}::text, ${sql.json(marker as never)}::jsonb)
        )
    WHERE id = ${transcriptId}
  `;
  publishEvent({ kind: 'meta', assemblyaiId });
}

/**
 * Merge `patch` into one marker. With `whenText`, only while the marker's
 * `text` is one of those states — the CLAIM a settle takes, so two observers
 * of one completion never merge the same recording twice. Returns whether a
 * row was written.
 */
export async function patchOccurrenceJoinMarker(
  transcriptId: number,
  recordingId: string,
  patch: Partial<OccurrenceJoinMarker>,
  whenText?: string[]
): Promise<boolean> {
  const rows = await sql<Array<{ id: number }>>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = jsonb_set(
          gmeet_context,
          ARRAY['occurrenceJoins', ${recordingId}::text],
          (gmeet_context->'occurrenceJoins'->${recordingId}::text) || ${sql.json(patch as never)}::jsonb
        )
    WHERE id = ${transcriptId}
      AND gmeet_context->'occurrenceJoins' ? ${recordingId}::text
      ${whenText && whenText.length > 0
        ? sql`AND gmeet_context->'occurrenceJoins'->${recordingId}::text->>'text' = ANY(${whenText})`
        : sql``}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function removeOccurrenceJoinMarker(transcriptId: number, recordingId: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = gmeet_context #- ARRAY['occurrenceJoins', ${recordingId}::text]
    WHERE id = ${transcriptId}
  `;
}

export interface OccurrenceJoinRow {
  id: number;
  user_id: string;
  assemblyai_id: string;
  joins: Record<string, OccurrenceJoinMarker> | null;
}

/**
 * INTERNAL — the live meetings carrying a join marker that is still OPEN
 * (`pending`, `failed`, `waiting-combine`): for one recording (its
 * completion), or all of them (the sweep's backstop). A `merged` marker is
 * terminal and never listed again, so the backstop's page cannot fill up with
 * finished joins.
 */
export async function listOccurrenceJoins(recordingId: string | null, limit = 50): Promise<OccurrenceJoinRow[]> {
  return sql<OccurrenceJoinRow[]>`
    SELECT t.id, t.user_id, t.assemblyai_id, t.gmeet_context->'occurrenceJoins' AS joins
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE t.deleted_at IS NULL
      AND t.gmeet_context ? 'occurrenceJoins'
      ${recordingId ? sql`AND t.gmeet_context->'occurrenceJoins' ? ${recordingId}::text` : sql``}
      AND EXISTS (
        SELECT 1 FROM jsonb_each(
          CASE WHEN jsonb_typeof(t.gmeet_context->'occurrenceJoins') = 'object'
               THEN t.gmeet_context->'occurrenceJoins' ELSE '{}'::jsonb END) j
        WHERE j.value->>'text' IN ('pending', 'failed', 'waiting-combine')
      )
    ORDER BY t.id
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Annotations — every user's, re-keyed after a re-materialise
// ---------------------------------------------------------------------------

/** Replace one user's speaker names AND suggestions on a meeting. */
export async function putMeetingSpeakers(
  userId: string,
  assemblyaiId: string,
  labels: SpeakerLabel[],
  suggestions: SpeakerSuggestionMap | null
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.speaker_mappings
    SET speaker_labels = ${sql.json(labels as never)},
        suggestions = ${suggestions ? sql.json(suggestions as never) : null},
        updated_at = now()
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'speakers', assemblyaiId });
}
