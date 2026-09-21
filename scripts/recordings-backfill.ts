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
 * The payload is copied INSIDE Postgres (`INSERT … SELECT imported_content`):
 * ~0.5 GB of jsonb must never round-trip through JS.
 */

import postgres from 'postgres';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { GmeetContext } from '@/lib/format';
import { videoPartOffsets } from '@/lib/part-offsets';

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
// Deterministic ids
// ---------------------------------------------------------------------------

/** uuidv5(DNS, 'recordings.meetings.darth-internal.trames.io') — the namespace
 * every id below hangs off, so the ids are reproducible from this file alone. */
const NAMESPACE = '914c7e92-21a5-5ff9-a8f3-6288554ba588';

function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const recordingIdFor = (canonicalKey: string) => uuidv5(NAMESPACE, `rec:${canonicalKey}`);
const mediaIdFor = (recordingId: string, kind: string, ord: number) =>
  uuidv5(NAMESPACE, `media:${recordingId}:${kind}:${ord}`);
const transcriptionIdFor = (recordingId: string) => uuidv5(NAMESPACE, `txn:${recordingId}:0`);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  user_id: string;
  assemblyai_id: string;
  original_filename: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  duration: number | null;
  language_code: string | null;
  speech_model: string | null;
  local_audio_path: string | null;
  deleted_at: string | null;
  gmeet_context: GmeetContext | null;
  has_content: boolean;
}

const AAI_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNTHETIC = /^(gmeet-|teams-|ext-|up-|defer-)/;
const isRealAaiId = (id: string) => AAI_ID.test(id) && !SYNTHETIC.test(id);

type SourceKind = 'recorder' | 'upload' | 'meet' | 'teams' | 'text' | 'aai-import';

/**
 * Where the bytes came from. Two additions to the spec's prefix-first rule,
 * both because the prefix alone under-reports on prod:
 *  - `recorder` is decided by the marker OR the reverse link
 *    (`recorder_recordings.transcript_id`). On prod 43 meetings came from the
 *    tray but only 4 carry `gmeet_context.recorder` — the marker is younger
 *    than the flow.
 *  - a Meet/Teams VIDEO import carries a REAL AssemblyAI id (only the
 *    transcript-Doc imports get a `gmeet-`/`teams-` id), so without the
 *    `gmeet_context` checks 208 Meet meetings would be filed as uploads.
 */
function sourceKindOf(row: Row, recorderRecordingId: string | null): SourceKind {
  const g = row.gmeet_context;
  if (g?.recorder || recorderRecordingId) return 'recorder';
  const id = row.assemblyai_id;
  if (id.startsWith('gmeet-')) return 'meet';
  if (id.startsWith('teams-')) return 'teams';
  if (id.startsWith('ext-')) return 'text';
  if (g?.provider === 'teams' || g?.teams) return 'teams';
  if (g?.videoFileId || g?.meetingCode || g?.actuals) return 'meet';
  // Imported from AssemblyAI by id: a real job, no bytes of ours, no
  // conferencing context. (All 35 such rows on prod are source='imported'.)
  if (isRealAaiId(id) && !row.local_audio_path && !g) return 'aai-import';
  return 'upload';
}

type Provider = 'assemblyai' | 'meet-doc' | 'teams-vtt' | 'text';
function providerOf(row: Row): Provider {
  const id = row.assemblyai_id;
  if (id.startsWith('gmeet-')) return 'meet-doc';
  if (id.startsWith('teams-')) return 'teams-vtt';
  if (id.startsWith('ext-')) return 'text';
  return 'assemblyai';
}

function statusOf(row: Row): 'processing' | 'completed' | 'error' {
  if (row.status === 'completed') return 'completed';
  if (row.status === 'error') return 'error';
  return 'processing';
}

/**
 * The key two meetings must share to collapse onto one recording: the
 * AssemblyAI job when there is a real one, else the row's own identity.
 */
function canonicalKeyOf(row: Row): string {
  return isRealAaiId(row.assemblyai_id)
    ? row.assemblyai_id
    : `${row.assemblyai_id}|${row.user_id}`;
}

// ---------------------------------------------------------------------------
// The plan for one meeting
// ---------------------------------------------------------------------------

