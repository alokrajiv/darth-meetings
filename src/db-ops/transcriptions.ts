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
import type {
  TranscriptionMergeInfo,
  TranscriptionRunMode,
  TranscriptionVersion,
} from '@/lib/transcriptions';
import { transcriptHealth, type TranscriptHealth } from '@/lib/transcript-health';
import type { MergeOptions, MergeStats } from '@/lib/transcript-merge';
import type { MergeCandidate } from '@/lib/transcription-merge-plan';

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
    merge?: {
      base?: string;
      fill?: string;
      fillLanguage?: string | null;
      stats?: MergeStats;
    };
  } | null;
  /** `payload.speech_model_used` — the model that actually ran. */
  model_used: string | null;
  /** `payload.confidence` — mean word confidence. */
  asr_confidence: number | null;
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
/** How many versions per call get a `health` (each needs its payload loaded). */
export const HEALTH_VERSIONS_PER_CALL = 6;

export async function listTranscriptionVersions(
  recordingId: string,
  activeTranscriptionId: string | null,
  opts: {
    /** Compute `health` for the newest completed versions (default true).
     * The start-a-run path only needs the settings and passes false. */
    health?: boolean;
  } = {}
): Promise<TranscriptionVersion[]> {
  const rows = await sql<VersionRow[]>`
    SELECT t.id, t.provider, t.provider_job_id, t.speech_model, t.language_code, t.status,
           t.created_at, t.completed_at, t.superseded_by, t.error, t.requested,
           t.payload->>'speech_model_used' AS model_used,
           (t.payload->>'confidence')::float8 AS asr_confidence,
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

  // Health needs the utterances, which the query above deliberately does not
  // pull. The list is small (a handful of versions per recording), so the
  // newest few COMPLETED payloads are loaded in one more round trip — minus
  // the top-level `words`, which duplicate the utterances' and are half the
  // bytes. Capped, so a recording someone re-ran thirty times does not load
  // thirty payloads to draw a disclosure.
  const health = new Map<string, TranscriptHealth>();
  if (opts.health !== false) {
    const ids = rows
      .filter((r) => r.status === 'completed')
      .slice(0, HEALTH_VERSIONS_PER_CALL)
      .map((r) => r.id);
    if (ids.length > 0) {
      const payloads = await sql<Array<{ id: string; payload: TranscriptResponse | null }>>`
        SELECT id, payload - 'words' AS payload
        FROM ${sql(SCHEMA)}.recording_transcriptions
        WHERE id = ANY(${ids}::uuid[]) AND payload IS NOT NULL
      `;
      for (const p of payloads) {
        if (p.payload) health.set(p.id, transcriptHealth(p.payload));
      }
    }
  }

  return rows.map((r) => {
    const requestedModel = r.requested?.speechModel ?? r.speech_model ?? null;
    const m = r.requested?.merge;
    const merge: TranscriptionMergeInfo | null =
      r.provider === 'merge' && m?.base && m.fill
        ? {
            base: m.base,
            fill: m.fill,
            fillLanguage: m.fillLanguage ?? null,
            stats: m.stats ?? {
              utterances: 0,
              utterancesTouched: 0,
              utterancesWhole: 0,
              swappedMs: 0,
              durationMs: 0,
              fillWordsUsed: 0,
            },
          }
        : null;
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
      languageRequested: r.requested?.languageCode ?? null,
      asrConfidence: r.asr_confidence ?? null,
      health: health.get(r.id) ?? null,
      merge,
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
  /** What was ASKED for: 'auto', 'auto-en' or a language code. */
  languageCode: string;
  reason: string | null;
  /** What happens when it lands (docs/transcription-merge-spec.md §3a).
   * Absent on runs started before the merge spec = 'replace'. */
  mode?: TranscriptionRunMode;
  /** mode 'merge': the active version at the start — one of the two merge
   * candidates (which one is the base is decided by language on landing). */
  mergeBase?: string | null;
  mergeOptions?: MergeOptions;
  /**
   * 'recording' = a run on a recording that belongs to no meeting (§3c). Such
   * a run has no meeting row to carry the `retranscribing` marker, so this
   * stamp is how the sweeper finds it. Absent = a meeting's run.
   */
  scope?: 'recording';
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
  derived: boolean;
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
  derived: r.derived,
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
      -- A merged version has no model of its own (it ran nowhere); the
      -- meeting row then carries the model its base ACTUALLY ran, which the
      -- merged payload inherits verbatim, instead of going blank.
      SELECT t.id, t.status, t.created_at, t.provider_job_id,
             COALESCE(t.speech_model, t.payload->>'speech_model_used') AS speech_model,
             t.language_code, t.completed_at,
             (t.provider = 'merge') AS derived,
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

// ---------------------------------------------------------------------------
// Run modes, merged versions, recording-level runs
// (docs/transcription-merge-spec.md §3)
// ---------------------------------------------------------------------------

/** What a landing run was asked to do, read off its own row. */
export interface RunRecord {
  recordingId: string;
  status: string;
  providerJobId: string | null;
  requested: (RunRequest & Record<string, unknown>) | null;
}

/**
 * INTERNAL-ONLY — the run's own `requested`, the authority on its mode. The
 * meeting's marker carries a copy for the UI; this row is what the poller
 * trusts (a marker written before the merge spec has no `mode` at all).
 */
export async function getRunRecord(transcriptionId: string): Promise<RunRecord | null> {
  const rows = await sql<
    Array<{ recording_id: string; status: string; provider_job_id: string | null; requested: RunRecord['requested'] }>
  >`
    SELECT recording_id, status, provider_job_id, requested
    FROM ${sql(SCHEMA)}.recording_transcriptions
    WHERE id = ${transcriptionId}::uuid
  `;
  const r = rows[0];
  return r
    ? { recordingId: r.recording_id, status: r.status, providerJobId: r.provider_job_id, requested: r.requested }
    : null;
}

/** A version as orientation and the version-content route see it. */
export interface VersionHead extends MergeCandidate {
  provider: string;
  /** `requested.merge.base` on a merged version, else null. */
  mergeBase: string | null;
}

/**
 * INTERNAL-ONLY (gate first) — the light facts of EVERY version of a
 * recording: status, language, model that ran, and where a merged one came
 * from. Small rows, no payload; the label-space walk needs the whole set.
 */
export async function listVersionHeads(recordingId: string): Promise<VersionHead[]> {
  const rows = await sql<
    Array<{
      id: string;
      status: string;
      provider: string;
      language_code: string | null;
      model_used: string | null;
      merge_base: string | null;
    }>
  >`
    SELECT id, status, provider, language_code,
           payload->>'speech_model_used' AS model_used,
           requested->'merge'->>'base' AS merge_base
    FROM ${sql(SCHEMA)}.recording_transcriptions
    WHERE recording_id = ${recordingId}::uuid
  `;
  return rows.map((r) => ({
    id: r.id,
    status: (r.status === 'completed' || r.status === 'error' ? r.status : 'processing') as
      | 'processing'
      | 'completed'
      | 'error',
    provider: r.provider,
    languageCode: r.language_code,
    modelUsed: r.model_used,
    mergeBase: r.provider === 'merge' ? r.merge_base : null,
  }));
}

/**
 * INTERNAL-ONLY (gate first) — full payloads of some versions of ONE
 * recording. The recording id is part of the predicate on purpose: a
 * transcription id from a request is only ever honoured when it belongs to
 * the recording the caller was gated on.
 */
export async function loadVersionPayloads(
  recordingId: string,
  ids: string[]
): Promise<Map<string, TranscriptResponse>> {
  const out = new Map<string, TranscriptResponse>();
  if (ids.length === 0) return out;
  const rows = await sql<Array<{ id: string; payload: TranscriptResponse | null }>>`
    SELECT id, payload FROM ${sql(SCHEMA)}.recording_transcriptions
    WHERE recording_id = ${recordingId}::uuid AND id = ANY(${ids}::uuid[])
      AND status = 'completed' AND payload IS NOT NULL
  `;
  for (const r of rows) if (r.payload) out.set(r.id, r.payload);
  return out;
}

/** `requested` of a merged version (spec §3b). */
export interface MergedRequest {
  by: { userId: string; email: string | null; name: string | null } | null;
  at: string;
  reason: string | null;
  merge: {
    base: string;
    fill: string;
    fillLanguage: string | null;
    options: Required<MergeOptions>;
    stats: MergeStats;
    /** The run whose landing produced this merge, when it was automatic. */
    fromRun?: string;
  };
}

/**
 * INTERNAL-ONLY (gate first) — write a MERGED version, and carry its base's
 * annotations over to it, in ONE transaction.
 *
 * The row: `provider = 'merge'`, born `completed`, no job (it ran nowhere, so
 * there is nothing at AssemblyAI to poll or delete), `language_code` and
 * `covers` copied from the base inside Postgres. `requested` is always set —
 * which is also what keeps a graph re-derivation from ever deleting it
 * (db-ops/recordings.ts: a transcription with `requested` is a version).
 *
 * The carry-over is what keeps speaker names and edits when the merged
 * version goes live. Its utterances are the base's — same count, order,
 * speaker letters (lib/transcript-merge.ts) — so the base's index-keyed edits
 * and label-keyed names apply to it unchanged. They are copied as PARKED rows
 * under the merged id; activation then restores them through the existing
 * path. Where from:
 *  - base is the recording's active version → its annotations are LIVE:
 *    every user's `transcript_edits` + `speaker_mappings`, for every meeting
 *    with a clip on the recording (the shape `applyActivatePlan` parks);
 *  - otherwise → the base's own parked `transcription_annotations` rows.
 * A snapshot: edits made on the base after this point stay with the base.
 *
 * Returns false (nothing written) when the base is not a completed version
 * of this recording.
 */
export async function insertMergedTranscription(input: {
  id: string;
  recordingId: string;
  baseId: string;
  payload: TranscriptResponse;
  requested: MergedRequest;
}): Promise<boolean> {
  return sql.begin(async (tx) => {
    const inserted = await tx<Array<{ id: string }>>`
      INSERT INTO ${tx(SCHEMA)}.recording_transcriptions
        (id, recording_id, provider, provider_job_id, speech_model, language_code,
         status, payload, covers, completed_at, requested)
      SELECT ${input.id}::uuid, b.recording_id, 'merge', NULL, NULL, b.language_code,
             'completed', ${tx.json(input.payload as never)}, b.covers, now(),
             ${tx.json(input.requested as never)}
      FROM ${tx(SCHEMA)}.recording_transcriptions b
      WHERE b.id = ${input.baseId}::uuid AND b.recording_id = ${input.recordingId}::uuid
        AND b.status = 'completed'
      RETURNING id
    `;
    if (inserted.length === 0) return false;

    const active = await tx<Array<{ active_transcription_id: string | null }>>`
      SELECT active_transcription_id FROM ${tx(SCHEMA)}.recordings
      WHERE id = ${input.recordingId}::uuid
    `;
    if (active[0]?.active_transcription_id === input.baseId) {
      // Live → parked under the merged id, every user, every meeting on the
      // recording. Users are the union of both tables (one may have named
      // speakers and edited nothing). An all-empty pair is not parked — the
      // planner would skip it anyway, and it would linger in the archive.
      await tx`
        INSERT INTO ${tx(SCHEMA)}.transcription_annotations
          (transcription_id, transcript_id, user_id, edits, speaker_labels, archived_at)
        SELECT ${input.id}::uuid, m.id, u.user_id,
               e.edits,
               CASE WHEN sm.user_id IS NOT NULL
                    THEN jsonb_build_object('labels', COALESCE(sm.speaker_labels, '[]'::jsonb),
                                            'suggestions', sm.suggestions)
               END,
               now()
        FROM ${tx(SCHEMA)}.transcripts m
        JOIN (SELECT DISTINCT transcript_id FROM ${tx(SCHEMA)}.meeting_clips
               WHERE recording_id = ${input.recordingId}::uuid) c ON c.transcript_id = m.id
        CROSS JOIN LATERAL (
          SELECT user_id FROM ${tx(SCHEMA)}.transcript_edits WHERE assemblyai_id = m.assemblyai_id
          UNION
          SELECT user_id FROM ${tx(SCHEMA)}.speaker_mappings WHERE assemblyai_id = m.assemblyai_id
        ) u
        LEFT JOIN ${tx(SCHEMA)}.transcript_edits e
               ON e.assemblyai_id = m.assemblyai_id AND e.user_id = u.user_id
        LEFT JOIN ${tx(SCHEMA)}.speaker_mappings sm
               ON sm.assemblyai_id = m.assemblyai_id AND sm.user_id = u.user_id
        WHERE (e.edits IS NOT NULL AND e.edits <> '{}'::jsonb) OR sm.user_id IS NOT NULL
        ON CONFLICT (transcription_id, transcript_id, user_id) DO NOTHING
      `;
    } else {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.transcription_annotations
          (transcription_id, transcript_id, user_id, edits, speaker_labels, archived_at)
        SELECT ${input.id}::uuid, a.transcript_id, a.user_id, a.edits, a.speaker_labels, now()
        FROM ${tx(SCHEMA)}.transcription_annotations a
        WHERE a.transcription_id = ${input.baseId}::uuid
        ON CONFLICT (transcription_id, transcript_id, user_id) DO NOTHING
      `;
    }
    return true;
  });
}

