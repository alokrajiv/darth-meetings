/**
 * Drift check for the first-class-recordings tables — READ ONLY.
 *
 * Recomputes the desired graph for every meeting with the SAME rules the
 * backfill and the app's dual-write use (`src/lib/recording-graph.ts`) and
 * prints every row where the tables disagree. This is what we run on prod
 * after `scripts/recordings-backfill.ts --apply`, and then periodically
 * during the soak week: a writer that was missed shows up here as a meeting
 * whose clip/media/transcription no longer matches its `transcripts` row.
 *
 *   SCHEMA_PREFIX=prod bun run scripts/recordings-verify.ts
 *   SCHEMA_PREFIX=stage bun run scripts/recordings-verify.ts --check-files ./storage
 *   SCHEMA_PREFIX=prod bun run scripts/recordings-verify.ts --only <aai-id> --verbose
 *
 * Without `--check-files` the byte counts and the `audio_only` rows are not
 * judged at all (the script may be run from a laptop that has no storage
 * dir); with it they are. Nothing is ever written: the session is opened
 * `default_transaction_read_only`, so even a bug cannot change a row.
 *
 * Exit code 0 = no drift, 1 = drift found, 2 = refused to run.
 */

import postgres from 'postgres';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import {
  borrowsRecording,
  canonicalKeyOf,
  deriveRecordingGraph,
  desiredClipsFor,
  isJobIdMeeting,
  ownerRowOf,
  recordingFilenames,
  recordingIdFor,
  skipReason,
  type DesiredGraph,
  type GraphFileFacts,
  type GraphMeetingRow,
} from '@/lib/recording-graph';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
function value(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

const ONLY = value('--only');
const CHECK_FILES = value('--check-files');
const VERBOSE = flag('--verbose');
const MAX_LINES = Number(value('--max-lines') ?? 200);

const explicitPrefix = (value('--schema-prefix') || process.env.SCHEMA_PREFIX || '').trim() || null;
if (!explicitPrefix) {
  console.error(
    'refused: set SCHEMA_PREFIX (env or --schema-prefix <name>) so the schema being read is a choice, not a default.'
  );
  process.exit(2);
}
const SCHEMA = `meeting_whisperer_${explicitPrefix}`;

console.log(`[recordings-verify] schema  : ${SCHEMA} (read-only)`);
if (ONLY) console.log(`[recordings-verify] only    : ${ONLY}`);
console.log(
  `[recordings-verify] files   : ${CHECK_FILES ? path.resolve(CHECK_FILES) : 'not probed (bytes + audio_only not judged)'}`
);

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Postgres hands back Date / string / bigint-as-string; normalise to compare. */
function norm(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    // A timestamptz arrives as a Date, but a jsonb string does not — leave it.
    return v;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  }
  return String(v);
}

function tsEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  const x = a instanceof Date ? a.getTime() : Date.parse(String(a));
  const y = b instanceof Date ? b.getTime() : Date.parse(String(b));
  return x === y;
}

interface Problem {
  meeting: string;
  what: string;
}