interface MediaPlan {
  id: string;
  kind: 'canonical' | 'part' | 'audio_only';
  ord: number;
  offsetMs: number | null;
  durationMs: number | null;
  filename: string | null;
  bytes: number | null;
  hasVideo: boolean | null;
  sourceRef: Record<string, unknown> | null;
  ofMediaId: string | null;
}

interface MeetingPlan {
  row: Row;
  canonicalKey: string;
  recordingId: string;
  /** False = another meeting already owns this recording; only a clip is written. */
  owns: boolean;
  sourceKind: SourceKind;
  startedAt: string | null;
  durationMs: number | null;
  recorderRecordingId: string | null;
  media: MediaPlan[];
  transcriptionId: string;
  provider: Provider;
  providerJobId: string | null;
  covers: { media: string[]; timeline: 'wall' | 'concat' };
  /** local_audio_path that is NOT on disk (only filled with --check-files). */
  missingFile: string | null;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;

function statOf(storageDir: string | null, filename: string | null) {
  if (!storageDir || !filename) return { exists: null as boolean | null, bytes: null };
  const abs = path.join(path.resolve(storageDir), 'audio', filename);
  if (!existsSync(abs)) return { exists: false, bytes: null };
  try {
    return { exists: true, bytes: statSync(abs).size };
  } catch {
    return { exists: true, bytes: null };
  }
}

function planFor(row: Row, owns: boolean, recorderByTranscript: Map<string, string>): MeetingPlan {
  const g = row.gmeet_context;
  const canonicalKey = canonicalKeyOf(row);
  const recordingId = recordingIdFor(canonicalKey);
  const durationMs = row.duration != null ? Math.round(row.duration * 1000) : null;
  const recorderRecordingId =
    g?.recorder?.recordingId ?? recorderByTranscript.get(row.assemblyai_id) ?? null;

  // A concat row's canonical file is a DERIVATIVE of its parts, not a capture
  // of its own — the listing's recording_count leans on this stamp.
  const uploadedParts = g?.uploadedParts ?? [];
  const combinedParts = typeof g?.combinedParts === 'number' ? g.combinedParts : 0;
  const isConcat = uploadedParts.length > 0 || combinedParts > 0;

  const media: MediaPlan[] = [];
  if (row.local_audio_path) {
    const st = statOf(CHECK_FILES, row.local_audio_path);
    const id = mediaIdFor(recordingId, 'canonical', 0);
    media.push({
      id,
      kind: 'canonical',
      ord: 0,
      offsetMs: 0,
      durationMs,
      filename: row.local_audio_path,
      bytes: st.bytes,
      hasVideo: VIDEO_EXT.test(row.local_audio_path),
      sourceRef: {
        ...(g?.videoFileId ? { driveFileId: g.videoFileId } : {}),
        ...(g?.teams?.recordingId ? { teamsRecordingId: g.teams.recordingId } : {}),
        ...(row.original_filename ? { originalFilename: row.original_filename } : {}),
        ...(isConcat ? { derived: 'concat' } : {}),
      },
      ofMediaId: null,
    });
    // The rebuildable 64 kbps extract, when it is already on disk.
    if (CHECK_FILES && st.exists) {
      const stem = row.local_audio_path.replace(/\.[^.]+$/, '');
      const extract = path.join(path.resolve(CHECK_FILES), 'audio-only', `${stem}.m4a`);
      if (existsSync(extract)) {
        media.push({
          id: mediaIdFor(recordingId, 'audio_only', 0),
          kind: 'audio_only',
          ord: 0,
          offsetMs: 0,
          durationMs,
          filename: `${stem}.m4a`,
          bytes: statSync(extract).size,
          hasVideo: false,
          sourceRef: null,
          ofMediaId: id,
        });
      }
    }
  }

  // The parts. Today's listing takes GREATEST of the three jsonb shapes, so
  // the longest list is the one that describes the capture; a row carrying
  // two of them at once does not exist in prod but would not be double
  // counted here either.
  const fromVideoParts = videoPartOffsets(g).map((p, i) => ({
    ord: i,
    offsetMs: p.offsetSec != null ? Math.round(p.offsetSec * 1000) : null,
    durationMs: p.durationSec != null ? Math.round(p.durationSec * 1000) : null,
    filename: p.filename ?? null,
    sourceRef: { driveFileId: (g?.videoParts ?? [])[i]?.fileId ?? null } as Record<string, unknown>,
  }));
  const fromUploaded = [...uploadedParts]
    .sort((a, b) => a.index - b.index)
    .map((p, i) => ({
      ord: i,
      offsetMs: p.offsetSec != null ? Math.round(p.offsetSec * 1000) : null,
      durationMs: p.durationSec != null ? Math.round(p.durationSec * 1000) : null,
      // The stitch consumed the source temp files; only their offsets survive.
      filename: null as string | null,
      sourceRef: {
        ...(p.originalFilename ? { originalFilename: p.originalFilename } : {}),
        ...(p.comment ? { comment: p.comment } : {}),
      } as Record<string, unknown>,
    }));
  const fromCombined = Array.from({ length: combinedParts }, (_, i) => ({
    ord: i,
    offsetMs: null as number | null,
    durationMs: null as number | null,
    filename: null as string | null,
    // combinedParts is only a COUNT in gmeet_context — no filenames, no
    // offsets survived the combine. The rows exist so the meeting still says
    // "N recordings"; Phase 3 fills the windows in.
    sourceRef: { combined: true } as Record<string, unknown>,
  }));
  const parts = [fromVideoParts, fromUploaded, fromCombined].sort((a, b) => b.length - a.length)[0]!;
  for (const p of parts) {
    media.push({
      id: mediaIdFor(recordingId, 'part', p.ord),
      kind: 'part',
      ord: p.ord,
      offsetMs: p.offsetMs,
      durationMs: p.durationMs,
      filename: p.filename,
      bytes: statOf(CHECK_FILES, p.filename).bytes,
      hasVideo: p.filename ? VIDEO_EXT.test(p.filename) : null,
      sourceRef: p.sourceRef,
      ofMediaId: null,
    });
  }

  const canonicalId = media.find((m) => m.kind === 'canonical')?.id;
  const partIds = media.filter((m) => m.kind === 'part').map((m) => m.id);
  const covers = {
    // A concat job heard its parts through the concat; a wall-time job heard
    // only the primary — which is why a Meet stop/restart part shows the
    // "not transcribed" warning today.
    media: isConcat
      ? [...(canonicalId ? [canonicalId] : []), ...partIds]
      : canonicalId
        ? [canonicalId]
        : [],
    timeline: (isConcat ? 'concat' : 'wall') as 'wall' | 'concat',
  };

  const missing =
    CHECK_FILES && row.local_audio_path && statOf(CHECK_FILES, row.local_audio_path).exists === false
      ? row.local_audio_path
      : null;

  return {
    row,
    canonicalKey,
    recordingId,
    owns,
    sourceKind: sourceKindOf(row, recorderRecordingId),
    startedAt: g?.actuals?.anchorIso ?? null,
    durationMs,
    recorderRecordingId,
    media,
    transcriptionId: transcriptionIdFor(recordingId),
    provider: providerOf(row),
    providerJobId: isRealAaiId(row.assemblyai_id) ? row.assemblyai_id : null,
    covers,
    missingFile: missing,
  };
}

/** Placeholders with nothing behind them: no payload, no bytes, no job. */
function skipReason(row: Row): string | null {
  const placeholder = row.assemblyai_id.startsWith('up-') || row.assemblyai_id.startsWith('defer-');
  if (placeholder && !row.has_content && !row.local_audio_path) {
    return `placeholder (${row.assemblyai_id.split('-')[0]}-) with no payload and no media`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// max: 1 so the session-level read-only guard below covers every statement.
const sql = postgres({ max: 1, onnotice: () => {} });

async function main() {
  if (!APPLY) await sql.unsafe('SET default_transaction_read_only = on');

  const rows = await sql<Row[]>`
    SELECT t.id, t.user_id, t.assemblyai_id, t.original_filename, t.status,
           t.created_at, t.completed_at, t.duration, t.language_code,
           t.speech_model, t.local_audio_path, t.deleted_at, t.gmeet_context,
           (t.imported_content IS NOT NULL) AS has_content
    FROM ${sql(SCHEMA)}.transcripts t
    ${ONLY ? sql`WHERE t.assemblyai_id = ${ONLY}` : sql``}
    ORDER BY t.created_at, t.id
  `;

  const recorderLinks = await sql<Array<{ id: string; transcript_id: string }>>`
    SELECT id, transcript_id FROM ${sql(SCHEMA)}.recorder_recordings
    WHERE transcript_id IS NOT NULL
  `;
  const recorderByTranscript = new Map(recorderLinks.map((r) => [r.transcript_id, r.id]));

  const skipped: Array<{ id: string; why: string }> = [];
  const plans: MeetingPlan[] = [];
  const owners = new Set<string>();
  const groupMembers = new Map<string, string[]>();

  // Rows arrive oldest-first, so the first survivor of a shared AssemblyAI id
  // owns the recording (spec §1: "owner = the earlier created_at").
  for (const row of rows) {
    const why = skipReason(row);
    if (why) {
      skipped.push({ id: row.assemblyai_id, why });
      continue;
    }
    const key = canonicalKeyOf(row);
    groupMembers.set(key, [...(groupMembers.get(key) ?? []), row.assemblyai_id]);
    const owns = !owners.has(key);
    owners.add(key);
    plans.push(planFor(row, owns, recorderByTranscript));
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

/** One transaction per meeting: an interrupted run resumes cleanly. */
async function writePlan(plan: MeetingPlan) {
  await sql.begin(async (tx) => {
    if (plan.owns) {
      await tx`
        INSERT INTO ${tx(SCHEMA)}.recordings
          (id, owner_user_id, source_kind, started_at, duration_ms, recorder_recording_id)
        VALUES (${plan.recordingId}::uuid, ${plan.row.user_id}, ${plan.sourceKind},
                ${plan.startedAt}, ${plan.durationMs}, ${plan.recorderRecordingId}::uuid)
        ON CONFLICT (id) DO UPDATE SET
          source_kind           = EXCLUDED.source_kind,
          started_at            = COALESCE(EXCLUDED.started_at, recordings.started_at),
          duration_ms           = COALESCE(EXCLUDED.duration_ms, recordings.duration_ms),
          recorder_recording_id = COALESCE(EXCLUDED.recorder_recording_id,
                                           recordings.recorder_recording_id),
          updated_at            = now()
      `;

      for (const m of plan.media) {
        await tx`
          INSERT INTO ${tx(SCHEMA)}.recording_media
            (id, recording_id, kind, ord, offset_ms, duration_ms, filename, bytes,
             has_video, source_ref, of_media_id)
          VALUES (${m.id}::uuid, ${plan.recordingId}::uuid, ${m.kind}, ${m.ord},
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
      await tx`
        INSERT INTO ${tx(SCHEMA)}.recording_transcriptions
          (id, recording_id, provider, provider_job_id, speech_model, language_code,
           status, payload, covers, created_at, completed_at)
        SELECT ${plan.transcriptionId}::uuid, ${plan.recordingId}::uuid, ${plan.provider},
               ${plan.providerJobId}, ${plan.row.speech_model}, ${plan.row.language_code},
               ${statusOf(plan.row)}, t.imported_content, ${tx.json(plan.covers as never)},
               t.created_at, t.completed_at
        FROM ${tx(SCHEMA)}.transcripts t
        WHERE t.id = ${plan.row.id}
        ON CONFLICT (id) DO UPDATE SET
          status        = EXCLUDED.status,
          payload       = COALESCE(EXCLUDED.payload, recording_transcriptions.payload),
          covers        = EXCLUDED.covers,
          completed_at  = COALESCE(EXCLUDED.completed_at,
                                   recording_transcriptions.completed_at)
      `;

      await tx`
        UPDATE ${tx(SCHEMA)}.recordings
        SET active_transcription_id = ${plan.transcriptionId}::uuid, updated_at = now()
        WHERE id = ${plan.recordingId}::uuid
      `;
    }

    await tx`
      INSERT INTO ${tx(SCHEMA)}.meeting_clips
        (transcript_id, ord, recording_id, transcription_id, from_ms, to_ms,
         offset_ms, text_policy, created_by)
      VALUES (${plan.row.id}, 0, ${plan.recordingId}::uuid, NULL, 0, NULL, 0,
              'include', 'recordings-backfill')
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
  for (const p of plans) bySource.set(p.sourceKind, (bySource.get(p.sourceKind) ?? 0) + 1);

  const shared = [...groupMembers.entries()].filter(([, ids]) => ids.length > 1);
  const missing = plans.filter((p) => p.missingFile);
  const mediaRows = plans.filter((p) => p.owns).reduce((n, p) => n + p.media.length, 0);
  const multiPart = plans.filter((p) => p.owns && p.media.some((m) => m.kind === 'part'));
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
