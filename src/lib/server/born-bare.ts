import 'server-only';
import {
  claimReadyNotification,
  completeStandaloneTranscription,
  createStandaloneRecording,
  deleteStandaloneRows,
  findStandaloneGroup,
  getStandalone,
  getStandaloneForOwner,
  linkRegistryToRecording,
  listExpiredStandalone,
  listProcessingStandalone,
  listStaleStandaloneUploads,
  listStandaloneAaiDeletePending,
  listStandaloneIngestRetries,
  listUnnotifiedStandalone,
  mergeStandaloneState,
  recordStandaloneHandOff,
  releaseReadyNotification,
  setStandaloneGroupPart,
  standaloneColumnsExist,
  standaloneMedia,
  type StandaloneRecordingRow,
  type StandaloneUploadState,
} from '@/db-ops/standalone-recordings';
import { listMediaBlobsForRecordings } from '@/db-ops/recordings';
import { recordingsWriteEnabled } from '@/lib/server/recording-sync';
import { deleteBlobsForRemovedRecordings, queueMediaArchiveForRecording } from '@/lib/server/media-archive';
import {
  audioFilename,
  audioFileExists,
  deleteAudioFile,
  deleteAudioFilesByPrefix,
  renameAudioFile,
  resolveAudioPath,
} from '@/lib/server/audio-storage';
import { dropAudioOnly } from '@/lib/server/audio-only';
import { concatMediaSmart, probeDurationSec } from '@/lib/server/media-concat';
import { normalizeMultiTrack } from '@/lib/server/multitrack';
import { sniffMediaExtension } from '@/lib/server/video-frames';
import { uploadFile, getTranscript, deleteTranscript, isAaiNotFound } from '@/lib/server/assemblyai';
import { submitForIngest } from '@/lib/server/ingest';
import { deleteOnCompleteEnabled } from '@/lib/server/aai-retention';
import { mediaIdFor, transcriptionIdFor } from '@/lib/recording-graph';
import { AAI_GONE_REASON, AAI_STUCK_MS, AAI_STUCK_REASON } from '@/lib/aai-job-state';
import { notifyUser, APP_URL } from '@/lib/server/darth-notify';
import { dm, meetingLine } from '@/lib/server/dm-copy';
import { partHashesInOrder, uploadIdentityHash, normalizeSha256 } from '@/lib/same-file';
import type { DarthUser } from '@/lib/auth/session';
import type { SpeechModel } from '@/lib/aai-language';
import type { TranscriptResponse } from '@/lib/format';

/**
 * Design P7 — an upload that names no meeting is born a RECORDING
 * (docs/recordings-meetings-series-design.md §1.2, "As built — P7/P8").
 *
 * Owner decision (Alok, 2026-09-23): recordings are personal and never
 * shared; only meetings are. So the tray's auto-upload, a web drag-in with no
 * event picked, `darth-cli meetings upload` without `--event` and a phone
 * clip create a `recordings` row (+ media + transcription) and NO
 * `transcripts` row. It becomes part of a meeting only when its owner links
 * it (lib/server/recording-actions.ts).
 *
 * The pieces a meeting-born upload keeps on its `up-` placeholder live on the
 * recording's `upload_state` instead (group parts, bytes, heartbeat, a kept
 * hand-off failure), and the byte-delivery routes answer with a pseudo
 * transcript whose `assemblyai_id` is `rec-<recording id>` — what the Darth
 * Recorder tray, the web dialog and darth-cli already read — so no client has
 * to change to keep working. `/transcript/rec-<id>` redirects to
 * `/recording/<id>` (src/proxy.ts).
 *
 * Flag: `MW_RECORDINGS_BORN_BARE`, lazy, default OFF. It is honoured only when
 * `MW_RECORDINGS_WRITE` is on too (the permanent delete of a meeting made from
 * a recording must go through the graph cleanup, which keeps the recording's
 * files — see db-ops/recordings.ts `removeMeetingFromRecordingGraph`) and
 * migrations 045 + 049 are applied. Off = today's behaviour, byte for byte,
 * and not one new query on the upload path.
 */

export const BORN_BARE_PREFIX = 'rec-';

