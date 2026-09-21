import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import {
  aaiJobIdColumnExists,
} from '@/db-ops/aai-job-id';
import { transcriptionVersionTablesExist } from '@/db-ops/transcriptions';
import type { SpeakerLabel, SpeakerSuggestionMap, TranscriptEditMap } from '@/lib/format';

/**
 * Clips — the database half of Phase 3a
 * (docs/recordings-phase3-clips-spec.md).
 *
 * Everything here is INTERNAL: not one function takes a caller. The routes
 * gate on the MEETING first (`resolveAccess`), because a recording has no ACL
 * of its own — "reachable through a meeting you can access, or by its owner"
 * is the whole rule (Phase 1 §1). The one query that does know about a caller
 * lives next to its siblings in `db-ops/recordings.ts`
 * (`listSiblingMeetingsForRecordings`) and is caller-scoped in SQL.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * `MW_CLIPS`, AND-ed with everything a split cannot work without.
 *
 * Lazy per call (a pm2 restart flips it, not a rebuild) and deliberately the
 * same shape as Phase 2's `transcriptionVersionsEnabled`:
 *
 *  - `MW_CLIPS` itself;
 *  - `MW_RECORDINGS_WRITE`, because a clip lives on the recording graph and a
 *    meeting whose graph is not maintained has no recording to take a window
 *    of — and, worse, the next dual-write would not honour the mirror;
 *  - migrations 044 + 046 (the tables) and 045 (`transcripts.aai_job_id`),
 *    probed once per process: a split writes a second meeting through the
 *    same writers Phase 1b touched.
 *
 * The fourth condition in the spec — "a backfilled clip" — is per MEETING and
 * belongs to the caller: `meetingRecordingRef(id)` returning null means this
 * meeting is invisible to the resolver and cannot be split.
 */
export function clipsFlagOn(): boolean {
  const on = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';
  // Both, and in this order: the second is not a detail of the first. A
  // server with `MW_CLIPS=1` and no dual-write would write clip rows the very
  // next graph sync would heal away.
  return on(process.env.MW_CLIPS) && on(process.env.MW_RECORDINGS_WRITE);
}

export async function clipsEnabled(): Promise<boolean> {
  if (!clipsFlagOn()) return false;
  const [tables, jobColumn] = await Promise.all([
    transcriptionVersionTablesExist(),
    aaiJobIdColumnExists(),
  ]);
  return tables && jobColumn;
}

// ---------------------------------------------------------------------------
// A meeting's clips
// ---------------------------------------------------------------------------

export interface MeetingClipRow {
  transcript_id: number;
  ord: number;
  recording_id: string;
  transcription_id: string | null;
  from_ms: number;
  to_ms: number | null;
  offset_ms: number;
  text_policy: string;
}

/** The meeting's clip rows, in `ord` order (the timeline order is
 * `offset_ms` then `ord` — `compareClipsOnTimeline` applies it). */
export async function listMeetingClips(transcriptId: number): Promise<MeetingClipRow[]> {
  return sql<MeetingClipRow[]>`
    SELECT transcript_id, ord, recording_id, transcription_id,
           from_ms::float8 AS from_ms, to_ms::float8 AS to_ms,
           offset_ms::float8 AS offset_ms, text_policy
    FROM ${sql(SCHEMA)}.meeting_clips
    WHERE transcript_id = ${transcriptId}
    ORDER BY ord
  `;
}

export interface ClipRecordingFacts {
  id: string;
  started_at: string | null;
  duration_ms: number | null;
  active_transcription_id: string | null;
}

/** The recording a meeting clips, with the facts the split arithmetic and the
 * proposer need (its wall-clock zero and how long it runs). */
export async function recordingFactsFor(recordingId: string): Promise<ClipRecordingFacts | null> {
  const rows = await sql<ClipRecordingFacts[]>`
    SELECT id, started_at, duration_ms::float8 AS duration_ms, active_transcription_id
    FROM ${sql(SCHEMA)}.recordings
    WHERE id = ${recordingId}::uuid
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Annotations that move with a split
// ---------------------------------------------------------------------------

export interface MeetingEditRow {
  user_id: string;
  edits: TranscriptEditMap | null;
}

/**
 * EVERY user's edit map for a meeting — the owner's and each collaborator's.
 *
 * A split re-keys all of them (landmine #2): they are index-keyed, and the
 * indices of both halves change. Doing only the owner's would leave a
 * collaborator's edits pointing at somebody else's sentences.
 */
export async function listMeetingEdits(assemblyaiId: string): Promise<MeetingEditRow[]> {
  return sql<MeetingEditRow[]>`
    SELECT user_id, edits
    FROM ${sql(SCHEMA)}.transcript_edits
    WHERE assemblyai_id = ${assemblyaiId}
  `;
}

/** Replace one user's edit map, or delete the row when the map is empty. */
export async function putMeetingEdits(
  userId: string,
  assemblyaiId: string,
  edits: TranscriptEditMap
): Promise<void> {
  if (Object.keys(edits).length === 0) {
    await sql`
      DELETE FROM ${sql(SCHEMA)}.transcript_edits
      WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
    `;
  } else {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.transcript_edits (user_id, assemblyai_id, edits)
      VALUES (${userId}, ${assemblyaiId}, ${sql.json(edits as unknown as never)})
      ON CONFLICT (user_id, assemblyai_id) DO UPDATE
        SET edits = EXCLUDED.edits, updated_at = now()
    `;
  }
  publishEvent({ kind: 'edits', assemblyaiId });
}