const problems: Problem[] = [];
function flagDrift(meeting: string, what: string): void {
  problems.push({ meeting, what });
}
function expectEq(meeting: string, label: string, expected: unknown, actual: unknown): void {
  if (norm(expected) !== norm(actual)) {
    flagDrift(meeting, `${label}: expected ${norm(expected)}, found ${norm(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface ActualRecording {
  id: string;
  owner_user_id: string;
  source_kind: string;
  started_at: Date | null;
  duration_ms: string | number | null;
  recorder_recording_id: string | null;
  active_transcription_id: string | null;
  deleted_at: Date | null;
}
interface ActualMedia {
  id: string;
  recording_id: string;
  kind: string;
  ord: number;
  offset_ms: string | number | null;
  duration_ms: string | number | null;
  filename: string | null;
  has_video: boolean | null;
  source_ref: Record<string, unknown> | null;
  of_media_id: string | null;
  // NOT derived from the `transcripts` row and therefore NEVER compared below
  // (DEC-3 Stage A.5): only `src/lib/server/media-archive.ts` writes these,
  // after Azure has confirmed the bytes, and no sync clears them. They are
  // read only for the INFO block at the end of the report.
  blob_name: string | null;
  sha256: string | null;
  /** Only for the INFO block: how long a blob-only row has been blob-only. */
  created_at: Date;
}
interface ActualTranscription {
  id: string;
  recording_id: string;
  provider: string;
  provider_job_id: string | null;
  speech_model: string | null;
  language_code: string | null;
  status: string;
  has_payload: boolean;
  utterances: number | null;
  covers: { media?: string[]; timeline?: string } | null;
  // Phase 2 (migration 046). NULL everywhere until a meeting is
  // re-transcribed, and NULL on a schema where 046 has not been applied —
  // which is why they are selected through `versionCols` below.
  superseded_by: string | null;
  requested: Record<string, unknown> | null;
  annotations: number;
}
interface ActualClip {
  transcript_id: number;
  ord: number;
  recording_id: string;
  transcription_id: string | null;
  from_ms: string | number | null;
  to_ms: string | number | null;
  offset_ms: string | number | null;
  text_policy: string;
}

const sql = postgres({ max: 1, onnotice: () => {} });

function fileFactsFor(row: GraphMeetingRow): GraphFileFacts | undefined {
  if (!CHECK_FILES) return undefined;
  const storage = path.resolve(CHECK_FILES);
  const audio = new Map<string, number | null>();
  const audioOnly = new Map<string, number | null>();
  for (const name of recordingFilenames(row)) {
    const abs = path.join(storage, 'audio', name);
    if (existsSync(abs)) {
      try {
        audio.set(name, statSync(abs).size);
      } catch {
        audio.set(name, null);
      }
    }
    const stem = name.replace(/\.[^./]+$/, '');
    const extract = path.join(storage, 'audio-only', `${stem}.m4a`);
    if (existsSync(extract)) {
      try {
        audioOnly.set(stem, statSync(extract).size);
      } catch {
        audioOnly.set(stem, null);
      }
    }
  }
  return { audio, audioOnly };
}

/**
 * The clips a meeting should have, against the ones it has.
 *
 * Phase 1 expected exactly one, over the whole recording. Phase 3a lets the
 * ROW declare its windows in `gmeet_context.clips` — the mirror that makes a
 * split survive the next dual-write — so the expectation is
 * `desiredClipsFor(row)` and the verifier reads the same thing the writer
 * does. `expectedRecordingId` is null for a meeting that only BORROWS a
 * recording (it was split off another one): its clips name a recording it
 * does not derive, which is the whole point.
 */
function checkClips(
  tag: string,
  row: GraphMeetingRow,
  actual: ActualClip[],
  expectedRecordingId: string | null
): boolean {
  const want = desiredClipsFor(row);
  if (actual.length === 0) {
    flagDrift(tag, 'no clip (the meeting is invisible to the resolver)');
    return false;
  }
  if (actual.length !== want.length) {
    flagDrift(tag, `${actual.length} clips, the row declares ${want.length}`);
  }
  let ok = true;
  for (const w of want) {
    const clip = actual.find((c) => c.ord === w.ord);
    if (!clip) {
      flagDrift(tag, `no clip at ord ${w.ord}`);
      ok = false;
      continue;
    }
    expectEq(tag, `clip[${w.ord}].recording_id`, w.recordingId ?? expectedRecordingId, clip.recording_id);
    expectEq(tag, `clip[${w.ord}].transcription_id`, w.transcriptionId, clip.transcription_id);
    expectEq(tag, `clip[${w.ord}].from_ms`, w.fromMs, clip.from_ms);
    expectEq(tag, `clip[${w.ord}].to_ms`, w.toMs, clip.to_ms);
    expectEq(tag, `clip[${w.ord}].offset_ms`, w.offsetMs, clip.offset_ms);
    expectEq(tag, `clip[${w.ord}].text_policy`, w.textPolicy, clip.text_policy);
  }
  return ok;
}

/** Kinds this run is entitled to judge. */
const judgedKinds = (graph: DesiredGraph) =>
  graph.filesProbed ? new Set(['canonical', 'part', 'audio_only', 'faststart']) : new Set(['canonical', 'part']);

async function main() {
  await sql.unsafe('SET default_transaction_read_only = on');

  // Tolerate a schema where migration 045 (`aai_job_id`) has not been applied:
  // the job is then the meeting id, which is what every pre-1b row looks like.
  const hasJobIdColumn =
    (
      await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = 'transcripts'
          AND column_name = 'aai_job_id'
      `
    ).length > 0;
  const jobIdCol = hasJobIdColumn ? sql`t.aai_job_id` : sql`NULL::text AS aai_job_id`;

  // Same tolerance for migration 046 (transcription versions, Phase 2): on a
  // schema without it there are no versions to report and the two columns do
  // not exist, so selecting them would be a parse error rather than a finding.
  const has046 =
    (
      await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = 'recording_transcriptions'
          AND column_name = 'requested'
      `
    ).length > 0;
  const versionCols = has046
    ? sql`requested,
          (SELECT count(*)::int FROM ${sql(SCHEMA)}.transcription_annotations a
            WHERE a.transcription_id = recording_transcriptions.id) AS annotations`
    : sql`NULL::jsonb AS requested, 0 AS annotations`;

  const rows = await sql<GraphMeetingRow[]>`
    SELECT t.id, t.user_id, t.assemblyai_id, ${jobIdCol}, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.language_code,
           t.speech_model, t.local_audio_path, t.deleted_at, t.gmeet_context,
           (t.imported_content IS NOT NULL) AS has_content,
           CASE WHEN jsonb_typeof(t.imported_content->'utterances') = 'array'
                THEN jsonb_array_length(t.imported_content->'utterances') END AS row_utterances,
           rr.id         AS recorder_recording_id,
           rr.started_at AS recorder_started_at
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN LATERAL (
      SELECT r.id, r.started_at
      FROM ${sql(SCHEMA)}.recorder_recordings r
      WHERE r.transcript_id = t.assemblyai_id
         OR (t.gmeet_context->'recorder'->>'recordingId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             AND r.id::text = t.gmeet_context->'recorder'->>'recordingId')
      ORDER BY (r.transcript_id = t.assemblyai_id) DESC, r.created_at
      LIMIT 1
    ) rr ON true
    ${ONLY ? sql`WHERE t.assemblyai_id = ${ONLY}` : sql``}
    ORDER BY t.created_at, t.id
  `;

  const [recordings, media, transcriptions, clips] = await Promise.all([
    sql<ActualRecording[]>`
      SELECT id, owner_user_id, source_kind, started_at, duration_ms::float8 AS duration_ms,
             recorder_recording_id, active_transcription_id, deleted_at
      FROM ${sql(SCHEMA)}.recordings
    `,
    sql<ActualMedia[]>`
      SELECT id, recording_id, kind, ord, offset_ms::float8 AS offset_ms,
             duration_ms::float8 AS duration_ms, filename, has_video, source_ref, of_media_id,
             blob_name, sha256, created_at
      FROM ${sql(SCHEMA)}.recording_media
    `,
    sql<ActualTranscription[]>`
      SELECT id, recording_id, provider, provider_job_id, speech_model, language_code, status,
             (payload IS NOT NULL) AS has_payload,
             CASE WHEN jsonb_typeof(payload->'utterances') = 'array'
                  THEN jsonb_array_length(payload->'utterances') END AS utterances,
             covers, superseded_by, ${versionCols}
      FROM ${sql(SCHEMA)}.recording_transcriptions
    `,
    sql<ActualClip[]>`
      SELECT transcript_id, ord, recording_id, transcription_id,
             from_ms::float8 AS from_ms, to_ms::float8 AS to_ms,
             offset_ms::float8 AS offset_ms, text_policy
      FROM ${sql(SCHEMA)}.meeting_clips
    `,
  ]);

  const recById = new Map(recordings.map((r) => [r.id, r]));
  const txnById = new Map(transcriptions.map((t) => [t.id, t]));
  const mediaByRecording = new Map<string, ActualMedia[]>();
  for (const m of media) {
    mediaByRecording.set(m.recording_id, [...(mediaByRecording.get(m.recording_id) ?? []), m]);
  }
  const clipsByMeeting = new Map<number, ActualClip[]>();
  for (const c of clips) {
    clipsByMeeting.set(c.transcript_id, [...(clipsByMeeting.get(c.transcript_id) ?? []), c]);
  }

  const byAaiId = new Map<string, GraphMeetingRow[]>();
  for (const row of rows) {
    if (!isJobIdMeeting(row) || skipReason(row)) continue;
    byAaiId.set(row.assemblyai_id, [...(byAaiId.get(row.assemblyai_id) ?? []), row]);
  }

  let checked = 0;
  let skippedRows = 0;
  /** Meetings split off another one — clips only, by design (Phase 3a). */
  let borrowed = 0;
  const liveMeetingIds = new Set(rows.map((r) => r.id));
  const expectedRecordingIds = new Set<string>();

  for (const row of rows) {
    const tag = `${row.assemblyai_id} (#${row.id})`;
    const why = skipReason(row);
    const mine = clipsByMeeting.get(row.id) ?? [];
    if (why) {
      skippedRows += 1;
      // A skipped placeholder must own nothing: if it does, a writer created
      // a graph the backfill would never have made.
      if (mine.length > 0) flagDrift(tag, `skipped row (${why}) has ${mine.length} clip(s)`);
      continue;
    }
    checked += 1;

    // ---- a meeting that only BORROWS a recording (Phase 3a) -------------
    // It was split off another meeting: its own row would derive a recording
    // of its own, but the bytes, the media and the transcription belong to
    // the SOURCE. Judge its clips against the mirror on its row and stop —
    // there is deliberately no recording, no media and no transcription of
    // its own to compare, and its id must not be expected either.
    if (borrowsRecording(row)) {
      borrowed += 1;
      checkClips(tag, row, mine, null);
      continue;
    }

    const group = byAaiId.get(row.assemblyai_id) ?? [row];
    const owner = ownerRowOf(group) ?? row;
    // Phase 2: a meeting that has been re-transcribed reads a version whose
    // id was minted, so the expected transcription is the recording's ACTIVE
    // one, not the derived `txn:<rec>:0`. Exactly the input the app's
    // dual-write passes (lib/recording-graph.ts `GraphTableFacts`) — with it
    // the two agree by construction.
    const derivedRecordingId = recordingIdFor(canonicalKeyOf(owner));
    const liveActive = recById.get(derivedRecordingId)?.active_transcription_id ?? null;
    const graph = deriveRecordingGraph(owner, fileFactsFor(owner), {
      activeTranscriptionId: txnById.has(liveActive ?? '') ? liveActive : null,
    });
    expectedRecordingIds.add(graph.recording.id);

    // ---- the clips ----------------------------------------------------
    if (!checkClips(tag, row, mine, graph.recording.id)) continue;

    // Only the OWNER's row decides the recording; a second importer's row
    // would compare the same values twice and report every drift twice.
    if (owner.id !== row.id) continue;

    // ---- the recording ------------------------------------------------
    const rec = recById.get(graph.recording.id);
    if (!rec) {
      flagDrift(tag, `recording ${graph.recording.id} missing`);
      continue;
    }
    expectEq(tag, 'recording.owner_user_id', graph.recording.ownerUserId, rec.owner_user_id);
    expectEq(tag, 'recording.source_kind', graph.recording.sourceKind, rec.source_kind);
    if (!tsEqual(graph.recording.startedAt, rec.started_at)) {
      flagDrift(
        tag,
        `recording.started_at: expected ${norm(graph.recording.startedAt)}, found ${norm(rec.started_at)}`
      );
    }
    // A clipped row cannot vouch for the recording's length (its own duration
    // is the window's), so the graph leaves `durationMs` null and the stored
    // value — written when the row still described the whole recording — is
    // not drift.
    if (graph.wholeRecording) {
      expectEq(tag, 'recording.duration_ms', graph.recording.durationMs, rec.duration_ms);
    }
    expectEq(
      tag,
      'recording.recorder_recording_id',
      graph.recording.recorderRecordingId,
      rec.recorder_recording_id
    );
    expectEq(
      tag,
      'recording.active_transcription_id',
      graph.transcription.id,
      rec.active_transcription_id
    );
    if (rec.deleted_at && !row.deleted_at) {
      flagDrift(tag, 'recording is soft-deleted but its meeting is live');
    }

    // ---- the files ----------------------------------------------------
    const kinds = judgedKinds(graph);
    const actualMedia = (mediaByRecording.get(graph.recording.id) ?? []).filter((m) =>
      kinds.has(m.kind)
    );
    const wantMedia = new Map(graph.media.filter((m) => kinds.has(m.kind)).map((m) => [m.id, m]));
    for (const m of actualMedia) {
      if (!wantMedia.has(m.id)) {
        flagDrift(tag, `media ${m.kind}#${m.ord} ${m.id} is not derivable from the row`);
      }
    }
    for (const [id, m] of wantMedia) {
      const actual = actualMedia.find((a) => a.id === id);
      if (!actual) {
        flagDrift(tag, `media ${m.kind}#${m.ord} (${m.filename ?? 'no file'}) missing`);
        continue;
      }
      const label = `media ${m.kind}#${m.ord}`;
      expectEq(tag, `${label}.kind`, m.kind, actual.kind);
      expectEq(tag, `${label}.ord`, m.ord, actual.ord);
      expectEq(tag, `${label}.offset_ms`, m.offsetMs, actual.offset_ms);
      // Same reason as `recording.duration_ms` above: a clipped row's own
      // duration is its window's, so the graph sends NULL, the upsert
      // COALESCEs and the stored value is not drift.
      if (graph.wholeRecording) {
        expectEq(tag, `${label}.duration_ms`, m.durationMs, actual.duration_ms);
      }
      expectEq(tag, `${label}.filename`, m.filename, actual.filename);
      expectEq(tag, `${label}.has_video`, m.hasVideo, actual.has_video);
      expectEq(tag, `${label}.source_ref`, m.sourceRef, actual.source_ref);
      expectEq(tag, `${label}.of_media_id`, m.ofMediaId, actual.of_media_id);
    }

    // ---- the transcription --------------------------------------------
    const txn = txnById.get(graph.transcription.id);
    if (!txn) {
      flagDrift(tag, `transcription ${graph.transcription.id} missing`);
      continue;
    }
    expectEq(tag, 'transcription.recording_id', graph.recording.id, txn.recording_id);
    expectEq(tag, 'transcription.provider', graph.transcription.provider, txn.provider);
    expectEq(
      tag,
      'transcription.provider_job_id',
      graph.transcription.providerJobId,
      txn.provider_job_id
    );
    expectEq(tag, 'transcription.status', graph.transcription.status, txn.status);
    expectEq(tag, 'transcription.speech_model', graph.transcription.speechModel, txn.speech_model);
    expectEq(tag, 'transcription.language_code', graph.transcription.languageCode, txn.language_code);
    expectEq(tag, 'transcription.covers', graph.transcription.covers, txn.covers);
    // A CLIPPED meeting's `imported_content` is the materialised window, not
    // the transcription's payload, so neither the presence nor the utterance
    // count may be compared (`deriveRecordingGraph` refuses to copy it for
    // the same reason — docs/recordings-phase3-clips-spec.md "Model").
    if (!graph.wholeRecording) continue;
    if (owner.has_content !== txn.has_payload) {
      flagDrift(
        tag,
        `transcription.payload: row ${owner.has_content ? 'has' : 'has no'} imported_content, transcription ${txn.has_payload ? 'has' : 'has no'} payload`
      );
    }
    const rowUtterances = (owner as GraphMeetingRow & { row_utterances?: number | null })
      .row_utterances;
    if (owner.has_content && (rowUtterances ?? null) !== (txn.utterances ?? null)) {
      flagDrift(
        tag,
        `transcription.payload utterances: row ${rowUtterances ?? '∅'}, transcription ${txn.utterances ?? '∅'}`
      );
    }
  }

  // ---- orphans (only meaningful over the whole schema) ------------------
  if (!ONLY) {
    for (const c of clips) {
      if (!liveMeetingIds.has(c.transcript_id)) {
        flagDrift(`clip #${c.transcript_id}`, 'clip points at a transcripts row that is gone');
      }
      if (!recById.has(c.recording_id)) {
        flagDrift(`clip #${c.transcript_id}`, `clip points at missing recording ${c.recording_id}`);
      }
    }
    const clipped = new Set(clips.map((c) => c.recording_id));
    for (const r of recordings) {
      if (!clipped.has(r.id)) {
        flagDrift(`recording ${r.id}`, 'no meeting clips this recording (orphan)');
      } else if (!expectedRecordingIds.has(r.id)) {
        flagDrift(`recording ${r.id}`, 'clipped, but no row derives this id');
      }
    }
    for (const m of media) {
      if (!recById.has(m.recording_id)) {
        flagDrift(`media ${m.id}`, `belongs to missing recording ${m.recording_id}`);
      }
    }
    for (const t of transcriptions) {
      if (!recById.has(t.recording_id)) {
        flagDrift(`transcription ${t.id}`, `belongs to missing recording ${t.recording_id}`);
      }
    }
  }

  // ---- INFO: transcription versions (Phase 2) ---------------------------
  // A recording may hold SEVERAL transcriptions: the one its meeting reads
  // plus every other version a re-run produced. Those extras are not
  // derivable from the `transcripts` row and must never be reported as drift
  // — nothing above compares them, and `applyRecordingGraph` refuses to
  // delete them. They are counted here instead, as INFO.
  const versionInfos: string[] = [];
  {
    const byRecording = new Map<string, ActualTranscription[]>();
    for (const t of transcriptions) {
      byRecording.set(t.recording_id, [...(byRecording.get(t.recording_id) ?? []), t]);
    }
    const versioned = [...byRecording.values()].filter((list) => list.length > 1);
    const extras = versioned.reduce((n, list) => n + list.length - 1, 0);
    versionInfos.push(`recordings with >1 transcription: ${versioned.length} (${extras} extra version(s))`);
    versionInfos.push(`  superseded                     : ${transcriptions.filter((t) => t.superseded_by).length}`);
    versionInfos.push(`  requested by a person          : ${transcriptions.filter((t) => t.requested).length}`);
    versionInfos.push(`  runs still processing          : ${transcriptions.filter((t) => t.status === 'processing' && t.requested).length}`);
    versionInfos.push(`  failed runs                    : ${transcriptions.filter((t) => t.status === 'error' && t.requested).length}`);
    versionInfos.push(`annotation sets parked           : ${transcriptions.reduce((n, t) => n + t.annotations, 0)}`);
    if (!has046) versionInfos.push('  (migration 046 not applied on this schema)');
  }

  // ---- INFO: the media archive (DEC-3 Stage A) --------------------------
  // `blob_name` / `sha256` are NOT derivable from a `transcripts` row, so a
  // disagreement between them and the row is not drift and must never be a
  // finding — nothing above compares them. They are still worth SEEING, so
  // the two states that matter are counted here and printed as INFO: the
  // exit code is unaffected.
  const infos: string[] = [];
  {
    const archived = media.filter((m) => m.blob_name);
    const unarchived = media.filter((m) => m.filename && !m.blob_name);
    infos.push(`media archived (blob_name set) : ${archived.length}`);
    infos.push(`media with a file, no blob yet : ${unarchived.length}`);
    infos.push(`media naming no file at all    : ${media.filter((m) => !m.filename).length}`);
    if (CHECK_FILES) {
      const storage = path.resolve(CHECK_FILES);
      // `audio_only` extracts live in a dir of their own; everything else is
      // directly under `audio/` (see lib/server/audio-only.ts).
      const localOf = (m: ActualMedia) =>
        m.filename
          ? path.join(storage, m.kind === 'audio_only' ? 'audio-only' : 'audio', m.filename)
          : null;
      const lostLocal = archived.filter((m) => {
        const p = localOf(m);
        return p ? !existsSync(p) : false;
      });
      const waiting = unarchived.filter((m) => {
        const p = localOf(m);
        return p ? existsSync(p) : false;
      });
      // Blob-before-local is Stage C's NORMAL state for the first minutes of
      // a recording's life (`MW_AAI_FROM_BLOB`: AssemblyAI reads the blob and
      // the VM fetches its copy afterwards), and Stage D's normal state for
      // ever after. Neither is drift; the age is what tells them apart.
      const fresh = lostLocal.filter(
        (m) => Date.now() - m.created_at.getTime() < 24 * 3600_000
      );
      infos.push(
        `  archived, local file gone    : ${lostLocal.length}  (blob-only: ${fresh.length} newer than 24 h` +
          ` — Stage C's fetch may still be in flight; the rest is expected once Stage D drains storage/)`
      );
      infos.push(
        `  local file present, no blob  : ${waiting.length}  (what the backfill still has to copy)`
      );
    }
    // Migration 047 may not be applied on this schema yet.
    const pending = await sql<Array<{ n: number; oldest: Date | null }>>`
      SELECT count(*)::int AS n, min(queued_at) AS oldest
      FROM ${sql(SCHEMA)}.media_blob_deletes
    `.catch(() => null);
    if (pending) {
      infos.push(
        `blobs queued for delete        : ${pending[0]?.n ?? 0}` +
          (pending[0]?.oldest ? ` (oldest ${norm(pending[0].oldest)})` : '')
      );
    }
  }

  // ---- report -----------------------------------------------------------
  const byMeeting = new Map<string, string[]>();
  for (const p of problems) {
    byMeeting.set(p.meeting, [...(byMeeting.get(p.meeting) ?? []), p.what]);
  }

  console.log('');
  console.log('─── recordings drift report ─────────────────────────────────');
  console.log(`schema                 : ${SCHEMA}`);
  console.log(`meetings scanned       : ${rows.length}`);
  console.log(`  checked              : ${checked}`);
  console.log(`  skipped (placeholder): ${skippedRows}`);
  console.log(`  split off another    : ${borrowed}  (clips only, by design)`);
  console.log(`recordings in table    : ${recordings.length}`);
  console.log(`media rows             : ${media.length}`);
  console.log(`transcriptions         : ${transcriptions.length}`);
  console.log(`clips                  : ${clips.length}`);
  console.log('');
  console.log('transcription versions (INFO, never drift)');
  for (const line of versionInfos) console.log(`  ${line}`);
  console.log('');
  console.log('media archive (INFO, never drift)');
  for (const line of infos) console.log(`  ${line}`);
  console.log('');
  console.log(`rows with drift        : ${byMeeting.size}`);
  console.log(`findings               : ${problems.length}`);
  let printed = 0;
  for (const [meeting, whats] of byMeeting) {
    for (const what of VERBOSE ? whats : whats.slice(0, 3)) {
      if (printed++ >= MAX_LINES) break;
      console.log(`  ${meeting}  ${what}`);
    }
    if (!VERBOSE && whats.length > 3) console.log(`  ${meeting}  … and ${whats.length - 3} more`);
    if (printed >= MAX_LINES) {
      console.log(`  … output capped at ${MAX_LINES} lines (pass --max-lines N)`);
      break;
    }
  }
  console.log('─────────────────────────────────────────────────────────────');

  await sql.end();
  process.exit(problems.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[recordings-verify] failed:', err);
  await sql.end();
  process.exit(2);
});
