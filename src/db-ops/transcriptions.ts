import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { aaiJobIdColumnExists } from '@/db-ops/aai-job-id';
import { publishEvent } from '@/lib/server/event-bus';
import type { TranscriptResponse } from '@/lib/format';
import type {
  ActivatePlan,
  AnnotationSet,
  TranscriptionFacts,
} from '@/lib/transcription-activate';
import type { TranscriptionVersion } from '@/lib/transcriptions';

/**
 * Transcription VERSIONS of a meeting (migration 046, Phase 2 —
 * docs/recordings-phase2-spec.md). Everything that reads or writes
 * `transcription_annotations`, `recording_transcriptions.requested` and the
 * meeting row's `retranscribing` / `notesStale` markers lives here.
 *
 * Migration 044 already gave a recording several transcriptions and an
 * `active_transcription_id`; 046 adds the two things a SWITCH needs — a place
 * to park the annotations of the version being left, and the record of who
 * asked for a run. The generic recording/media/clip CRUD stays in
 * `db-ops/recordings.ts`; this file is only about versions.
 *
 * PRIVACY — the same two rules as db-ops/recordings.ts. A transcription has no
 * ACL of its own: it is reachable through a MEETING the caller can access
 * (`meeting_clips` → `transcripts` → `resolveAccess`) or by the recording's
 * owner. Every function below is INTERNAL-ONLY unless its comment says
 * otherwise — the caller must have passed `resolveAccess()` on the meeting
 * first (feedback_privacy_caller_scoping_gate). One rule is specific to this
 * file: annotations belong to individual users, and `listTranscriptionVersions`
 * returns COUNTS of them, never their content.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

// ---------------------------------------------------------------------------
// Is Phase 2 available at all?
// ---------------------------------------------------------------------------

// globalThis, not module scope: Next bundles this module once per route graph
// and each copy would otherwise run its own probe.
const g = globalThis as unknown as { __mwTranscriptionVersionTables?: Promise<boolean> };

/**
 * `true` when migrations 044 AND 046 have been applied to this schema.
 *
 * Probed once, exactly like `aaiJobIdColumnExists`: a SELECT naming a missing
 * column breaks as hard as an UPDATE, and the whole point of the fallback path
 * is that a server deployed ahead of the migration keeps working. A FAILED
 * probe is not cached (a DB hiccup must not disable versions for the life of
 * the process).
 */
export function transcriptionVersionTablesExist(): Promise<boolean> {
  return (g.__mwTranscriptionVersionTables ??= (async () => {
    const rows = await sql<Array<{ tables: number; columns: number }>>`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = ${SCHEMA}
            AND table_name IN ('recordings', 'recording_transcriptions', 'meeting_clips',
                               'transcription_annotations')) AS tables,
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = ${SCHEMA}
            AND table_name = 'recording_transcriptions'
            AND column_name IN ('requested', 'error')) AS columns
    `;
    const present = (rows[0]?.tables ?? 0) === 4 && (rows[0]?.columns ?? 0) === 2;
    if (!present) {
      console.warn(
        '[transcriptions] migrations/044 + 046 not fully applied — MW_TRANSCRIPTION_VERSIONS is ' +
          'forced off and re-transcribe keeps making a new meeting row'
      );
    }
    return present;
  })().catch((err) => {
    g.__mwTranscriptionVersionTables = undefined;
    throw err;
  }));
}

/**
 * The Phase 2 gate. Lazy per call (a pm2 restart flips it, not a rebuild) and
 * AND-ed with three things that must all hold:
 *
 *  - `MW_RECORDINGS_WRITE`, because a version lives on the recording graph and
 *    a meeting whose graph is not being maintained has no recording to hang it
 *    on;
 *  - 044 + 046, the tables;
 *  - 045 (`transcripts.aai_job_id`), because activating a version rewrites the
 *    meeting's job id — without that column the meeting would be left pointing
 *    at a job that produced a payload it no longer carries.
 *
 * Anything short of all three and the caller takes the pre-Phase-2 path.
 */
