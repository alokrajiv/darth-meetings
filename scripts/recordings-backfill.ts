/**
 * Backfill `transcripts` → recordings / recording_media /
 * recording_transcriptions / meeting_clips (docs/recordings-phase1-spec.md §2).
 *
 * Every live meeting becomes ONE recording with ONE transcription and ONE
 * clip `(ord 0, from 0, to NULL, offset 0, include)` — the 1:1 case the
 * resolver serves in compat mode, so nothing a user can see changes.
 *
 *   bun run scripts/recordings-backfill.ts                    # dry run, no writes
 *   bun run scripts/recordings-backfill.ts --only <aai-id>    # one meeting
 *   bun run scripts/recordings-backfill.ts --check-files ./storage
 *   SCHEMA_PREFIX=stage bun run scripts/recordings-backfill.ts --apply
 *
 * Dry run is the default and touches NOTHING: it opens the session
 * `default_transaction_read_only`, reads only `transcripts` and
 * `recorder_recordings`, and therefore works BEFORE migration 044 is applied.
 *
 * `--apply` refuses to run unless SCHEMA_PREFIX was given explicitly (on the
 * command line or in the environment) — the app defaults it to `prod`, and a
 * backfill that silently inherits that default is exactly the accident spec
 * §5.1 forbids. Writing to a `_prod` schema additionally needs
 * `--i-know-this-is-prod`.
 *
 * Idempotent: every id is a uuidv5 of what the row IS, so a re-run converges
 * and two meetings holding the same AssemblyAI job (two people imported the
 * same Meet call — landmine #14) collapse onto ONE recording with two clips.
 * One transaction per meeting, so an interrupted run resumes where it stopped.
 *
 * The derivation rules live in `src/lib/recording-graph.ts`, shared with the
 * app's dual-write (`src/lib/server/recording-sync.ts`) — one set of rules,
 * or the backfill and the running app would fight over the same rows.
 *
 * The payload is copied INSIDE Postgres (`INSERT … SELECT imported_content`):
 * ~0.5 GB of jsonb must never round-trip through JS.
 */

