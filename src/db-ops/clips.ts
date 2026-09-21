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

// ---------------------------------------------------------------------------
// Phase 3b — several recordings, one meeting (MW_COMBINE)
// ---------------------------------------------------------------------------

/**
 * `MW_COMBINE`, AND-ed with everything under it.
 *
 * Lazy per call, like `clipsFlagOn` — a pm2 restart flips it, not a rebuild.
 * Combining is a strict extension of clips: it writes a SECOND clip row on a
 * meeting and materialises the merged payload onto its row, so a server with
 * `MW_COMBINE=1` and `MW_CLIPS=0` would write clips nothing reads.
 */
export function combineFlagOn(): boolean {
  const on = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';
  return on(process.env.MW_COMBINE) && clipsFlagOn();
}

export async function combineEnabled(): Promise<boolean> {
  if (!combineFlagOn()) return false;
  return clipsEnabled();
}

/** Everything a clip row needs to describe its recording to a person. */
export interface ClipRecordingDetail {
  id: string;
  owner_user_id: string;
  source_kind: string;
  started_at: string | null;
  duration_ms: number | null;
  /** A completed transcription with a payload exists. */
  transcribed: boolean;
  /** The name the file was uploaded under, from the canonical media's
   * `source_ref` (the stored name is a uuid and tells a person nothing). */
  original_filename: string | null;
  deleted_at: string | null;
}

const recordingDetailCols = () => sql`
  r.id, r.owner_user_id, r.source_kind, r.started_at,
  r.duration_ms::float8 AS duration_ms, r.deleted_at,
  EXISTS (
    SELECT 1 FROM ${sql(SCHEMA)}.recording_transcriptions rt
    WHERE rt.recording_id = r.id AND rt.status = 'completed' AND rt.payload IS NOT NULL
  ) AS transcribed,
  (
    SELECT m.source_ref->>'originalFilename'
    FROM ${sql(SCHEMA)}.recording_media m
    WHERE m.recording_id = r.id AND m.kind = 'canonical'
    ORDER BY m.ord LIMIT 1
  ) AS original_filename
`;

/**
 * INTERNAL-ONLY — the recordings behind a set of clip rows. The caller has
 * already passed `resolveAccess` on the MEETING those clips belong to, which
 * is reachability route (a).
 */
export async function recordingDetailsFor(
  recordingIds: string[]
): Promise<Map<string, ClipRecordingDetail>> {
  const out = new Map<string, ClipRecordingDetail>();
  if (recordingIds.length === 0) return out;
  const rows = await sql<ClipRecordingDetail[]>`
    SELECT ${recordingDetailCols()}
    FROM ${sql(SCHEMA)}.recordings r
    WHERE r.id = ANY(${recordingIds}::uuid[])
  `;
  for (const r of rows) out.set(r.id, r);
  return out;
}

/**
 * One candidate recording, as the caller-scoped query returns it. The
 * meeting columns are NULL when no meeting the caller can open holds it —
 * which, together with the WHERE below, means the caller owns it and nothing
 * claims it (the Recordings tab's "not linked to a meeting yet").
 */
export interface AddableRecordingRow extends ClipRecordingDetail {
  mine: boolean;
  meeting_id: string | null;
  meeting_title: string | null;
  meeting_original_filename: string | null;
  meeting_has_event: boolean | null;
  meeting_scratch: boolean | null;
  meeting_recorded_at: string | null;
  meeting_created_at: string | null;
  /** The caller may EDIT that meeting (owner, or a non-read share). */
  meeting_can_edit: boolean | null;
}

/**
 * CALLER-SCOPED — every recording this caller may be OFFERED as a clip
 * source: their own live recordings, plus the recordings of meetings they can
 * EDIT (spec §Privacy — "every list of candidate recordings is caller-scoped").
 *
 * The scoping is the whole point, and it is the same predicate
 * `listSiblingMeetingsForRecordings` uses: a recording has no ACL, so the only
 * things that may put one on this list are (b) the caller owns it, or (a) the
 * caller can reach it through a meeting they can open AND edit. A read-only
 * reader of a meeting never sees its recording offered — they could not add it
 * anywhere anyway, and the offer itself would be a leak
 * (feedback_privacy_caller_scoping_gate).
 *
 * Whether the caller may actually ADD one is a SEPARATE question the route
 * answers from `owner_user_id` (`validateAddClip`): someone else's bytes are
 * theirs to give, not ours. The row is listed so the sheet can say so.
 *
 * The meeting columns come from ONE lateral, scoped to the caller, so a
 * meeting they cannot open never contributes its title — not even to a row
 * they are allowed to see by route (b).
 */