export async function transcriptionVersionsEnabled(): Promise<boolean> {
  const raw = process.env.MW_TRANSCRIPTION_VERSIONS;
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return false;
  // Same env as `recordingsWriteEnabled` (lib/server/recording-sync), read
  // here rather than imported: db-ops/recordings.ts needs the table probe
  // above, and importing the sync from this file would close the loop
  // db-ops/recordings → db-ops/transcriptions → recording-sync →
  // db-ops/recordings.
  const write = process.env.MW_RECORDINGS_WRITE;
  if (!write || write === '0' || write.toLowerCase() === 'false') return false;
  const [tables, jobColumn] = await Promise.all([
    transcriptionVersionTablesExist(),
    aaiJobIdColumnExists(),
  ]);
  return tables && jobColumn;
}

// ---------------------------------------------------------------------------
// The meeting's recording
// ---------------------------------------------------------------------------

export interface MeetingRecordingRef {
  recordingId: string;
  /** The recording's `active_transcription_id`, only when the row it names
   * really exists. */
  activeTranscriptionId: string | null;
  /** How many clips the meeting has. Phase 2 works on the 1:1 case only. */
  clips: number;
}

/**
 * INTERNAL-ONLY — which recording a meeting re-transcribes, by its clip.
 *
 * Deliberately NOT `recordingIdFor(canonicalKeyOf(row))`: that derivation says
 * what the recording WOULD be called, not that it exists. A meeting whose
 * graph has never been written (backfill not run, `MW_RECORDINGS_WRITE`
 * switched on after it was created) has no clip, and the caller must fall back
 * to the pre-Phase-2 path rather than invent a recording for it.
 */