import postgres from 'postgres';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import {
  canonicalKeyOf,
  deriveRecordingGraph,
  desiredClipFor,
  isRealAaiId,
  ownerRowOf,
  skipReason,
  recordingFilenames,
  type DesiredGraph,
  type GraphFileFacts,
  type GraphMeetingRow,
} from '@/lib/recording-graph';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(name);
}
function value(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

const APPLY = flag('--apply');
const ONLY = value('--only');
const CHECK_FILES = value('--check-files');
const PROD_OK = flag('--i-know-this-is-prod');
const PREFIX_ARG = value('--schema-prefix');

const explicitPrefix = (PREFIX_ARG || process.env.SCHEMA_PREFIX || '').trim() || null;
const PREFIX = explicitPrefix ?? 'prod';
const SCHEMA = `meeting_whisperer_${PREFIX}`;

if (APPLY && !explicitPrefix) {
  console.error(
    '--apply refused: set SCHEMA_PREFIX (env or --schema-prefix <name>) so the target schema is a choice, not a default.'
  );
  process.exit(2);
}
if (APPLY && PREFIX === 'prod' && !PROD_OK) {
  console.error(`--apply refused: ${SCHEMA} is production. Re-run with --i-know-this-is-prod.`);
  process.exit(2);
}

console.log(`[recordings-backfill] schema   : ${SCHEMA}`);
console.log(`[recordings-backfill] mode     : ${APPLY ? 'APPLY (writes)' : 'dry run (read-only)'}`);
if (ONLY) console.log(`[recordings-backfill] only     : ${ONLY}`);
if (CHECK_FILES) console.log(`[recordings-backfill] storage  : ${path.resolve(CHECK_FILES)}`);

// ---------------------------------------------------------------------------
// The plan for one meeting
// ---------------------------------------------------------------------------

interface MeetingPlan {
  row: GraphMeetingRow;
  graph: DesiredGraph;
  /** False = another meeting already owns this recording; only a clip is written. */
  owns: boolean;
  /** local_audio_path that is NOT on disk (only filled with --check-files). */
  missingFile: string | null;
}

/**
 * What is on disk under `--check-files <storageDir>`. Without it the graph
 * carries no byte counts and no `audio_only` rows — the same "not probed"
 * answer `scripts/recordings-verify.ts` gives by default, so the two agree.
 */
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

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// max: 1 so the session-level read-only guard below covers every statement.
const sql = postgres({ max: 1, onnotice: () => {} });

async function main() {
  if (!APPLY) await sql.unsafe('SET default_transaction_read_only = on');

  // The recorder join mirrors db-ops/recordings.ts `loadGraphMeetingRows`:
  // the reverse link first, the `gmeet_context.recorder` marker second, and
  // `started_at` comes along for §5a's fallback anchor.
  const rows = await sql<GraphMeetingRow[]>`
    SELECT t.id, t.user_id, t.assemblyai_id, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.language_code,
           t.speech_model, t.local_audio_path, t.deleted_at, t.gmeet_context,
           (t.imported_content IS NOT NULL) AS has_content,
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

  const skipped: Array<{ id: string; why: string }> = [];
  const kept: GraphMeetingRow[] = [];
  for (const row of rows) {
    const why = skipReason(row);
    if (why) skipped.push({ id: row.assemblyai_id, why });
    else kept.push(row);
  }

  // Meetings that must collapse onto ONE recording: only a REAL AssemblyAI
  // job is shared (a `gmeet-<record>` id is the same string for every
  // importer but each parsed their own copy — `canonicalKeyOf` keys those on
  // transcripts.id).
  const byAaiId = new Map<string, GraphMeetingRow[]>();
  for (const row of kept) {
    if (!isRealAaiId(row.assemblyai_id)) continue;
    byAaiId.set(row.assemblyai_id, [...(byAaiId.get(row.assemblyai_id) ?? []), row]);
  }

  const plans: MeetingPlan[] = [];
  const owners = new Set<string>();
  const groupMembers = new Map<string, string[]>();

  for (const row of kept) {
    const group = byAaiId.get(row.assemblyai_id) ?? [row];
    const owner = ownerRowOf(group) ?? row;
    const key = canonicalKeyOf(owner);
    groupMembers.set(key, [...(groupMembers.get(key) ?? []), row.assemblyai_id]);
    const owns = !owners.has(key);
    owners.add(key);
    plans.push({
      row,
      graph: deriveRecordingGraph(owner, fileFactsFor(owner)),
      owns,
      missingFile:
        CHECK_FILES && row.local_audio_path && !existsSync(path.join(path.resolve(CHECK_FILES), 'audio', row.local_audio_path))
          ? row.local_audio_path
          : null,
    });
  }

  if (APPLY) {
    console.log(`[recordings-backfill] writing ${plans.length} meetings into ${SCHEMA} …`);
    let done = 0;
    for (const plan of plans) {
      await writePlan(plan);
      if (++done % 50 === 0) console.log(`  … ${done}/${plans.length}`);
    }
  }

  report(rows.length, plans, skipped, groupMembers);
  await sql.end();
}

/**
 * One transaction per meeting: an interrupted run resumes cleanly. The
 * statements are the ones `applyRecordingGraph` runs in the app; they are
 * repeated here rather than imported because the script targets an arbitrary
 * schema through its own connection, while db-ops is bound to the app's.
 */
async function writePlan(plan: MeetingPlan) {
  const { graph } = plan;
  const rec = graph.recording;
  await sql.begin(async (tx) => {
    if (plan.owns) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.recordings
          (id, owner_user_id, source_kind, started_at, duration_ms, recorder_recording_id)
        VALUES (${rec.id}::uuid, ${rec.ownerUserId}, ${rec.sourceKind},
                ${rec.startedAt}, ${rec.durationMs}, ${rec.recorderRecordingId}::uuid)
        ON CONFLICT (id) DO UPDATE SET
          source_kind           = EXCLUDED.source_kind,
          started_at            = COALESCE(EXCLUDED.started_at, recordings.started_at),
          duration_ms           = COALESCE(EXCLUDED.duration_ms, recordings.duration_ms),
          recorder_recording_id = COALESCE(EXCLUDED.recorder_recording_id,
                                           recordings.recorder_recording_id),
          updated_at            = now()
      `;

      for (const m of graph.media) {
        await tx`
          INSERT INTO ${tx(SCHEMA)}.recording_media
            (id, recording_id, kind, ord, offset_ms, duration_ms, filename, bytes,
             has_video, source_ref, of_media_id)
          VALUES (${m.id}::uuid, ${rec.id}::uuid, ${m.kind}, ${m.ord},
                  ${m.offsetMs}, ${m.durationMs}, ${m.filename}, ${m.bytes},
                  ${m.hasVideo}, ${m.sourceRef ? tx.json(m.sourceRef as never) : null},
                  ${m.ofMediaId}::uuid)
          ON CONFLICT (id) DO UPDATE SET
            kind        = EXCLUDED.kind,
            ord         = EXCLUDED.ord,
            offset_ms   = COALESCE(EXCLUDED.offset_ms, recording_media.offset_ms),
            duration_ms = COALESCE(EXCLUDED.duration_ms, recording_media.duration_ms),
            filename    = COALESCE(EXCLUDED.filename, recording_media.filename),
            bytes       = COALESCE(EXCLUDED.bytes, recording_media.bytes),
            has_video   = COALESCE(EXCLUDED.has_video, recording_media.has_video),
            source_ref  = COALESCE(EXCLUDED.source_ref, recording_media.source_ref),
            of_media_id = COALESCE(EXCLUDED.of_media_id, recording_media.of_media_id)
        `;
      }

      // The payload never leaves Postgres.
      const t = graph.transcription;
      await tx`
        INSERT INTO ${tx(SCHEMA)}.recording_transcriptions
          (id, recording_id, provider, provider_job_id, speech_model, language_code,
           status, payload, covers, created_at, completed_at)
        SELECT ${t.id}::uuid, ${rec.id}::uuid, ${t.provider}, ${t.providerJobId},
               ${t.speechModel}, ${t.languageCode}, ${t.status},
               src.imported_content, ${tx.json(t.covers as never)},
               src.created_at, src.completed_at
        FROM ${tx(SCHEMA)}.transcripts src
        WHERE src.id = ${graph.payloadFromTranscriptId}
        ON CONFLICT (id) DO UPDATE SET
          status          = EXCLUDED.status,
          provider_job_id = COALESCE(EXCLUDED.provider_job_id,
                                     recording_transcriptions.provider_job_id),
          payload         = COALESCE(EXCLUDED.payload, recording_transcriptions.payload),
          covers          = EXCLUDED.covers,
          completed_at    = COALESCE(EXCLUDED.completed_at,
                                     recording_transcriptions.completed_at)
      `;

      await tx`
        UPDATE ${tx(SCHEMA)}.recordings
        SET active_transcription_id = ${t.id}::uuid, updated_at = now()
        WHERE id = ${rec.id}::uuid
      `;
    }

    const clip = desiredClipFor(plan.row.id);
    await tx`
      INSERT INTO ${tx(SCHEMA)}.meeting_clips
        (transcript_id, ord, recording_id, transcription_id, from_ms, to_ms,
         offset_ms, text_policy, created_by)
      VALUES (${clip.transcriptId}, ${clip.ord}, ${rec.id}::uuid,
              ${clip.transcriptionId}::uuid, ${clip.fromMs}, ${clip.toMs},
              ${clip.offsetMs}, ${clip.textPolicy}, 'recordings-backfill')
      ON CONFLICT (transcript_id, ord) DO UPDATE SET
        recording_id = EXCLUDED.recording_id,
        from_ms      = EXCLUDED.from_ms,
        to_ms        = EXCLUDED.to_ms,
        offset_ms    = EXCLUDED.offset_ms,
        text_policy  = EXCLUDED.text_policy
    `;
  });
}