export interface MeetingSpeakerRow {
  user_id: string;
  speaker_labels: SpeakerLabel[] | null;
  suggestions: SpeakerSuggestionMap | null;
}

export async function listMeetingSpeakers(assemblyaiId: string): Promise<MeetingSpeakerRow[]> {
  return sql<MeetingSpeakerRow[]>`
    SELECT user_id, speaker_labels, suggestions
    FROM ${sql(SCHEMA)}.speaker_mappings
    WHERE assemblyai_id = ${assemblyaiId}
  `;
}

/**
 * Copy every user's speaker names AND suggestions onto another meeting.
 *
 * Legal precisely because both meetings read the SAME recording, which by
 * DEC-1 is one AssemblyAI job and therefore one diarization space: "A" means
 * the same person in both. (In Phase 3b, where a meeting can hold two
 * recordings, this stops being true and the labels get a namespace.)
 *
 * Copied in SQL so the jsonb is never re-serialised through JS.
 */
export async function copySpeakerMappings(fromId: string, toId: string): Promise<number> {
  const rows = await sql<Array<{ user_id: string }>>`
    INSERT INTO ${sql(SCHEMA)}.speaker_mappings (user_id, assemblyai_id, speaker_labels, suggestions)
    SELECT user_id, ${toId}, speaker_labels, suggestions
    FROM ${sql(SCHEMA)}.speaker_mappings
    WHERE assemblyai_id = ${fromId}
    ON CONFLICT (user_id, assemblyai_id) DO UPDATE
      SET speaker_labels = EXCLUDED.speaker_labels,
          suggestions    = EXCLUDED.suggestions,
          updated_at     = now()
    RETURNING user_id
  `;
  if (rows.length > 0) publishEvent({ kind: 'speakers', assemblyaiId: toId });
  return rows.length;
}

/**
 * Drop EVERY user's edits and speaker names for a meeting id.
 *
 * The permanent-delete route only clears the OWNER's (both tables are keyed
 * by `(user_id, assemblyai_id)` with no FK to `transcripts`), which is enough
 * there because the id is never reused. An un-split destroys a meeting whose
 * collaborators may have edited it, so it takes the lot.
 */
export async function purgeMeetingAnnotations(assemblyaiId: string): Promise<void> {
  await sql`DELETE FROM ${sql(SCHEMA)}.transcript_edits WHERE assemblyai_id = ${assemblyaiId}`;
  await sql`DELETE FROM ${sql(SCHEMA)}.speaker_mappings WHERE assemblyai_id = ${assemblyaiId}`;
}

// ---------------------------------------------------------------------------
// Payload restore (un-split)
// ---------------------------------------------------------------------------

/**
 * Put the RECORDING's own transcription payload back on a meeting's row,
 * verbatim.
 *
 * This is the un-split's last step for a source that is whole again: its clip
 * set is the default one, so its `imported_content` must be the payload
 * itself — the same bytes it carried before the split, not the resolver's
 * derived rebuild of it (which drops the job-level keys no clip can vouch
 * for). Copied INSIDE Postgres, like the backfill and Phase 2's activate, so
 * no number ever round-trips through a JS double.
 *
 * `duration` and `speaker_count` are recomputed from that payload in the same
 * statement, because the shrink had moved them to the window's.
 */