export async function meetingRecordingRef(
  transcriptId: number
): Promise<MeetingRecordingRef | null> {
  const rows = await sql<
    Array<{ recording_id: string; active_transcription_id: string | null; clips: number }>
  >`
    SELECT c.recording_id,
           t.id AS active_transcription_id,
           (SELECT count(*)::int FROM ${sql(SCHEMA)}.meeting_clips c2
             WHERE c2.transcript_id = c.transcript_id) AS clips
    FROM ${sql(SCHEMA)}.meeting_clips c
    JOIN ${sql(SCHEMA)}.recordings r ON r.id = c.recording_id
    LEFT JOIN ${sql(SCHEMA)}.recording_transcriptions t
           ON t.id = r.active_transcription_id
    WHERE c.transcript_id = ${transcriptId}
    ORDER BY c.ord
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    recordingId: row.recording_id,
    activeTranscriptionId: row.active_transcription_id,
    clips: row.clips,
  };
}

// ---------------------------------------------------------------------------
// The versions list
// ---------------------------------------------------------------------------

/**
 * The row shape behind one `TranscriptionVersion`. Note what is NOT selected:
 * `payload`. A meeting's payloads are megabytes each and the list is rendered
 * in a disclosure — everything the card shows is pulled OUT of the payload in
 * Postgres instead (spec §5).
 */
interface VersionRow {
  id: string;
  provider: string;
  provider_job_id: string | null;
  speech_model: string | null;
  language_code: string | null;
  status: string;
  created_at: Date | string;
  completed_at: Date | string | null;
  superseded_by: string | null;
  error: string | null;
  requested: {
    by?: { userId?: string; email?: string | null; name?: string | null };
    at?: string;
    speechModel?: string;
    languageCode?: string;
    reason?: string | null;
    activatedAt?: string;
  } | null;
  /** `payload.speech_model_used` — the model that actually ran. */
  model_used: string | null;
  language_detected: boolean | null;
  language_confidence: number | null;
  speakers: number | null;
  edits_set_aside: number;
  names_set_aside: number;
}

const iso = (v: Date | string | null): string | null => {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
};

/**
 * INTERNAL-ONLY (gate on the MEETING first) — every version of the meeting's
 * recording, newest first, as the wire wants them.
 *
 * `editsSetAside` / `speakerNamesSetAside` are counts over EVERY user's parked
 * annotations, which is deliberate: the sentence the card shows is "12 edits
 * set aside", not "12 of your edits". The content of another user's
 * annotations never leaves the server.
 */
export async function listTranscriptionVersions(
  recordingId: string,
  activeTranscriptionId: string | null
): Promise<TranscriptionVersion[]> {
  const rows = await sql<VersionRow[]>`
    SELECT t.id, t.provider, t.provider_job_id, t.speech_model, t.language_code, t.status,
           t.created_at, t.completed_at, t.superseded_by, t.error, t.requested,
           t.payload->>'speech_model_used' AS model_used,
           (t.payload->>'language_detection')::boolean AS language_detected,
           (t.payload->>'language_confidence')::float8 AS language_confidence,
           (
             SELECT count(DISTINCT u->>'speaker')::int
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(t.payload->'utterances') = 'array'
                    THEN t.payload->'utterances' END
             ) u
           ) AS speakers,
           COALESCE((
             SELECT sum(
               CASE WHEN jsonb_typeof(a.edits) = 'object'
                    THEN (SELECT count(*) FROM jsonb_object_keys(a.edits)) ELSE 0 END
             )::int
             FROM ${sql(SCHEMA)}.transcription_annotations a
             WHERE a.transcription_id = t.id
           ), 0) AS edits_set_aside,
           COALESCE((
             SELECT count(*)::int
             FROM ${sql(SCHEMA)}.transcription_annotations a,
                  jsonb_array_elements(
                    CASE WHEN jsonb_typeof(a.speaker_labels->'labels') = 'array'
                         THEN a.speaker_labels->'labels' END
                  ) l
             WHERE a.transcription_id = t.id
               AND COALESCE(btrim(l->>'customName'), '') <> ''
           ), 0) AS names_set_aside
    FROM ${sql(SCHEMA)}.recording_transcriptions t
    WHERE t.recording_id = ${recordingId}::uuid
    ORDER BY t.created_at DESC, t.id
  `;

  return rows.map((r) => {
    const requestedModel = r.requested?.speechModel ?? r.speech_model ?? null;
    return {
      id: r.id,
      active: activeTranscriptionId === r.id,
      status: (r.status === 'completed' || r.status === 'error' ? r.status : 'processing') as
        | 'processing'
        | 'completed'
        | 'error',
      provider: r.provider,
      // What AAI says it RAN beats what we asked for: the Indonesian rows
      // asked for 3.5 Pro and got Universal-2 (lib/aai-outcome.ts,
      // docs/eval-aai-code-switching-2026-09-21.md).
      speechModel: r.model_used ?? r.speech_model ?? null,
      speechModelRequested: requestedModel,
      languageCode: r.language_code,
      // `language_detection: true` is what we send when the caller chose
      // 'auto'; a forced language has the flag absent.
      languageDetected: r.language_detected === true,
      languageConfidence: r.language_confidence ?? null,
      speakerCount: r.speakers ?? null,
      createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
      completedAt: iso(r.completed_at),
      requestedBy: r.requested?.by
        ? { email: r.requested.by.email ?? null, name: r.requested.by.name ?? null }
        : null,
      reason: r.requested?.reason?.trim() || null,
      editsSetAside: r.edits_set_aside,
      speakerNamesSetAside: r.names_set_aside,
      error: r.error,
    };
  });
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

export interface RunRequest {
  by: { userId: string; email: string | null; name: string | null };
  at: string;
  speechModel: string;
  /** What was ASKED for: 'auto' or a language code. */
  languageCode: string;
  reason: string | null;
}

/**
 * INTERNAL-ONLY — open a re-run.
 *
 * Written BEFORE the bytes go to AssemblyAI, with no `provider_job_id` yet:
 * uploading a multi-GB file takes minutes, and if the hand-off fails there has
 * to be a row to say so — a failed re-run must leave the MEETING completely
 * untouched, so its reason cannot go in `gmeet_context.ingestFailure` like an
 * ordinary ingest failure does. `setRunJobId` fills the job in on success.
 */
export async function insertRunTranscription(input: {
  id: string;
  recordingId: string;
  providerJobId: string | null;
  speechModel: string;
  /** The language actually SENT to AssemblyAI (null when it detects). */
  languageCode: string | null;
  /** `recording_transcriptions.covers` — the media ids the job heard. */
  coversMedia: string[];
  requested: RunRequest;
}): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.recording_transcriptions
      (id, recording_id, provider, provider_job_id, speech_model, language_code,
       status, covers, requested)
    VALUES (${input.id}::uuid, ${input.recordingId}::uuid, 'assemblyai',
            ${input.providerJobId}, ${input.speechModel}, ${input.languageCode},
            'processing',
            ${sql.json({ media: input.coversMedia, timeline: 'wall' } as never)},
            ${sql.json(input.requested as never)})
    ON CONFLICT (id) DO UPDATE SET
      status        = 'processing',
      provider_job_id = EXCLUDED.provider_job_id,
      speech_model  = EXCLUDED.speech_model,
      language_code = EXCLUDED.language_code,
      covers        = EXCLUDED.covers,
      requested     = EXCLUDED.requested,
      error         = NULL
  `;
}