/**
 * INTERNAL-ONLY — DEC-4 for a version that was NOT activated (a helper run,
 * or the fill of a merge): its job is on no meeting row, so the meeting-side
 * delete (`deleteAtAaiIfSafe`) never sees it. Stamped on the transcription
 * only after AssemblyAI confirmed.
 */
export async function stampRunProviderDeleted(transcriptionId: string): Promise<void> {
  await sql`
    UPDATE ${sql(SCHEMA)}.recording_transcriptions
    SET provider_deleted_at = now()
    WHERE id = ${transcriptionId}::uuid AND provider_deleted_at IS NULL
  `;
}

// --- Recordings that belong to no meeting (§3c) ----------------------------

/** INTERNAL-ONLY — the canonical stored file of a recording (what a run uploads). */
export async function recordingCanonicalMedia(recordingId: string): Promise<{
  id: string;
  filename: string | null;
  blob_name: string | null;
  sha256: string | null;
  has_video: boolean | null;
} | null> {
  const rows = await sql<
    Array<{ id: string; filename: string | null; blob_name: string | null; sha256: string | null; has_video: boolean | null }>
  >`
    SELECT id, filename, blob_name, sha256, has_video
    FROM ${sql(SCHEMA)}.recording_media
    WHERE recording_id = ${recordingId}::uuid AND kind = 'canonical'
    ORDER BY ord LIMIT 1
  `;
  return rows[0] ?? null;
}