export async function restoreMeetingPayloadFromRecording(
  transcriptId: number
): Promise<{ restored: boolean; utterances: number }> {
  const rows = await sql<Array<{ assemblyai_id: string; utterances: number }>>`
    UPDATE ${sql(SCHEMA)}.transcripts t
    SET imported_content = rt.payload,
        duration = COALESCE(round((rt.payload->>'audio_duration')::numeric)::int, t.duration),
        speaker_count = COALESCE(
          (SELECT count(DISTINCT u->>'speaker')::int
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(rt.payload->'utterances') = 'array'
                    THEN rt.payload->'utterances' ELSE '[]'::jsonb END) u),
          t.speaker_count)
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.recordings r ON r.id = c.recording_id
    JOIN ${sql(SCHEMA)}.recording_transcriptions rt
      ON rt.id = COALESCE(c.transcription_id, r.active_transcription_id)
    WHERE t.id = ${transcriptId}
      AND c.transcript_id = t.id
      AND c.ord = (SELECT min(ord) FROM ${sql(SCHEMA)}.meeting_clips WHERE transcript_id = t.id)
      AND rt.payload IS NOT NULL
    RETURNING t.assemblyai_id,
              COALESCE(jsonb_array_length(
                CASE WHEN jsonb_typeof(rt.payload->'utterances') = 'array'
                     THEN rt.payload->'utterances' ELSE '[]'::jsonb END), 0) AS utterances
  `;
  const row = rows[0];
  if (!row) return { restored: false, utterances: 0 };
  publishEvent({ kind: 'status', assemblyaiId: row.assemblyai_id });
  return { restored: true, utterances: row.utterances };
}

// ---------------------------------------------------------------------------
// Siblings on one recording
// ---------------------------------------------------------------------------

export interface MeetingOnRecording {
  transcript_id: number;
  user_id: string;
  assemblyai_id: string;
}

/**
 * INTERNAL-ONLY — every meeting that clips this recording, trashed ones
 * included.
 *
 * NOT caller-scoped and never served: this is the maintenance list (a version
 * swap has to touch all of them). The caller-scoped question "which of these
 * may I be told about" is `listSiblingMeetingsForRecordings`.
 */
export async function listMeetingsOnRecording(
  recordingId: string
): Promise<MeetingOnRecording[]> {
  return sql<MeetingOnRecording[]>`
    SELECT DISTINCT t.id AS transcript_id, t.user_id, t.assemblyai_id
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
    WHERE c.recording_id = ${recordingId}::uuid
  `;
}

/**
 * Point every meeting on a recording at the version that is now live.
 *
 * A re-transcribe can be started from ANY meeting on the recording, including
 * one that only holds a window of it. When it lands, the other meetings show
 * the new text (they are re-materialised) — so their rows must also name the
 * new job, model and language, or the recording graph derived from them would
 * describe a transcription that is no longer the active one, and the DEC-4
 * retention pass would still be holding the old job id.
 *
 * Copied from the transcription row inside Postgres. A no-op for a recording
 * with one meeting, which is every row on prod.
 */
export async function alignMeetingsToTranscription(
  recordingId: string,
  transcriptionId: string
): Promise<number> {
  const rows = await sql<Array<{ assemblyai_id: string }>>`
    UPDATE ${sql(SCHEMA)}.transcripts t
    SET aai_job_id    = rt.provider_job_id,
        speech_model  = COALESCE(rt.speech_model, t.speech_model),
        language_code = COALESCE(rt.language_code, t.language_code)
    FROM ${sql(SCHEMA)}.recording_transcriptions rt
    WHERE rt.id = ${transcriptionId}::uuid
      AND t.id IN (
        SELECT transcript_id FROM ${sql(SCHEMA)}.meeting_clips
        WHERE recording_id = ${recordingId}::uuid
      )
      AND t.aai_job_id IS DISTINCT FROM rt.provider_job_id
    RETURNING t.assemblyai_id
  `;
  for (const r of rows) publishEvent({ kind: 'meta', assemblyaiId: r.assemblyai_id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// The clip mirror on the row
// ---------------------------------------------------------------------------

/**
 * Write (or remove) `gmeet_context.clips` — the row's mirror of its clip rows.
 *
 * Removing it is not a detail: a meeting whose clip set is the DEFAULT one
 * must carry no mirror at all, or `deriveRecordingGraph` would go on treating
 * it as clipped and stop copying its payload onto the transcription
 * (`wholeRecording`). That is exactly what an un-split has to undo.
 *
 * `splitFrom` moves with it when given; `null` clears it.
 */
export async function setClipMirror(
  userId: string,
  assemblyaiId: string,
  patch: { clips: unknown[] | null; splitFrom?: unknown | null }
): Promise<void> {
  const setClips = patch.clips
    ? sql`jsonb_set(COALESCE(gmeet_context, '{}'::jsonb), '{clips}', ${sql.json(patch.clips as never)})`
    : sql`COALESCE(gmeet_context, '{}'::jsonb) - 'clips'`;
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = ${
      patch.splitFrom === undefined
        ? setClips
        : patch.splitFrom === null
          ? sql`(${setClips}) - 'splitFrom'`
          : sql`jsonb_set(${setClips}, '{splitFrom}', ${sql.json(patch.splitFrom as never)})`
    }
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
  `;
  publishEvent({ kind: 'meta', assemblyaiId });
}