/**
 * INTERNAL-ONLY — AssemblyAI accepted the job. `provider_job_id` is UNIQUE, so
 * this is also the double-send guard: a job that is already stored under
 * another transcription cannot be claimed by a second one.
 */
export async function setRunJobId(
  id: string,
  providerJobId: string,
  speechModel: string
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.recording_transcriptions
    SET provider_job_id = ${providerJobId}, speech_model = ${speechModel}
    WHERE id = ${id}::uuid
  `;
}

/**
 * INTERNAL-ONLY — the run finished. The payload is written in the SAME
 * statement that says 'completed' (DEC-4: this poll is the last time we ever
 * see it), and `language_code` / `speech_model` are updated to what AAI
 * actually did, not what we asked for.
 */
export async function completeRunTranscription(
  id: string,
  aai: TranscriptResponse
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.recording_transcriptions SET
      status        = 'completed',
      payload       = ${sql.json(aai as unknown as never)},
      language_code = COALESCE(${aai.language_code ?? null}, language_code),
      completed_at  = COALESCE(${aai.completed ? new Date(aai.completed) : null}, now()),
      error         = NULL
    WHERE id = ${id}::uuid
  `;
}

/** INTERNAL-ONLY — the run failed; the MEETING is left exactly as it was. */
export async function failRunTranscription(id: string, reason: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.recording_transcriptions
    SET status = 'error', error = ${reason.replace(/\s+/g, ' ').slice(0, 300)}
    WHERE id = ${id}::uuid
  `;
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** Everything `planActivate` needs, in three round trips. */
export interface ActivateFacts {
  current: TranscriptionFacts | null;
  target: TranscriptionFacts | null;
  live: AnnotationSet[];
  archived: AnnotationSet[];
  hasNotes: boolean;
  hasReport: boolean;
}

interface FactsRow {
  id: string;
  status: string;
  created_at: Date | string;
  provider_job_id: string | null;
  speech_model: string | null;
  language_code: string | null;
  completed_at: Date | string | null;
  duration_sec: number | null;
  speakers: number | null;
  activated_before: boolean;
}

const factsOf = (r: FactsRow): TranscriptionFacts => ({
  id: r.id,
  status: (r.status === 'completed' || r.status === 'error' ? r.status : 'processing') as
    | 'processing'
    | 'completed'
    | 'error',
  createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
  providerJobId: r.provider_job_id,
  speechModel: r.speech_model,
  languageCode: r.language_code,
  completedAt: iso(r.completed_at),
  durationSec: r.duration_sec,
  speakerCount: r.speakers,
  activatedBefore: r.activated_before,
});

/**
 * INTERNAL-ONLY (gate on the MEETING first) — load the facts for a switch.
 *
 * `duration` and `speaker_count` are derived from the version's own payload
 * rather than carried from the row: a re-run on another model finds a
 * different number of speakers, and a meeting showing the previous version's
 * count would be quietly wrong.
 */
export async function loadActivateFacts(
  transcriptId: number,
  assemblyaiId: string,
  recordingId: string,
  currentId: string | null,
  targetId: string
): Promise<ActivateFacts> {
  const wanted = currentId && currentId !== targetId ? [currentId, targetId] : [targetId];
  const [txns, edits, mappings, archived, row] = await Promise.all([
    sql<FactsRow[]>`
      SELECT t.id, t.status, t.created_at, t.provider_job_id, t.speech_model,
             t.language_code, t.completed_at,
             (t.payload->>'audio_duration')::float8 AS duration_sec,
             (
               SELECT count(DISTINCT u->>'speaker')::int
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(t.payload->'utterances') = 'array'
                      THEN t.payload->'utterances' END
               ) u
             ) AS speakers,
             (t.requested->>'activatedAt') IS NOT NULL AS activated_before
      FROM ${sql(SCHEMA)}.recording_transcriptions t
      WHERE t.recording_id = ${recordingId}::uuid AND t.id = ANY(${wanted}::uuid[])
    `,
    sql<Array<{ user_id: string; edits: Record<string, unknown> | null }>>`
      SELECT user_id, edits FROM ${sql(SCHEMA)}.transcript_edits
      WHERE assemblyai_id = ${assemblyaiId}
    `,
    sql<
      Array<{ user_id: string; speaker_labels: unknown; suggestions: unknown }>
    >`
      SELECT user_id, speaker_labels, suggestions FROM ${sql(SCHEMA)}.speaker_mappings
      WHERE assemblyai_id = ${assemblyaiId}
    `,
    sql<Array<{ user_id: string; edits: unknown; speaker_labels: unknown }>>`
      SELECT user_id, edits, speaker_labels
      FROM ${sql(SCHEMA)}.transcription_annotations
      WHERE transcription_id = ${targetId}::uuid AND transcript_id = ${transcriptId}
    `,
    sql<Array<{ has_notes: boolean; has_report: boolean }>>`
      SELECT (auto_notes IS NOT NULL) AS has_notes, (auto_report IS NOT NULL) AS has_report
      FROM ${sql(SCHEMA)}.transcripts WHERE id = ${transcriptId}
    `,
  ]);

  const byUser = new Map<string, AnnotationSet>();
  const mine = (userId: string): AnnotationSet => {
    let set = byUser.get(userId);
    if (!set) {
      set = { userId, edits: null, speakers: null };
      byUser.set(userId, set);
    }
    return set;
  };
  for (const e of edits) mine(e.user_id).edits = (e.edits ?? null) as AnnotationSet['edits'];
  for (const m of mappings) {
    mine(m.user_id).speakers = {
      labels: (m.speaker_labels ?? []) as never,
      suggestions: (m.suggestions ?? null) as never,
    };
  }

  const currentRow = currentId ? txns.find((t) => t.id === currentId) : undefined;
  const targetRow = txns.find((t) => t.id === targetId);

  return {
    current: currentRow ? factsOf(currentRow) : null,
    target: targetRow ? factsOf(targetRow) : null,
    live: [...byUser.values()],
    archived: archived.map((a) => ({
      userId: a.user_id,
      edits: (a.edits ?? null) as AnnotationSet['edits'],
      speakers: (a.speaker_labels ?? null) as AnnotationSet['speakers'],
    })),
    hasNotes: row[0]?.has_notes === true,
    hasReport: row[0]?.has_report === true,
  };
}

/**
 * INTERNAL-ONLY — execute a plan from `planActivate`, in ONE transaction.
 *
 * Everything the meeting shows moves together or not at all: park, restore,
 * copy the payload onto the row, flip the recording's pointer, chain
 * `superseded_by`, stamp `notesStale`. The payload is copied INSIDE Postgres
 * (`UPDATE … FROM recording_transcriptions`) — a megabyte of jsonb must never
 * round-trip through JS.
 *
 * `assemblyaiId` is the meeting's public id, which the two annotation tables
 * are keyed on together with a user id. Every user's rows are moved: a
 * collaborator's edits are as index-keyed as the owner's.
 */
export async function applyActivatePlan(
  plan: ActivatePlan,
  meeting: { assemblyaiId: string }
): Promise<void> {
  const id = meeting.assemblyaiId;
  await sql.begin(async (tx) => {
    // 1. Park what the meeting carries now, under the version being left.
    for (const set of plan.archive.sets) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.transcription_annotations
          (transcription_id, transcript_id, user_id, edits, speaker_labels, archived_at)
        VALUES (${plan.archive.transcriptionId}::uuid, ${plan.transcriptId}, ${set.userId},
                ${set.edits ? tx.json(set.edits as never) : null},
                ${set.speakers ? tx.json(set.speakers as never) : null},
                now())
        ON CONFLICT (transcription_id, transcript_id, user_id) DO UPDATE SET
          edits          = EXCLUDED.edits,
          speaker_labels = EXCLUDED.speaker_labels,
          archived_at    = now()
      `;
    }

    // 2. Clear the live rows of everyone who has nothing coming back. Index-
    //    keyed edits applied to another version's utterances would rewrite
    //    the wrong lines, so this is not optional.
    if (plan.clearUsers.length > 0) {
      await tx`
        DELETE FROM ${tx(SCHEMA)}.transcript_edits
        WHERE assemblyai_id = ${id} AND user_id = ANY(${plan.clearUsers})
      `;
      await tx`
        DELETE FROM ${tx(SCHEMA)}.speaker_mappings
        WHERE assemblyai_id = ${id} AND user_id = ANY(${plan.clearUsers})
      `;
    }

    // 3. Bring back what was parked against the version being entered.
    for (const set of plan.restore) {
      if (set.edits && Object.keys(set.edits).length > 0) {
        await tx`
          INSERT INTO ${tx(SCHEMA)}.transcript_edits (user_id, assemblyai_id, edits)
          VALUES (${set.userId}, ${id}, ${tx.json(set.edits as never)})
          ON CONFLICT (user_id, assemblyai_id) DO UPDATE
            SET edits = EXCLUDED.edits, updated_at = now()
        `;
      } else {
        await tx`
          DELETE FROM ${tx(SCHEMA)}.transcript_edits
          WHERE user_id = ${set.userId} AND assemblyai_id = ${id}
        `;
      }
      if (set.speakers) {
        await tx`
          INSERT INTO ${tx(SCHEMA)}.speaker_mappings
            (user_id, assemblyai_id, speaker_labels, suggestions)
          VALUES (${set.userId}, ${id}, ${tx.json((set.speakers.labels ?? []) as never)},
                  ${set.speakers.suggestions ? tx.json(set.speakers.suggestions as never) : null})
          ON CONFLICT (user_id, assemblyai_id) DO UPDATE
            SET speaker_labels = EXCLUDED.speaker_labels,
                suggestions    = EXCLUDED.suggestions,
                updated_at     = now()
        `;
      } else {
        await tx`
          DELETE FROM ${tx(SCHEMA)}.speaker_mappings
          WHERE user_id = ${set.userId} AND assemblyai_id = ${id}
        `;
      }
    }
    // The annotations that have just come back belong to the live tables now,
    // not to the archive — leaving both would double-count them in the
    // versions list ("12 edits set aside" on the version you are reading).
    if (plan.restore.length > 0) {
      await tx`
        DELETE FROM ${tx(SCHEMA)}.transcription_annotations
        WHERE transcription_id = ${plan.activeTranscriptionId}::uuid
          AND transcript_id = ${plan.transcriptId}
      `;
    }

    // 4. The meeting row now reads the target version. `status` is untouched
    //    on purpose: it is already 'completed' and a switch is not a
    //    transcription. `speaker_id_*` is re-armed only for a version nobody
    //    has worked out the speakers of yet — that is the review gate
    //    applying again (spec Flow 4).
    await tx`
      UPDATE ${tx(SCHEMA)}.transcripts t
      SET imported_content = src.payload,
          aai_job_id       = ${plan.row.aaiJobId},
          speech_model     = ${plan.row.speechModel},
          language_code    = ${plan.row.languageCode},
          duration         = COALESCE(${plan.row.durationSec}, t.duration),
          speaker_count    = ${plan.row.speakerCount},
          completed_at     = COALESCE(${plan.row.completedAt}::timestamptz, t.completed_at),
          speaker_id_status = CASE WHEN ${plan.brandNew} THEN NULL ELSE t.speaker_id_status END,
          speaker_id_error  = CASE WHEN ${plan.brandNew} THEN NULL ELSE t.speaker_id_error END,
          speaker_id_at     = CASE WHEN ${plan.brandNew} THEN NULL ELSE t.speaker_id_at END,
          gmeet_context    = (COALESCE(t.gmeet_context, '{}'::jsonb) - 'retranscribing'
                                - ${plan.clearNotesStale ? 'notesStale' : ''}::text)
                             || ${tx.json((plan.notesStale ? { notesStale: plan.notesStale } : {}) as never)}
      FROM ${tx(SCHEMA)}.recording_transcriptions src
      WHERE src.id = ${plan.row.payloadFromTranscriptionId}::uuid
        AND t.id = ${plan.transcriptId}
    `;

    // 5. The recording points at the new version; the old one records that it
    //    was superseded (only when the new one really is newer — switching
    //    BACK must not claim the older version supersedes the newer).
    await tx`
      UPDATE ${tx(SCHEMA)}.recordings
      SET active_transcription_id = ${plan.activeTranscriptionId}::uuid, updated_at = now()
      WHERE id = (SELECT recording_id FROM ${tx(SCHEMA)}.recording_transcriptions
                   WHERE id = ${plan.activeTranscriptionId}::uuid)
    `;
    if (plan.supersede) {
      await tx`
        UPDATE ${tx(SCHEMA)}.recording_transcriptions
        SET superseded_by = ${plan.supersede.by}::uuid
        WHERE id = ${plan.supersede.transcriptionId}::uuid
      `;
    }
    // "This version has been live at least once" — what stops a second switch
    // forward from paying for the speaker-ID pass all over again.
    await tx`
      UPDATE ${tx(SCHEMA)}.recording_transcriptions
      -- The ::text cast is load-bearing: jsonb_build_object takes "any", so
      -- an uncast parameter has no inferable type and Postgres refuses the
      -- whole statement ("could not determine data type of parameter $1").
      SET requested = COALESCE(requested, '{}'::jsonb)
                      || jsonb_build_object('activatedAt', ${new Date().toISOString()}::text)
      WHERE id = ${plan.activeTranscriptionId}::uuid
        AND requested->>'activatedAt' IS NULL
    `;
  });

  // Open pages re-read the payload and the card; the listing re-reads the row.
  publishEvent({ kind: 'status', assemblyaiId: id });
  publishEvent({ kind: 'meta', assemblyaiId: id });
}