/** INTERNAL-ONLY — does any meeting (live or trashed) hold a clip on it? */
export async function recordingHasMeeting(recordingId: string): Promise<boolean> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT 1 AS n FROM ${sql(SCHEMA)}.meeting_clips
    WHERE recording_id = ${recordingId}::uuid LIMIT 1
  `;
  return rows.length > 0;
}

/** A recording-scoped run in flight. */
export interface RecordingRunRow {
  transcription_id: string;
  recording_id: string;
  owner_user_id: string;
  provider_job_id: string | null;
  requested: (RunRequest & Record<string, unknown>) | null;
  created_at: string;
}

/**
 * INTERNAL-ONLY (gate first) — the recording-scoped run in flight on this
 * recording, if any (with or without a job yet).
 */
export async function recordingRunInFlight(recordingId: string): Promise<RecordingRunRow | null> {
  const rows = await sql<RecordingRunRow[]>`
    SELECT t.id AS transcription_id, t.recording_id, r.owner_user_id, t.provider_job_id,
           t.requested, t.created_at::text AS created_at
    FROM ${sql(SCHEMA)}.recording_transcriptions t
    JOIN ${sql(SCHEMA)}.recordings r ON r.id = t.recording_id
    WHERE t.recording_id = ${recordingId}::uuid
      AND t.status = 'processing' AND t.requested->>'scope' = 'recording'
    ORDER BY t.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * INTERNAL-ONLY — open a run on a recording that belongs to no meeting.
 * Conditional insert: refused (false) when a recording-scoped run is already
 * processing on it, so two clicks in two processes cannot both start a job —
 * the same guarantee `claimRetranscribeMarker` gives a meeting, held by the
 * transcription rows themselves since there is no meeting row to hold it.
 */