/** The env half of the gate. */
export function bornBareFlagOn(): boolean {
  const raw = (process.env.MW_RECORDINGS_BORN_BARE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** The whole gate: flag AND the dual-write AND the columns. */
export async function bornBareEnabled(): Promise<boolean> {
  if (!bornBareFlagOn()) return false;
  if (!recordingsWriteEnabled()) {
    warnOnce(
      'write',
      '[born-bare] MW_RECORDINGS_BORN_BARE is set but MW_RECORDINGS_WRITE is not — ignored, uploads stay meetings'
    );
    return false;
  }
  return standaloneColumnsExist().catch(() => false);
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** `rec-<uuid>` → `<uuid>`, else null. */
export function recordingIdFromPseudo(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(BORN_BARE_PREFIX)) return null;
  const rid = id.slice(BORN_BARE_PREFIX.length);
  return UUID_RE.test(rid) ? rid.toLowerCase() : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** P8: a temporary recording lives this long unless its owner acts. */
export const TEMPORARY_TTL_DAYS = 30;

// ---------------------------------------------------------------------------
// The wire shape the byte-delivery routes answer with
// ---------------------------------------------------------------------------

/**
 * What `transcript` is in an upload answer for a born-bare upload. Carries
 * the fields every current client reads from a meeting row (`assemblyai_id`,
 * `status`, `title`, `original_filename`, `created_at`) plus what says it is
 * a recording. The tray stores `assemblyai_id` as its registry
 * `transcript_id`, and opens `/transcript/<it>` — which redirects.
 */
export interface BornBareTranscriptWire {
  assemblyai_id: string;
  recording_id: string;
  born_bare: true;
  status: 'uploading' | 'processing' | 'completed' | 'error';
  title: string | null;
  original_filename: string | null;
  created_at: string;
  expires_at: string | null;
  scratch: boolean;
}

export function bornBareWire(
  row: Pick<StandaloneRecordingRow, 'id' | 'title' | 'created_at' | 'expires_at' | 'upload_state'>,
  status: BornBareTranscriptWire['status']
): BornBareTranscriptWire {
  return {
    assemblyai_id: `${BORN_BARE_PREFIX}${row.id}`,
    recording_id: row.id,
    born_bare: true,
    status,
    title: row.title,
    original_filename: row.upload_state?.originalFilename ?? null,
    created_at: iso(row.created_at),
    expires_at: row.expires_at ? iso(row.expires_at) : null,
    scratch: !!row.expires_at,
  };
}

function iso(v: string | Date): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export interface BornBareOpenInput {
  uuid: string;
  originalFilename: string | null;
  languageCode?: string;
  speechModel?: SpeechModel;
  bytesTotal: number | null;
  scratch: boolean;
  recorderRecordingId?: string | null;
  recorderBirth?: { title?: string | null; startedAt?: string | null } | null;
  multi: {
    group: string;
    index: number;
    total: number;
    comment?: string;
    groupBytes?: number;
    partSha256?: string[];
  } | null;
}

export type BornBareOpen =
  | { ok: true; recording: StandaloneRecordingRow; recordingId: string; tempFilename: string }
  | { ok: false; status: number; error: string };

/**
 * Stage 1 for a born-bare upload: create the recording (single file / part 1)
 * or find the group's (parts 2..N). The temp file is `upload-<uuid>.part[N]`,
 * exactly as for a meeting-born upload, so the temp-file sweepers treat it
 * the same way.
 */
export async function openBornBare(user: DarthUser, input: BornBareOpenInput): Promise<BornBareOpen> {
  const multi = input.multi;
  if (multi && multi.index > 1) {
    const rec = await findStandaloneGroup(user.userId, multi.group);
    const group = rec?.upload_state?.group;
    if (!rec || !group) return { ok: false, status: 404, error: 'Upload group not found (expired or reaped)' };
    if (group.total !== multi.total || group.parts.some((p) => p.index === multi.index)) {
      return { ok: false, status: 409, error: 'Upload group state mismatch' };
    }
    return {
      ok: true,
      recording: rec,
      recordingId: rec.id,
      tempFilename: `upload-${rec.id}.part${multi.index}`,
    };
  }
  const recordingId = input.uuid;
  const tempFilename = `upload-${recordingId}.part`;
  const state: StandaloneUploadState = {
    originalFilename: input.originalFilename,
    languageCode: input.languageCode ?? null,
    speechModel: input.speechModel ?? null,
    bytesTotal: multi?.groupBytes ?? input.bytesTotal,
    bytesReceived: 0,
    ownerEmail: user.email,
    ...(multi
      ? {
          group: {
            id: multi.group,
            total: multi.total,
            ...(multi.groupBytes ? { bytesTotal: multi.groupBytes } : {}),
            ...(multi.partSha256 ? { partSha256: multi.partSha256 } : {}),
            parts: [
              {
                index: 1,
                tempFilename,
                ...(input.originalFilename ? { originalFilename: input.originalFilename } : {}),
                ...(multi.comment ? { comment: multi.comment } : {}),
              },
            ],
          },
        }
      : {}),
  };
  const recording = await createStandaloneRecording({
    id: recordingId,
    ownerUserId: user.userId,
    sourceKind: input.recorderRecordingId ? 'recorder' : 'upload',
    title: input.recorderBirth?.title?.slice(0, 300) || null,
    startedAt: input.recorderBirth?.startedAt ?? null,
    recorderRecordingId: input.recorderRecordingId ?? null,
    expiresAt: input.scratch ? new Date(Date.now() + TEMPORARY_TTL_DAYS * 86_400_000) : null,
    uploadState: state,
  });
  return { ok: true, recording, recordingId, tempFilename };
}

/** Delete what `openBornBare` created when the bytes never (fully) arrived. */
export async function abandonBornBare(
  user: DarthUser,
  recordingId: string,
  tempFilename: string,
  partIndex: number | null
): Promise<void> {
  await deleteAudioFile(tempFilename);
  if (partIndex && partIndex > 1) return;
  const rec = await getStandaloneForOwner(user.userId, recordingId).catch(() => null);
  // Only a recording still waiting for its bytes — never one that was handed off.
  if (!rec || rec.active_transcription_id || rec.upload_state?.ingestFailure) return;
  await deleteAudioFilesByPrefix(`upload-${recordingId}.part`);
  await deleteStandaloneRows(recordingId).catch((err) =>
    console.warn(`[born-bare] abandon ${recordingId} failed:`, err)
  );
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

export interface BornBareFinalizeResult {
  status: number;
  body: { transcript: BornBareTranscriptWire } | { error: string; detail?: string };
}

/**
 * Stage 2: the temp file is complete. A multi-file group parks the part (and
 * stitches + hands off on the last one); a single file is handed off. Never
 * throws for the expected failures — the answer is the HTTP status + body.
 */
export async function finalizeBornBare(
  user: DarthUser,
  args: {
    recordingId: string;
    tempFilename: string;
    originalFilename: string | null;
    multi: BornBareOpenInput['multi'];
    recorderRecordingId?: string | null;
  },
  bytes: number,
  partSha256: string | null
): Promise<BornBareFinalizeResult> {
  const { recordingId, tempFilename, multi } = args;
  const rec = await getStandaloneForOwner(user.userId, recordingId);
  if (!rec) {
    await deleteAudioFile(tempFilename);
    return { status: 404, body: { error: 'Upload not found (expired or reaped)' } };
  }

  if (multi) {
    const state = await setStandaloneGroupPart(user.userId, recordingId, {
      index: multi.index,
      tempFilename,
      ...(args.originalFilename ? { originalFilename: args.originalFilename } : {}),
      ...(multi.comment ? { comment: multi.comment } : {}),
      bytes,
      ...(partSha256 ? { sha256: partSha256 } : {}),
    });
    const group = state?.group;
    if (!group) {
      await deleteAudioFile(tempFilename);
      return { status: 409, body: { error: 'Upload group state mismatch' } };
    }
    const landed = group.parts.filter((p) => typeof p.bytes === 'number');
    await mergeStandaloneState(user.userId, recordingId, {
      bytesReceived: landed.reduce((s, p) => s + (p.bytes ?? 0), 0),
    }).catch(() => {});
    if (landed.length < group.total) {
      return { status: 201, body: { transcript: bornBareWire(rec, 'uploading') } };
    }
    // Last part: stitch in index order, then ONE hand-off.
    const parts = [...group.parts].sort((a, b) => a.index - b.index);
    const hashes = partHashesInOrder(parts, group.total) ?? group.partSha256 ?? null;
    const identity = hashes ? uploadIdentityHash({ partSha256: hashes }) : null;
    try {
      const durations: Array<number | null> = [];
      for (const p of parts) durations.push(await probeDurationSec(p.tempFilename));
      let offset = 0;
      const uploadedParts = parts.map((p, i) => {
        const entry = {
          index: p.index,
          ...(p.originalFilename ? { originalFilename: p.originalFilename } : {}),
          ...(p.comment ? { comment: p.comment } : {}),
          ...(durations[i] != null ? { durationSec: durations[i]! } : {}),
          offsetSec: Math.round(offset * 10) / 10,
          ...(p.sha256 ? { sha256: p.sha256 } : {}),
        };
        offset += durations[i] ?? 0;
        return entry;
      });
      const { filename: combined } = await concatMediaSmart(
        parts.map((p) => p.tempFilename),
        { scratchId: recordingId }
      );
      for (const p of parts) await deleteAudioFile(p.tempFilename);
      await mergeStandaloneState(user.userId, recordingId, { uploadedParts, group: null });
      const ext = combined.slice(combined.lastIndexOf('.'));
      const outcome = await handOff(user.userId, rec, combined, {
        originalFilename: `stitched-${group.total}-recordings${ext}`,
        uploadedParts,
        sha256: identity,
      });
      await linkRegistry(user.userId, args.recorderRecordingId ?? rec.recorder_recording_id, recordingId);
      return { status: 201, body: { transcript: bornBareWire(rec, outcome) } };
    } catch (error) {
      console.error(`[born-bare] stitch failed for ${recordingId}:`, error);
      await deleteAudioFilesByPrefix(`upload-${recordingId}.part`);
      await deleteStandaloneRows(recordingId).catch(() => {});
      return { status: 502, body: { error: 'Stitching the recordings failed', detail: String(error) } };
    }
  }

  await mergeStandaloneState(user.userId, recordingId, { bytesReceived: bytes }).catch(() => {});
  const outcome = await handOff(user.userId, rec, tempFilename, {
    originalFilename: args.originalFilename,
    uploadedParts: null,
    sha256: normalizeSha256(partSha256),
  });
  await linkRegistry(user.userId, args.recorderRecordingId ?? rec.recorder_recording_id, recordingId);
  return { status: 201, body: { transcript: bornBareWire(rec, outcome) } };
}

async function linkRegistry(
  userId: string,
  recorderRecordingId: string | null | undefined,
  recordingId: string
): Promise<void> {
  if (!recorderRecordingId) return;
  await linkRegistryToRecording(userId, recorderRecordingId, recordingId).catch((err) =>
    console.warn(`[born-bare] registry link ${recorderRecordingId} failed:`, err)
  );
}

/** Retry backoff for a kept hand-off failure: 5, 10, 20, 40 min, then hourly; give up after 72 h. */
const RETRY_GIVE_UP_MS = 72 * 3600_000;
function retryDelayMs(attempts: number): number {
  return Math.min(60, 5 * 2 ** Math.max(0, attempts - 1)) * 60_000;
}

/**
 * The hand-off: mix multi-track audio, give the bytes their permanent name
 * (`<recording id><ext>`), upload to AssemblyAI, submit, and record the media
 * + transcription rows. A failed upload/submit is KEPT: the bytes stay, the
 * recording shows "failed — retrying", and the sweeper tries again
 * (the 2026-09-16 rule: an accepted upload never vanishes).
 */
async function handOff(
  userId: string,
  rec: StandaloneRecordingRow,
  tempFilename: string,
  opts: {
    originalFilename: string | null;
    uploadedParts: StandaloneUploadState['uploadedParts'];
    sha256: string | null;
  }
): Promise<BornBareTranscriptWire['status']> {
  const recordingId = rec.id;
  let aaiSource = tempFilename;
  let mixFilename: string | null = null;
  try {
    const mt = await normalizeMultiTrack(tempFilename);
    if (mt.mixed) {
      aaiSource = mt.aaiSource;
      mixFilename = mt.aaiSource;
    }
  } catch (error) {
    console.warn('[born-bare] multi-track normalisation failed (uploading raw file):', error);
  }

  let filename = audioFilename(recordingId, opts.originalFilename ?? rec.upload_state?.originalFilename ?? null);
  if (filename.endsWith('.bin')) {
    const sniffed = await sniffMediaExtension(tempFilename).catch(() => null);
    if (sniffed) filename = `${recordingId}${sniffed}`;
  }
  const bytes = await import('node:fs/promises')
    .then((fsp) => fsp.stat(resolveAudioPath(tempFilename)))
    .then((st) => st.size)
    .catch(() => null);

  let jobId: string | null = null;
  let model: string | null = null;
  let failure: { stage: 'aai-upload' | 'aai-submit'; error: unknown } | null = null;
  try {
    const audioUrl = await uploadFile(resolveAudioPath(aaiSource)).catch((error) => {
      failure = { stage: 'aai-upload', error };
      return null;
    });
    if (audioUrl) {
      try {
        const submitted = await submitForIngest(userId, audioUrl, {
          originalFilename: opts.originalFilename,
          languageCode: rec.upload_state?.languageCode ?? undefined,
          speechModel: (rec.upload_state?.speechModel as SpeechModel | null) ?? undefined,
        });
        jobId = submitted.id;
        model = submitted.model;
      } catch (error) {
        failure = { stage: 'aai-submit', error };
      }
    }
  } finally {
    if (mixFilename) await deleteAudioFile(mixFilename).catch(() => {});
  }

  if (filename !== tempFilename) await renameAudioFile(tempFilename, filename);
  const hasVideo = /\.(mp4|webm|mov|mkv|m4v)$/i.test(filename);
  const canonicalId = mediaIdFor(recordingId, 'canonical', 0);
  await recordStandaloneHandOff({
    recordingId,
    canonical: {
      id: canonicalId,
      filename,
      bytes,
      hasVideo,
      sourceRef: {
        ...(opts.originalFilename ? { originalFilename: opts.originalFilename } : {}),
        ...(opts.uploadedParts && opts.uploadedParts.length > 0 ? { derived: 'concat' } : {}),
      },
    },
    parts: (opts.uploadedParts ?? []).map((p, i) => ({
      id: mediaIdFor(recordingId, 'part', i),
      ord: i,
      offsetMs: Math.round(p.offsetSec * 1000),
      durationMs: p.durationSec != null ? Math.round(p.durationSec * 1000) : null,
      sourceRef: {
        ...(p.originalFilename ? { originalFilename: p.originalFilename } : {}),
        ...(p.comment ? { comment: p.comment } : {}),
      },
    })),
    transcription: {
      id: transcriptionIdFor(recordingId),
      providerJobId: jobId,
      speechModel: model,
      languageCode: rec.upload_state?.languageCode ?? null,
      status: jobId ? 'processing' : null,
    },
    sha256: opts.sha256,
  });
  // DEC-3 Stage A: the permanent copy (inert unless the archive is configured).
  queueMediaArchiveForRecording(recordingId, 'born-bare');

  if (!jobId) {
    const f = failure as { stage: 'aai-upload' | 'aai-submit'; error: unknown } | null;
    await keepFailure(userId, rec, f?.stage ?? 'aai-upload', f?.error);
    return 'error';
  }
  watchTranscription(recordingId);
  return 'processing';
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  return (raw || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
}

async function keepFailure(
  userId: string,
  rec: StandaloneRecordingRow,
  stage: 'aai-upload' | 'aai-submit',
  causeErr: unknown
): Promise<void> {
  const prev = rec.upload_state?.ingestFailure;
  const now = new Date();
  const firstAt = prev?.firstAt ?? now.toISOString();
  const attempts = (prev?.attempts ?? 0) + 1;
  const retryable = now.getTime() - new Date(firstAt).getTime() < RETRY_GIVE_UP_MS;
  await mergeStandaloneState(userId, rec.id, {
    ingestFailure: {
      stage,
      message: errorText(causeErr),
      firstAt,
      at: now.toISOString(),
      attempts,
      nextAt: retryable ? new Date(now.getTime() + retryDelayMs(attempts)).toISOString() : null,
      retryable,
    },
  });
  console.warn(
    `[born-bare] ${stage} failed for recording ${rec.id} — kept (attempt ${attempts}, ` +
      `${retryable ? 'will retry' : 'gave up'}): ${errorText(causeErr)}`
  );
}

/**
 * The sweeper's retry of a kept hand-off: the bytes are already under their
 * permanent name, so this is only the AssemblyAI half again.
 */
export async function retryBornBareIngest(recordingId: string): Promise<boolean> {
  const rec = await getStandalone(recordingId);
  if (!rec || rec.deleted_at || rec.active_transcription_id) return false;
  const canonical = (await standaloneMedia(recordingId)).find((m) => m.kind === 'canonical');
  if (!canonical?.filename || !(await audioFileExists(canonical.filename))) {
    const now = new Date().toISOString();
    const prev = rec.upload_state?.ingestFailure;
    await mergeStandaloneState(rec.owner_user_id, recordingId, {
      ingestFailure: {
        stage: prev?.stage ?? 'aai-upload',
        firstAt: prev?.firstAt ?? now,
        at: now,
        attempts: prev?.attempts ?? 1,
        retryable: false,
        nextAt: null,
        message: 'the uploaded file is gone',
      },
    });
    return false;
  }
  let jobId: string | null = null;
  let model: string | null = null;
  try {
    const audioUrl = await uploadFile(resolveAudioPath(canonical.filename));
    const submitted = await submitForIngest(rec.owner_user_id, audioUrl, {
      originalFilename: rec.upload_state?.originalFilename ?? null,
      languageCode: rec.upload_state?.languageCode ?? undefined,
      speechModel: (rec.upload_state?.speechModel as SpeechModel | null) ?? undefined,
    });
    jobId = submitted.id;
    model = submitted.model;
  } catch (error) {
    await keepFailure(rec.owner_user_id, rec, 'aai-submit', error);
    return false;
  }
  await recordStandaloneHandOff({
    recordingId,
    canonical: {
      id: canonical.id,
      filename: canonical.filename,
      bytes: null,
      hasVideo: canonical.has_video ?? false,
      sourceRef: {},
    },
    parts: [],
    transcription: {
      id: transcriptionIdFor(recordingId),
      providerJobId: jobId,
      speechModel: model,
      languageCode: rec.upload_state?.languageCode ?? null,
      status: 'processing',
    },
  });
  console.log(`[born-bare] retried hand-off of recording ${recordingId} → job ${jobId}`);
  watchTranscription(recordingId);
  return true;
}

// ---------------------------------------------------------------------------
// Completion — poll, store, DM once, delete at AssemblyAI
// ---------------------------------------------------------------------------

const gw = globalThis as unknown as { __mwBornBareWatch?: Set<string> };
const watching = (gw.__mwBornBareWatch ??= new Set<string>());

/**
 * In-process watcher: poll the job until it is terminal (15 s, backing off to
 * a minute), so the ready DM does not wait for someone to open a page. A
 * restart loses it; the 5-minute sweeper (`sweepBornBare`) is the backstop.
 */
export function watchTranscription(recordingId: string): void {
  if (watching.has(recordingId)) return;
  watching.add(recordingId);
  let delay = 15_000;
  const started = Date.now();
  const tick = async () => {
    try {
      const done = await refreshBornBare(recordingId);
      if (done || Date.now() - started > AAI_STUCK_MS) {
        watching.delete(recordingId);
        return;
      }
    } catch (err) {
      console.warn(`[born-bare] watch ${recordingId} failed:`, err);
    }
    delay = Math.min(60_000, Math.round(delay * 1.5));
    setTimeout(() => void tick(), delay).unref?.();
  };
  setTimeout(() => void tick(), delay).unref?.();
}

/**
 * Ask AssemblyAI once about a recording's processing transcription. Returns
 * true when the transcription is terminal (now or already). Safe to call
 * from any number of places at once: the completion write is conditional on
 * `status = 'processing'`, and the DM is claimed on the recording row.
 */
export async function refreshBornBare(recordingId: string): Promise<boolean> {
  const rec = await getStandalone(recordingId);
  if (!rec || rec.deleted_at) return true;
  const { listRecordingTranscriptions } = await import('@/db-ops/recordings');
  const txn = (await listRecordingTranscriptions([recordingId])).find(
    (t) => t.id === rec.active_transcription_id
  );
  if (!txn) return false;
  if (txn.status !== 'processing') {
    if (txn.status === 'completed') await notifyReadyOnce(rec);
    return true;
  }
  if (!txn.provider_job_id) return false;
  let aai: TranscriptResponse;
  try {
    aai = await getTranscript(txn.provider_job_id);
  } catch (error) {
    if (isAaiNotFound(error)) {
      await completeStandaloneTranscription(txn.id, { status: 'error', reason: AAI_GONE_REASON });
      return true;
    }
    console.warn(`[born-bare] poll ${recordingId} failed:`, error);
    return false;
  }
  if (aai.status === 'completed') {
    const speakerCount = aai.utterances ? new Set(aai.utterances.map((u) => u.speaker)).size : null;
    const won = await completeStandaloneTranscription(txn.id, {
      status: 'completed',
      payload: aai,
      completedAt: aai.completed ? new Date(aai.completed).toISOString() : null,
      speakerCount,
    });
    if (won) {
      console.log(`[born-bare] recording ${recordingId} transcribed (${aai.utterances?.length ?? 0} utterances)`);
      // DEC-4 needs our own copy of the bytes, as for a meeting (aai-retention
      // `mediaIsSafe`): the canonical file on this disk.
      const canonical = (await standaloneMedia(recordingId)).find((m) => m.kind === 'canonical');
      if (canonical?.filename && (await audioFileExists(canonical.filename))) {
        await deleteAtAaiForRecording(txn.id, txn.provider_job_id, aai.utterances?.length ?? 0).catch(
          (err) => console.warn('[born-bare] AAI delete failed:', err)
        );
      }
    }
    await notifyReadyOnce((await getStandalone(recordingId)) ?? rec);
    return true;
  }
  if (aai.status === 'error') {
    await completeStandaloneTranscription(txn.id, {
      status: 'error',
      reason: (aai as { error?: string }).error ?? 'AssemblyAI reported an error',
    });
    return true;
  }
  if (Date.now() - new Date(txn.created_at).getTime() > AAI_STUCK_MS) {
    await completeStandaloneTranscription(txn.id, { status: 'error', reason: AAI_STUCK_REASON });
    return true;
  }
  return false;
}

/**
 * DEC-4 for a recording: once the payload is stored and the canonical file
 * is on disk, delete the job at AssemblyAI (behind the same
 * MW_AAI_DELETE_ON_COMPLETE switch as meetings) and stamp the transcription.
 */
async function deleteAtAaiForRecording(
  transcriptionId: string,
  jobId: string,
  storedUtterances: number
): Promise<void> {
  if (!deleteOnCompleteEnabled()) return;
  if (storedUtterances === 0) return;
  const { updateRecordingTranscription } = await import('@/db-ops/recordings');
  const gone = await deleteTranscript(jobId);
  if (!gone) return;
  await updateRecordingTranscription(transcriptionId, { providerDeletedAt: new Date().toISOString() });
  console.log(`[born-bare] deleted ${jobId} at AAI (${storedUtterances} utterances kept)`);
}

/**
 * The ONE "your recording is transcribed" DM (risk §6.1): keyed on the
 * RECORDING, claimed on its row, so it is sent once whoever sees the
 * completion first — and never again when the recording later becomes a
 * meeting (making a meeting sends nothing). A send that throws hands the
 * claim back so the sweeper tries again: never zero times either.
 */
export async function notifyReadyOnce(rec: StandaloneRecordingRow): Promise<void> {
  if (rec.ready_notified_at) return;
  if (!(await claimReadyNotification(rec.id))) return;
  const email = rec.upload_state?.ownerEmail;
  if (!email) return; // no address to send to — claimed so nobody retries forever
  try {
    const title = rec.title?.trim() || rec.upload_state?.originalFilename?.trim() || 'Your recording';
    await notifyUser({
      kind: 'transcript_ready',
      toEmail: email,
      text: dm(
        `🎙 *Recording transcribed*`,
        meetingLine({
          title,
          when: rec.started_at ?? rec.created_at,
          duration: rec.duration_ms ? rec.duration_ms / 1000 : null,
          speakerCount: rec.upload_state?.speakerCount ?? null,
        }),
        `It is in your Recordings — only you can see it. Link it to a meeting to share it → <${APP_URL}/recording/${rec.id}|Open recording>`
      ),
      dedupeKey: `mw-recording-ready:${rec.id}:${email}`,
    });
  } catch (err) {
    await releaseReadyNotification(rec.id).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Delete (owner action, expiry, abandon)
// ---------------------------------------------------------------------------

export type DeleteOutcome = 'deleted' | 'in-meeting' | 'not-found';

/**
 * Remove a standalone recording for good: rows, files (canonical, parts,
 * derivatives), archived blobs, and the job at AssemblyAI. Refused (nothing
 * touched) while any meeting — live or in the trash — holds a clip on it
 * (invariant I6: a recording a meeting uses is never swept).
 */
export async function purgeStandaloneRecording(recordingId: string, tag: string): Promise<DeleteOutcome> {
  const blobs = await listMediaBlobsForRecordings([recordingId]).catch(() => []);
  const gone = await deleteStandaloneRows(recordingId);
  if (gone === null) return 'in-meeting';
  for (const f of gone.filenames) {
    await deleteAudioFile(f);
    await dropAudioOnly(f).catch(() => {});
  }
  await deleteAudioFilesByPrefix(`upload-${recordingId}.part`);
  if (blobs.length > 0) {
    await deleteBlobsForRemovedRecordings(blobs, [recordingId], tag).catch((err) =>
      console.warn(`[born-bare] ${tag} blob delete ${recordingId} failed:`, err)
    );
  }
  for (const job of gone.providerJobIds) await deleteTranscript(job).catch(() => false);
  return 'deleted';
}

// ---------------------------------------------------------------------------
// The 5-minute sweep (called from lib/server/auto-notes-sweeper.ts)
// ---------------------------------------------------------------------------

/** Stale in-flight uploads are reaped after this long without a byte and
 * without an open session (the meeting-born reaper's UPLOAD_STALL_MINUTES). */
const STALE_UPLOAD_MINUTES = 15;

/**
 * P8 expiry, stale uploads, the poll backstop, kept-failure retries, the
 * ready-DM backstop and the DEC-4 delete backlog — every job a standalone
 * recording needs done when nobody is looking. Runs whether or not the flag
 * is on today (recordings born while it was on still need finishing), but
 * only when migration 049 is there. Never throws.
 */
export async function sweepBornBare(): Promise<void> {
  if (!(await standaloneColumnsExist().catch(() => false))) return;

  try {
    for (const r of await listExpiredStandalone(20)) {
      const out = await purgeStandaloneRecording(r.id, '[born-bare] expiry');
      console.log(
        `[born-bare] temporary recording ${r.id} (owner ${r.owner_user_id}, expired ${r.expires_at}): ${out}`
      );
    }
  } catch (err) {
    console.warn('[born-bare] expiry sweep failed:', err);
  }

  try {
    for (const r of await listStaleStandaloneUploads(STALE_UPLOAD_MINUTES, 10)) {
      console.log(`[born-bare] reaping stalled upload of recording ${r.id}`);
      await deleteAudioFilesByPrefix(`upload-${r.id}.part`);
      for (const p of r.upload_state?.group?.parts ?? []) await deleteAudioFile(p.tempFilename);
      await deleteStandaloneRows(r.id).catch(() => {});
    }
  } catch (err) {
    console.warn('[born-bare] stale-upload sweep failed:', err);
  }

  try {
    for (const r of await listProcessingStandalone(20)) await refreshBornBare(r.recording_id);
  } catch (err) {
    console.warn('[born-bare] poll backstop failed:', err);
  }

  try {
    for (const r of await listStandaloneIngestRetries(5)) await retryBornBareIngest(r.id);
  } catch (err) {
    console.warn('[born-bare] ingest retry failed:', err);
  }

  try {
    for (const r of await listUnnotifiedStandalone(20)) {
      const rec = await getStandalone(r.id);
      if (rec) await notifyReadyOnce(rec).catch((err) => console.warn('[born-bare] ready DM failed:', err));
    }
  } catch (err) {
    console.warn('[born-bare] ready-DM backstop failed:', err);
  }

  if (deleteOnCompleteEnabled()) {
    try {
      for (const p of await listStandaloneAaiDeletePending(10)) {
        if (!p.canonical_filename || !(await audioFileExists(p.canonical_filename))) continue;
        await deleteAtAaiForRecording(p.transcription_id, p.provider_job_id, p.utterances);
      }
    } catch (err) {
      console.warn('[born-bare] AAI delete backlog failed:', err);
    }
  }
}