// ---------------------------------------------------------------------------
// Markers on the meeting row
// ---------------------------------------------------------------------------

/**
 * INTERNAL-ONLY — `gmeet_context.retranscribing`, written atomically in SQL
 * (the row's context is written from several places and a read-modify-write in
 * JS would clobber a concurrent one — same reason as
 * `setVideoPartStoredForUser`). Guarded on the marker being ABSENT, so two
 * simultaneous "Transcribe again" clicks cannot both start a job: the loser
 * gets `false` and its caller refuses.
 */
export async function claimRetranscribeMarker(
  userId: string,
  assemblyaiId: string,
  marker: Record<string, unknown>
): Promise<boolean> {
  const rows = await sql<Array<{ id: number }>>`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = COALESCE(gmeet_context, '{}'::jsonb)
                        || ${sql.json({ retranscribing: marker } as never)}
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
      AND COALESCE(gmeet_context->'retranscribing', 'null'::jsonb) = 'null'::jsonb
    RETURNING id
  `;
  if (rows.length > 0) publishEvent({ kind: 'meta', assemblyaiId });
  return rows.length > 0;
}

/**
 * INTERNAL-ONLY — AssemblyAI has the job; put its id on the marker so the
 * pollers can start asking about it. Guarded on the marker still naming THIS
 * run, so a marker cleared (or replaced) while the bytes were uploading is not
 * resurrected.
 */