export async function listAddableRecordings(
  caller: { userId: string; email: string },
  opts?: { limit?: number; recordingId?: string }
): Promise<AddableRecordingRow[]> {
  const normEmail = caller.email.trim().toLowerCase();
  return sql<AddableRecordingRow[]>`
    SELECT ${recordingDetailCols()},
           (r.owner_user_id = ${caller.userId}) AS mine,
           mt.assemblyai_id     AS meeting_id,
           mt.title             AS meeting_title,
           mt.original_filename AS meeting_original_filename,
           mt.has_event         AS meeting_has_event,
           mt.scratch           AS meeting_scratch,
           mt.recorded_at       AS meeting_recorded_at,
           mt.created_at        AS meeting_created_at,
           mt.can_edit          AS meeting_can_edit
    FROM ${sql(SCHEMA)}.recordings r
    LEFT JOIN LATERAL (
      SELECT t.assemblyai_id, t.title, t.original_filename, t.scratch,
             t.recorded_at, t.created_at,
             (t.gmeet_context->>'eventId' IS NOT NULL) AS has_event,
             (t.user_id = ${caller.userId} OR s.access IS DISTINCT FROM 'read') AS can_edit
      FROM ${sql(SCHEMA)}.meeting_clips c
      JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
      LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
        ON s.transcript_id = t.id AND s.shared_with_email = ${normEmail}
      WHERE c.recording_id = r.id
        AND t.deleted_at IS NULL
        AND (t.user_id = ${caller.userId} OR s.id IS NOT NULL)
      ORDER BY (t.user_id = ${caller.userId}) DESC, t.created_at, t.id
      LIMIT 1
    ) mt ON true
    WHERE r.deleted_at IS NULL
      AND (r.owner_user_id = ${caller.userId} OR mt.can_edit IS TRUE)
      ${opts?.recordingId ? sql`AND r.id = ${opts.recordingId}::uuid` : sql``}
    ORDER BY r.started_at DESC NULLS LAST, r.created_at DESC
    LIMIT ${opts?.limit ?? 100}
  `;
}

/**
 * INTERNAL-ONLY — write ONE clip row without disturbing the others.
 *
 * `applyMeetingClips` is a whole-set apply (it deletes every ord the caller
 * did not name), which is right for a split that rewrites the set and wrong
 * for an add that must leave the existing clips exactly where they are. The
 * meeting has already been gated, and `recordingExists` checked, by the route.
 */
export async function upsertMeetingClip(input: {
  transcriptId: number;
  ord: number;
  recordingId: string;
  fromMs: number;
  toMs: number | null;
  offsetMs: number;
  textPolicy: string;
  createdBy?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.meeting_clips
      (transcript_id, ord, recording_id, transcription_id, from_ms, to_ms,
       offset_ms, text_policy, created_by)
    VALUES (${input.transcriptId}, ${input.ord}, ${input.recordingId}::uuid, NULL,
            ${input.fromMs}, ${input.toMs}, ${input.offsetMs},
            ${input.textPolicy}, ${input.createdBy ?? null})
    ON CONFLICT (transcript_id, ord) DO UPDATE SET
      recording_id = EXCLUDED.recording_id,
      from_ms      = EXCLUDED.from_ms,
      to_ms        = EXCLUDED.to_ms,
      offset_ms    = EXCLUDED.offset_ms,
      text_policy  = EXCLUDED.text_policy
  `;
}

/** INTERNAL-ONLY — un-combine: one clip goes, the recording stays (spec
 * §"Reader and writer changes"). Returns the recording it pointed at. */
export async function deleteMeetingClip(
  transcriptId: number,
  ord: number
): Promise<string | null> {
  const rows = await sql<Array<{ recording_id: string }>>`
    DELETE FROM ${sql(SCHEMA)}.meeting_clips
    WHERE transcript_id = ${transcriptId} AND ord = ${ord}
    RETURNING recording_id
  `;
  return rows[0]?.recording_id ?? null;
}

/**
 * INTERNAL-ONLY — every OTHER meeting that holds a clip on this recording and
 * carries clip windows of its own, i.e. the meetings whose text has to be
 * rebuilt when this recording's transcription lands (spec §API: "playable
 * now, text later — materialise again on completion").
 */
export async function clippedMeetingsOnRecordingExcept(
  recordingId: string,
  exceptTranscriptId: number
): Promise<number[]> {
  const rows = await sql<Array<{ transcript_id: number }>>`
    SELECT DISTINCT c.transcript_id
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = c.transcript_id
    WHERE c.recording_id = ${recordingId}::uuid
      AND c.transcript_id <> ${exceptTranscriptId}
      AND t.gmeet_context ? 'clips'
  `;
  return rows.map((r) => r.transcript_id);
}