export async function insertRecordingRun(input: {
  id: string;
  recordingId: string;
  speechModel: string;
  languageCode: string | null;
  requested: RunRequest;
}): Promise<boolean> {
  return sql.begin(async (tx) => {
    // Serialise starters on the recording row; the NOT EXISTS below is then
    // race-free.
    await tx`SELECT id FROM ${tx(SCHEMA)}.recordings WHERE id = ${input.recordingId}::uuid FOR UPDATE`;
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO ${tx(SCHEMA)}.recording_transcriptions
        (id, recording_id, provider, provider_job_id, speech_model, language_code,
         status, covers, requested)
      SELECT ${input.id}::uuid, ${input.recordingId}::uuid, 'assemblyai', NULL,
             ${input.speechModel}, ${input.languageCode}, 'processing',
             ${tx.json({ media: [], timeline: 'wall' } as never)},
             ${tx.json(input.requested as never)}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${tx(SCHEMA)}.recording_transcriptions
        WHERE recording_id = ${input.recordingId}::uuid
          AND status = 'processing' AND requested->>'scope' = 'recording'
      )
      RETURNING id
    `;
    return rows.length > 0;
  });
}

/**
 * INTERNAL-ONLY — every recording-scoped run AssemblyAI has a job for, oldest
 * first: the sweeper's work list. Found by the `requested.scope` stamp, not
 * by "no meeting clips it": a run started on a bare recording that the owner
 * then makes a meeting of must still be polled to the end (nobody else would
 * — that meeting has no `retranscribing` marker).
 */
export async function listRecordingRunsInFlight(limit: number): Promise<RecordingRunRow[]> {
  return sql<RecordingRunRow[]>`
    SELECT t.id AS transcription_id, t.recording_id, r.owner_user_id, t.provider_job_id,
           t.requested, t.created_at::text AS created_at
    FROM ${sql(SCHEMA)}.recording_transcriptions t
    JOIN ${sql(SCHEMA)}.recordings r ON r.id = t.recording_id
    WHERE t.status = 'processing' AND t.provider_job_id IS NOT NULL
      AND t.requested IS NOT NULL AND t.requested->>'scope' = 'recording'
      AND r.deleted_at IS NULL
    ORDER BY t.created_at
    LIMIT ${limit}
  `;
}

/**
 * INTERNAL-ONLY (gate first) — make `targetId` the version a recording that
 * belongs to NO meeting shows. There are no meeting rows and no annotations
 * to move, so this is the pointer, the `superseded_by` chain (only when the
 * target is newer, as for a meeting) and the facts the recording page reads
 * (duration, speaker count). Refused (false) when the target is not a
 * completed version of this recording, or when a meeting has started
 * holding the recording — a meeting's switch must go through its own route,
 * which moves its annotations.
 */
export async function setRecordingActiveTranscription(
  recordingId: string,
  targetId: string
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rec = await tx<Array<{ active_transcription_id: string | null }>>`
      SELECT active_transcription_id FROM ${tx(SCHEMA)}.recordings
      WHERE id = ${recordingId}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (rec.length === 0) return false;
    const clipped = await tx<Array<{ n: number }>>`
      SELECT 1 AS n FROM ${tx(SCHEMA)}.meeting_clips WHERE recording_id = ${recordingId}::uuid LIMIT 1
    `;
    if (clipped.length > 0) return false;
    const target = await tx<Array<{ created_at: string; secs: number | null; speakers: number | null }>>`
      SELECT created_at::text AS created_at,
             (payload->>'audio_duration')::float8 AS secs,
             (SELECT count(DISTINCT u->>'speaker')::int
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(payload->'utterances') = 'array' THEN payload->'utterances' END
                ) u) AS speakers
      FROM ${tx(SCHEMA)}.recording_transcriptions
      WHERE id = ${targetId}::uuid AND recording_id = ${recordingId}::uuid AND status = 'completed'
    `;
    if (target.length === 0) return false;
    const currentId = rec[0]!.active_transcription_id;
    if (currentId === targetId) return true;

    const t = target[0]!;
    await tx`
      UPDATE ${tx(SCHEMA)}.recordings
      SET active_transcription_id = ${targetId}::uuid,
          duration_ms = COALESCE(${t.secs !== null ? Math.round(t.secs * 1000) : null}::bigint, duration_ms),
          upload_state = CASE WHEN ${t.speakers}::int IS NULL THEN upload_state
                              ELSE COALESCE(upload_state, '{}'::jsonb)
                                   || jsonb_build_object('speakerCount', ${t.speakers}::int) END,
          updated_at = now()
      WHERE id = ${recordingId}::uuid
    `;
    if (currentId) {
      await tx`
        UPDATE ${tx(SCHEMA)}.recording_transcriptions c
        SET superseded_by = ${targetId}::uuid
        WHERE c.id = ${currentId}::uuid
          AND c.created_at < ${t.created_at}::timestamptz
      `;
    }
    // Same "has been live" stamp a meeting's activate writes (the ::text cast
    // is load-bearing — see applyActivatePlan).
    await tx`
      UPDATE ${tx(SCHEMA)}.recording_transcriptions
      SET requested = COALESCE(requested, '{}'::jsonb)
                      || jsonb_build_object('activatedAt', ${new Date().toISOString()}::text)
      WHERE id = ${targetId}::uuid AND requested->>'activatedAt' IS NULL
    `;
    return true;
  });
}