export async function setRetranscribeMarkerJob(
  userId: string,
  assemblyaiId: string,
  transcriptionId: string,
  jobId: string
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = jsonb_set(gmeet_context, '{retranscribing,jobId}', ${sql.json(jobId as never)})
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
      AND gmeet_context->'retranscribing'->>'transcriptionId' = ${transcriptionId}
  `;
  publishEvent({ kind: 'meta', assemblyaiId });
}

/** INTERNAL-ONLY — the run ended (activated, failed, or never started). */
export async function clearRetranscribeMarker(
  userId: string,
  assemblyaiId: string,
  /** Only clear the marker if it still names THIS run — a background task
   * that finishes late must not take a newer run's marker with it. */
  transcriptionId?: string
): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.transcripts
    SET gmeet_context = COALESCE(gmeet_context, '{}'::jsonb) - 'retranscribing'
    WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
      ${
        transcriptionId
          ? sql`AND gmeet_context->'retranscribing'->>'transcriptionId' = ${transcriptionId}`
          : sql``
      }
  `;
  publishEvent({ kind: 'meta', assemblyaiId });
}

/**
 * The `notesStale` marker goes when the artefacts it describes have been
 * rewritten. Called from the two writers that produce them
 * (`setAutoNotesForUser` / `setAutoReportForUser`), and deliberately
 * conservative: the marker only clears once EVERY artefact the meeting has is
 * newer than `since`, so regenerating the summary alone does not silence a
 * report that is still written from the previous version.
 *
 * Cheap enough to call on every notes write: the WHERE hits
 * `UNIQUE (user_id, assemblyai_id)` and stops at `? 'notesStale'`, which is
 * false for every meeting that was never re-transcribed. It also costs
 * nothing when 046 is absent — the marker lives in `gmeet_context`, which has
 * always been there.
 */