function report(
  scanned: number,
  plans: MeetingPlan[],
  skipped: Array<{ id: string; why: string }>,
  groupMembers: Map<string, string[]>
) {
  const bySource = new Map<string, number>();
  for (const p of plans) {
    const kind = p.graph.recording.sourceKind;
    bySource.set(kind, (bySource.get(kind) ?? 0) + 1);
  }

  const shared = [...groupMembers.entries()].filter(([, ids]) => ids.length > 1);
  const missing = plans.filter((p) => p.missingFile);
  const mediaRows = plans.filter((p) => p.owns).reduce((n, p) => n + p.graph.media.length, 0);
  const multiPart = plans.filter((p) => p.owns && p.graph.media.some((m) => m.kind === 'part'));
  const noPayload = plans.filter((p) => p.owns && !p.row.has_content);

  console.log('');
  console.log('─── recordings backfill report ──────────────────────────────');
  console.log(`schema                 : ${SCHEMA}  (${APPLY ? 'APPLIED' : 'dry run'})`);
  console.log(`transcripts scanned    : ${scanned}`);
  console.log(`meetings planned       : ${plans.length}`);
  console.log(`  recordings (owners)  : ${plans.filter((p) => p.owns).length}`);
  console.log(`  clips                : ${plans.length}`);
  console.log(`  transcriptions       : ${plans.filter((p) => p.owns).length}`);
  console.log(`  media rows           : ${mediaRows}`);
  console.log('');
  console.log('by source_kind:');
  for (const [kind, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(12)} ${n}`);
  }
  console.log('');
  console.log(`shared recordings      : ${shared.length} AssemblyAI jobs held by >1 meeting`);
  for (const [key, ids] of shared.slice(0, 25)) {
    console.log(`  ${key}  ← ${ids.length} meetings`);
  }
  if (shared.length > 25) console.log(`  … and ${shared.length - 25} more`);
  console.log('');
  console.log(`meetings with parts    : ${multiPart.length}`);
  console.log(`owners with no payload : ${noPayload.length}`);
  console.log('');
  console.log(`skipped                : ${skipped.length}`);
  const byWhy = new Map<string, number>();
  for (const s of skipped) byWhy.set(s.why, (byWhy.get(s.why) ?? 0) + 1);
  for (const [why, n] of byWhy) console.log(`  ${n}× ${why}`);
  for (const s of skipped.slice(0, 20)) console.log(`  - ${s.id}`);
  console.log('');
  if (CHECK_FILES) {
    console.log(`local_audio_path missing on disk : ${missing.length}`);
    for (const p of missing.slice(0, 40)) {
      console.log(`  ${p.row.assemblyai_id}  ${p.missingFile}`);
    }
  } else {
    console.log('local_audio_path on disk         : not checked (pass --check-files <storageDir>)');
  }
  console.log('─────────────────────────────────────────────────────────────');
}

main().catch(async (err) => {
  console.error('[recordings-backfill] failed:', err);
  await sql.end();
  process.exit(1);
});