export async function clearNotesStaleIfRegenerated(
  userId: string,
  assemblyaiId: string
): Promise<void> {
  await sql`
    WITH mine AS (
      SELECT id,
             auto_notes, auto_notes_at, auto_report, auto_report_at,
             -- A malformed marker must not make the cast throw on every notes
             -- write; NULL then means "no floor", which clears it.
             -- Digits are spelled [0-9] on purpose. The shorthand class that
             -- starts with a backslash cannot be written inside this template
             -- literal: JS drops the backslash of an unrecognised escape, so
             -- the pattern would reach Postgres as a literal letter and never
             -- match, silently clearing the marker on the first regenerated
             -- tier. (See the module note in db-ops/recordings.ts about what
             -- may and may not go inside a sql template.)
             CASE WHEN gmeet_context->'notesStale'->>'since' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                  THEN (gmeet_context->'notesStale'->>'since')::timestamptz END AS since
      FROM ${sql(SCHEMA)}.transcripts
      WHERE user_id = ${userId} AND assemblyai_id = ${assemblyaiId}
        AND gmeet_context ? 'notesStale'
    )
    UPDATE ${sql(SCHEMA)}.transcripts t
    SET gmeet_context = t.gmeet_context - 'notesStale'
    FROM mine
    WHERE t.id = mine.id
      AND (
        mine.since IS NULL
        OR ((mine.auto_notes IS NULL OR mine.auto_notes_at >= mine.since)
        AND (mine.auto_report IS NULL OR mine.auto_report_at >= mine.since))
      )
  `;
}

export interface RetranscribingRow {
  id: number;
  user_id: string;
  assemblyai_id: string;
  transcription_id: string;
  job_id: string;
  started_at: string;
}

/**
 * INTERNAL-ONLY — every meeting with a run in flight, oldest first. The
 * 5-minute sweeper's backstop: a re-run is observed by whichever poller gets
 * there first, and nobody may have the page open.
 */
export async function listRetranscribingMeetings(limit: number): Promise<RetranscribingRow[]> {
  return sql<RetranscribingRow[]>`
    SELECT id, user_id, assemblyai_id,
           gmeet_context->'retranscribing'->>'transcriptionId' AS transcription_id,
           gmeet_context->'retranscribing'->>'jobId'           AS job_id,
           gmeet_context->'retranscribing'->>'startedAt'       AS started_at
    FROM ${sql(SCHEMA)}.transcripts
    WHERE gmeet_context->'retranscribing'->>'jobId' IS NOT NULL
    ORDER BY gmeet_context->'retranscribing'->>'startedAt'
    LIMIT ${limit}
  `;
}

/**
 * CALLER-SCOPED — the caller's visible meetings with a run in flight. The
 * listing's pending fan-out polls these alongside the rows AssemblyAI still
 * owes an answer for; the predicate is the same owner-or-share one
 * `listVisibleToUser` uses.
 */
export async function listRetranscribingVisibleToUser(
  userId: string,
  email: string
): Promise<RetranscribingRow[]> {
  const normEmail = email.trim().toLowerCase();
  return sql<RetranscribingRow[]>`
    SELECT DISTINCT t.id, t.user_id, t.assemblyai_id,
           t.gmeet_context->'retranscribing'->>'transcriptionId' AS transcription_id,
           t.gmeet_context->'retranscribing'->>'jobId'           AS job_id,
           t.gmeet_context->'retranscribing'->>'startedAt'       AS started_at
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id AND s.shared_with_email = ${normEmail}
    WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
      AND t.deleted_at IS NULL
      AND t.gmeet_context->'retranscribing'->>'jobId' IS NOT NULL
  `;
}

/**
 * INTERNAL-ONLY — the meeting is being permanently deleted; its parked
 * annotations go with it. `transcription_annotations` has no FK (the
 * transcription may outlive the meeting on a shared recording), so this is
 * the one place that cleans them up.
 */
export async function deleteAnnotationsForMeeting(transcriptId: number): Promise<number> {
  // Self-guarded: permanent delete runs whatever the flags say, and on a
  // server where 046 has not been applied this table does not exist.
  if (!(await transcriptionVersionTablesExist())) return 0;
  const rows = await sql<Array<{ user_id: string }>>`
    DELETE FROM ${sql(SCHEMA)}.transcription_annotations
    WHERE transcript_id = ${transcriptId}
    RETURNING user_id
  `;
  return rows.length;
}

/**
 * INTERNAL-ONLY — how many `transcripts` rows hold this meeting id. More than
 * one is the ONE legacy two-owner AssemblyAI job (landmine #14): both rows
 * name the same job, only one of them has the bytes, and re-transcribing
 * either would move the other's text under it. Phase 2 refuses there.
 */
export async function meetingCopyCount(assemblyaiId: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.transcripts
    WHERE assemblyai_id = ${assemblyaiId}
  `;
  return rows[0]?.n ?? 0;
}
