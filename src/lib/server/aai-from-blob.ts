import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import { Writable } from 'node:stream';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import {
  audioFilename,
  deleteAudioFile,
  ensureAudioDir,
  renameAudioFile,
  resolveAudioPath,
} from '@/lib/server/audio-storage';
import {
  archiveMedia,
  archiveStore,
  canaryGate,
  fmtBytes,
} from '@/lib/server/media-archive';
import {
  mediaBlobName,
  mediaContentType,
  mediaStore,
  type MediaBlobLike,
} from '@/lib/server/media-store';
import { redactSasInText } from '@/lib/server/media-serve';
import { createDownloadSas, type BlobLike } from '@/lib/server/darth-uploads';
import { uploadsStore } from '@/lib/server/darth-uploads-store';
import { ensureFaststart } from '@/lib/server/media-faststart';
import { isMixTrack, normalizeMultiTrack, probeAudioStreams } from '@/lib/server/multitrack';
import {
  attachSeriesForRow,
  createOrPromoteRow,
  submitForIngest,
  type IngestOptions,
} from '@/lib/server/ingest';
import {
  queueAfterRecordingSync,
  queueRecordingGraphSync,
  recordingIdForMeeting,
  recordingsWriteEnabled,
} from '@/lib/server/recording-sync';
import { mediaIdFor, recordingIdFor } from '@/lib/recording-graph';
import { mintedIdsEnabled } from '@/db-ops/aai-job-id';
import {
  clearMediaArchiveStamp,
  getRecordingMediaRow,
  setRecordingSha256,
  stampMediaArchived,
} from '@/db-ops/recordings';
import {
  getForUser,
  mergeGmeetContextForUser,
  setLocalAudioPathForUser,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import type { BlobCopyIntent, UploadSpec, UploadTracks } from '@/lib/server/upload-pipeline';
import type { GmeetContext } from '@/lib/format';

/**
 * Stage C of DEC-3 — **AssemblyAI reads the blob; the VM stops pushing bytes**
 * (docs/recordings-blob-spec.md).
 *
 * Today a big upload crosses the VM twice: the browser puts it in the transit
 * account, `/api/uploads/:id/complete` PULLS all of it down to `storage/`, and
 * `ingestLocalAudio` then PUSHES all of it to AssemblyAI over the internet
 * before a single word is transcribed. Stage C removes both legs from the
 * critical path:
 *
 *   1. Azure copies the transit blob into the PERMANENT media container
 *      itself (`copyFromUrl` = `Put Block From URL` × N + `Put Block List`);
 *      not one byte passes through this process.
 *   2. AssemblyAI is handed a **read SAS on that media blob, TTL 6 h**, as
 *      `audio_url`, instead of a `files.upload`.
 *   3. The row is created/promoted exactly as the local path does it, and the
 *      VM fetches its own copy in the BACKGROUND, for the things that genuinely
 *      need a local file (faststart, the audio-only extract, frames,
 *      voiceprints). The meeting is transcribing while that happens.
 *
 * GATES — all lazy, all required, any one missing = today's pull path, byte
 * for byte:
 *  - `MW_AAI_FROM_BLOB`;
 *  - `DARTH_MEDIA_ACCOUNT` (the permanent store) AND `DARTH_UPLOADS_ACCOUNT`
 *    (the transit store the copy reads from);
 *  - `MW_RECORDINGS_WRITE` — the blob is only findable again through
 *    `recording_media.blob_name`, so a host that does not maintain the graph
 *    would strand the bytes;
 *  - migration 045 / minted ids — the blob NAME is derived from the recording
 *    id, and only a minted meeting keeps the same recording id across the
 *    placeholder promotion (`canonicalKeyOf`);
 *  - the lifecycle canary (Stage A.4) — permanent bytes never go into a
 *    container that is eating blobs.
 * And per upload: a single file (a group is stitched on the VM first), not a
 * Darth Recorder upload unless it declares `tracks.mixFirst` (DEC-1 /
 * multi-track, see `blobFastPathRefusal`), a verified sha256, and a known file
 * extension.
 *
 * SAS HYGIENE: the URL handed to AssemblyAI is a bearer credential for that
 * one blob for six hours. It is never stored (`transcripts.audio_url` is left
 * NULL on this path), never logged, and every error that could quote it back
 * goes through `redactSasInText` first.
 *
 * THE INTENT: between the copy and the media row that names its blob there is
 * a window in which the only record of those permanent bytes is a promise in
 * this process. So the blob's name is written onto the upload session FIRST
 * (`BlobCopyIntent`, `blobIntentOf`) and cleared once Stage C is over either
 * way; the expired-session sweeper turns a leftover intent into a
 * `media_blob_deletes` row unless a live media row claims that blob
 * (`abandonedBlobOf`).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const AAI_FROM_BLOB_FLAG_ENV = 'MW_AAI_FROM_BLOB';

/**
 * How long AssemblyAI may read the blob. AssemblyAI fetches the file when the
 * job is submitted (their own S3 guide signs for 30 min); Alok set 10 min on
 * 2026-09-22 — the shorter the bearer link lives, the smaller the exposure.
 * A fetch that misses the window fails the job at AssemblyAI, which the
 * poller surfaces as an error with Retry (the VM holds the bytes). Nothing to
 * delete afterwards: the SAS simply expires (DEC-4).
 */
export const AAI_SAS_TTL_MS = 10 * 60_000;

/**
 * How long the COPY may read the transit blob. Only Azure's own copy engine
 * ever sees this one, for the minutes the block copy takes.
 */
export const COPY_SOURCE_SAS_TTL_MS = 60 * 60_000;

/** A local copy is retried by the sweeper for this long, this many times. */
export const LOCAL_COPY_MAX_ATTEMPTS = 5;
const LOCAL_COPY_RETRY_WINDOW = '7 days';

/** Read lazily, never at module scope — `bun run build` has no env at all. */
export function aaiFromBlobFlagOn(): boolean {
  const raw = process.env[AAI_FROM_BLOB_FLAG_ENV];
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** What the route knows about one blob-transit session. */
export interface BlobFastPathInput {
  /** True for a part of a multi-file group. */
  multi: boolean;
  /** `UploadSpec.recorderRecordingId`, or the placeholder's recorder marker. */
  fromRecorder: boolean;
  /**
   * `UploadSpec.tracks` — what the client said its audio tracks are. Only the
   * tray sends it; null/absent for everyone else (and for every tray before
   * 0.3.12).
   */
  tracks: UploadTracks | null;
  /** The session's whole-file sha256 (a blob session always has one). */
  sha256: string | null;
  size: number;
  /** The name the stored file will take — `audioFilename(meetingId, original)`. */
  storedFilename: string;
}

/**
 * Why this upload may NOT take the fast path, or null when it may. Pure, so
 * the rules are testable without a store, a row or an account.
 *
 * **The multi-track rule (DEC-1).** A multi-track file handed over as-is is
 * transcribed from whichever track the decoder picks — the incident of
 * 2026-09-16, where a Slack huddle came back with 484 words instead of 1429
 * because only the system track was heard. Whether a file is multi-track
 * cannot be known without probing the bytes, and the whole point of this stage
 * is not to have the bytes; the tray is the only producer of such files and it
 * identifies itself on every upload (`recorderRecordingId` at open, or
 * `gmeet_context.recorder`).
 *
 * So the tray has to SAY so. Since 0.3.12 it writes the mix itself, live, as
 * audio track 0 of every file (`LiveMix.swift`) and declares
 * `tracks: {count, mixFirst: true}` at open — per file, off the registry row
 * the recording controller wrote, never off its own version, because older
 * recordings are still on that Mac. With that promise there is nothing left
 * for the VM to do to the audio and the upload may take the fast path; without
 * it — an older tray, a recording whose mix could not hear every source, any
 * client that says nothing — the refusal stands and the pull path mixes the
 * file down exactly as it always has. The promise is checked once the bytes
 * land (`fetchLocalCopy`), which is the earliest moment anyone can.
 */
export function blobFastPathRefusal(i: BlobFastPathInput): string | null {
  if (i.multi) return 'a multi-file group is stitched on the VM first';
  if (i.fromRecorder && i.tracks?.mixFirst !== true) {
    return 'a Darth Recorder upload may be multi-track and this one does not declare tracks.mixFirst (DEC-1)';
  }
  if (!i.sha256) return 'the session has no verified sha256';
  if (!(i.size > 0)) return 'the session has no size';
  if (i.storedFilename.endsWith('.bin')) {
    // `audioFilename` could not recover an extension, so the stored name would
    // have to be SNIFFED from the bytes — which we deliberately do not have.
    // Taking the fast path anyway would name the blob differently from what
    // the archive later computes and leave it unadoptable.
    return 'the file extension is unknown (it would have to be sniffed)';
  }
  return null;
}

/** Everything the copy + the hand-off need, all derived before a byte moves. */
export interface BlobIngestPlan {
  /** The permanent blob: `<recording id>/<media id><.ext>` (Stage A's name). */
  blobName: string;
  recordingId: string;
  mediaId: string;
  /** The name the local copy will take in `storage/audio/`. */
  filename: string;
  sha256: string;
  bytes: number;
}

export type BlobIngestPlanResult =
  | { ok: true; plan: BlobIngestPlan; store: MediaBlobLike; transit: BlobLike }
  | { ok: false; reason: string };

/**
 * Can this session skip the VM, and if so where does everything go?
 *
 * The ids are all deterministic, which is what makes them knowable BEFORE the
 * row exists: the placeholder's `transcripts.id` is the recording's canonical
 * key (`t<id>`, unchanged by a minted promotion), the canonical media id is
 * `media:<recording>:canonical:0`, and the meeting id a minted promotion lands
 * on is the placeholder's own uuid. If any of that turns out differently
 * (the stale-upload sweeper reaped the placeholder mid-flight), the STAMP is
 * what decides — a media row may name any blob — and the only thing lost is
 * the archive's ability to adopt an unstamped blob by name.
 */
export async function planBlobIngest(
  userId: string,
  session: { placeholder_id: string; sha256: string | null; size: number; spec: UploadSpec }
): Promise<BlobIngestPlanResult> {
  if (!aaiFromBlobFlagOn()) return { ok: false, reason: `${AAI_FROM_BLOB_FLAG_ENV} is off` };
  // Design P7: a born-bare upload has no meeting row to promote — it takes
  // the pull path and its own hand-off (lib/server/born-bare.ts).
  if (session.spec.bornBare) return { ok: false, reason: 'a born-bare recording (pull path)' };
  // The archive flag too: the background fetch may faststart-remux the file
  // and must then be allowed to replace the blob, otherwise a remuxed video
  // would keep its pre-remux bytes in blob for good.
  const store = archiveStore();
  if (!store) return { ok: false, reason: 'no media account on this host, or MW_MEDIA_ARCHIVE is off' };
  const transit = uploadsStore();
  if (!transit) return { ok: false, reason: 'no transit account on this host' };
  if (!recordingsWriteEnabled()) return { ok: false, reason: 'MW_RECORDINGS_WRITE is off' };
  if (!(await mintedIdsEnabled().catch(() => false))) {
    return { ok: false, reason: 'minted ids are off (migration 045) — the blob name would move' };
  }

  const row = await getForUser(userId, session.placeholder_id).catch(() => null);
  if (!row) return { ok: false, reason: 'the placeholder row is gone' };

  // The meeting id a minted promotion produces, and the file it will name.
  const meetingId = session.placeholder_id.replace(/^up-/, '');
  const filename = audioFilename(meetingId, session.spec.originalFilename);
  const refusal = blobFastPathRefusal({
    multi: !!session.spec.multi,
    fromRecorder: !!session.spec.recorderRecordingId || !!row.gmeet_context?.recorder,
    tracks: session.spec.tracks ?? null,
    sha256: session.sha256,
    size: session.size,
    storedFilename: filename,
  });
  if (refusal) return { ok: false, reason: refusal };

  // Permanent bytes never go into a container something is deleting from
  // (Stage A.4). A gate that cannot be evaluated at all (047 missing) is a
  // refusal, not a crash.
  let gate;
  try {
    gate = await canaryGate(store);
  } catch (err) {
    return { ok: false, reason: `canary check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const recordingId = recordingIdFor(`t${row.id}`);
  const mediaId = mediaIdFor(recordingId, 'canonical', 0);
  return {
    ok: true,
    store,
    transit,
    plan: {
      blobName: mediaBlobName(recordingId, mediaId, filename),
      recordingId,
      mediaId,
      filename,
      sha256: session.sha256!,
      bytes: session.size,
    },
  };
}

// ---------------------------------------------------------------------------
// The intent, and what a dead session leaves behind
// ---------------------------------------------------------------------------

/** The plan, reduced to the four things a cleanup needs to know. */
export function blobIntentOf(plan: BlobIngestPlan): BlobCopyIntent {
  return {
    blobName: plan.blobName,
    recordingId: plan.recordingId,
    mediaId: plan.mediaId,
    at: new Date().toISOString(),
  };
}

/** Everything the decision below is allowed to look at. */
export interface AbandonedBlobInput {
  /** `upload_sessions.spec.blobIntent` — absent when Stage C never started. */
  intent: BlobCopyIntent | null | undefined;
  /** Blob names LIVE `recording_media` rows claim (`claimedMediaBlobNames`). */
  claimed: readonly string[];
}

/**
 * A session is being reaped: is there a blob in the permanent media container
 * that nothing will ever name again?
 *
 * The one leak Stage C shipped with. `copyTransitToMedia` puts the bytes at a
 * deterministic name and the row that refers to them
 * (`recording_media.blob_name`) is written afterwards, so a crash in between —
 * a pm2 restart mid-ingest is the ordinary way this happens, and it leaves the
 * session stuck at `completing` — stranded the bytes: the blob's name existed
 * only inside a promise that died with the process. The INTENT is that name,
 * written down before the copy.
 *
 * Two rules, and the second is the one that matters:
 *
 *  - no intent, nothing to do. A chunk session, a pull-path session, or a
 *    Stage C attempt that finished and cleared its stamp.
 *  - an intent whose blob a live media row CLAIMS is not abandoned — it is the
 *    recording. This is the crash-after-the-row case (the row was created, the
 *    clear never ran), and deleting there would destroy a meeting's only copy
 *    of itself. `claimed` is asked of the database at sweep time, never
 *    inferred from the session's own status: the session says nothing
 *    trustworthy about a row a later promotion may have moved.
 *
 * Pure, so the rule is testable without a store, a row or an account.
 */
export function abandonedBlobOf(i: AbandonedBlobInput): BlobCopyIntent | null {
  const intent = i.intent;
  if (!intent?.blobName) return null;
  if (i.claimed.includes(intent.blobName)) return null;
  return intent;
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

/** A plan whose bytes are in the permanent container, with a URL AAI can read. */
export interface BlobIngestSource extends BlobIngestPlan {
  /** A read SAS on the MEDIA blob. Never log it, never store it. */
  sasUrl: string;
  expiresAt: string;
}

export type CopyOutcome =
  | { ok: true; source: BlobIngestSource; ms: number }
  | { ok: false; error: string };

/**
 * Transit → permanent, server-side, then verified and handed a read SAS.
 *
 * The verify is size + the sha256 we STAMP as metadata — the same rule Stage A
 * settled on, because Azure will not hash a blob for us. The size was already
 * proven against the committed transit blob by the caller; the HASH is the
 * client's claim until the background fetch reads the bytes back and checks it
 * (`fetchLocalCopy`), which is the one verification this stage moves rather
 * than keeps.
 *
 * A failure leaves nothing behind: the half-written blob is deleted (it is at
 * a deterministic name no row points at yet) and the caller falls back to the
 * pull path, whose transit blob is still there because Stage C deletes it only
 * after the row exists.
 */
export async function copyTransitToMedia(
  store: MediaBlobLike,
  transit: BlobLike,
  transitBlobName: string,
  plan: BlobIngestPlan
): Promise<CopyOutcome> {
  const started = Date.now();
  try {
    // Azure's copy engine authenticates to the SOURCE with this SAS (the
    // destination is authorised by our own managed identity). Cross-account
    // copy has no other route: an identity token is not accepted for the
    // source of `Put Block From URL` here.
    const source = await createDownloadSas(transit, {
      blobName: transitBlobName,
      ttlMs: COPY_SOURCE_SAS_TTL_MS,
    });
    await store.copyFromUrl(plan.blobName, source.url, plan.bytes, {
      contentType: mediaContentType(plan.filename),
      contentDisposition: 'inline',
    });
    await store.setMetadata(plan.blobName, { sha256: plan.sha256, kind: 'canonical' });
    const after = await store.properties(plan.blobName);
    if (!after || after.bytes !== plan.bytes || after.metadata.sha256 !== plan.sha256) {
      await store.delete(plan.blobName).catch(() => {});
      return {
        ok: false,
        error: `copy verify failed: blob reports ${after ? `${after.bytes} B / ${after.metadata.sha256 ?? 'no hash'}` : 'missing'}, expected ${plan.bytes} B / ${plan.sha256}`,
      };
    }
    const sas = await createDownloadSas(store, { blobName: plan.blobName, ttlMs: AAI_SAS_TTL_MS });
    return {
      ok: true,
      ms: Date.now() - started,
      source: { ...plan, sasUrl: sas.url, expiresAt: sas.expiresAt.toISOString() },
    };
  } catch (err) {
    await store.delete(plan.blobName).catch(() => {});
    return { ok: false, error: redactSasInText(err instanceof Error ? err.message : String(err)) };
  }
}

// ---------------------------------------------------------------------------
// The ingest
// ---------------------------------------------------------------------------

/**
 * The submit failed and NOTHING was created — no row was touched, no
 * placeholder promoted. The caller may therefore still take the pull path,
 * which can keep the bytes on disk as a visible Failed row and let the
 * ingest-retry sweeper have them (`keepFailedIngest`), which this path cannot:
 * there is no local file yet.
 */
export class BlobIngestFailed extends Error {
  constructor(
    readonly causeErr: unknown,
    message: string
  ) {
    super(message);
    this.name = 'BlobIngestFailed';
  }
}

/**
 * The Stage C twin of `ingestLocalAudio`: AssemblyAI reads the blob, the row
 * is created by the same two halves the local path uses, and the VM's own copy
 * is fetched afterwards.
 *
 * What it deliberately does NOT do, compared with the local path:
 *  - no `files.upload` (that is the point) and no multi-track mix-down (a
 *    recorder upload never reaches here — `blobFastPathRefusal`);
 *  - no `audio_url` on the row: ours would be a SAS;
 *  - no `prepareMediaForPlayback` yet — there is no file to prepare. The
 *    background fetch runs it when the bytes land.
 */
export async function ingestBlobAudio(
  userId: string,
  source: BlobIngestSource,
  opts: IngestOptions
): Promise<TranscriptRow> {
  let submitted;
  try {
    submitted = await submitForIngest(userId, source.sasUrl, opts);
  } catch (error) {
    const text = redactSasInText(error instanceof Error ? error.message : String(error));
    console.warn(`[aai-from-blob] submit failed, falling back to the pull path: ${text}`);
    throw new BlobIngestFailed(error, text);
  }

  const row = await createOrPromoteRow(userId, submitted, null, opts);
  await attachSeriesForRow(row);

  // The bytes exist — in Azure. The row names the file it WILL have locally so
  // the recording graph describes the canonical media (and Stage B can serve
  // it from the blob the moment the stamp lands); `blobFirst` is what tells
  // every other reader that the local copy is still on its way.
  const filename = audioFilename(row.assemblyai_id, opts.originalFilename);
  await setLocalAudioPathForUser(userId, row.assemblyai_id, filename);
  row.local_audio_path = filename;
  const marker: NonNullable<GmeetContext['blobFirst']> = {
    blobName: source.blobName,
    sha256: source.sha256,
    bytes: source.bytes,
    at: new Date().toISOString(),
    landedAt: null,
  };
  await mergeGmeetContextForUser(userId, row.assemblyai_id, { blobFirst: marker }, { quiet: true });

  queueRecordingGraphSync(userId, row.assemblyai_id, 'ingest/blob');
  stampArchivedAfterSync(userId, row.assemblyai_id, source);
  queueLocalCopyFromBlob({
    userId,
    meetingId: row.assemblyai_id,
    blobName: source.blobName,
    sha256: source.sha256,
    bytes: source.bytes,
    filename,
  });
  console.log(
    `[aai-from-blob] ${row.assemblyai_id}: job ${submitted.id} reads ${source.blobName} ` +
      `(${fmtBytes(source.bytes)}); the VM never touched the bytes`
  );
  return row;
}

/**
 * Write `blob_name` / `sha256` / `bytes` onto the canonical media row, once the
 * dual-write has created it — the same "after the sync" pattern the same-file
 * hash stamp uses, and for the same reason: `applyRecordingGraph` deliberately
 * never names those columns.
 *
 * The stamp is what makes the blob findable (Stage B reads it, permanent
 * delete reads it), so a failure here is an ERROR line naming the blob rather
 * than a silent shrug.
 */
function stampArchivedAfterSync(
  userId: string,
  meetingId: string,
  source: BlobIngestSource
): void {
  queueAfterRecordingSync(userId, meetingId, 'aai-from-blob/stamp', async () => {
    const recordingId = await recordingIdForMeeting(userId, meetingId);
    if (!recordingId) {
      console.error(`[aai-from-blob] ${meetingId}: no recording to stamp — ${source.blobName} is unreferenced`);
      return;
    }
    const mediaId = mediaIdFor(recordingId, 'canonical', 0);
    const stamped = await stampMediaArchived(mediaId, {
      blobName: source.blobName,
      sha256: source.sha256,
      bytes: source.bytes,
    });
    if (!stamped) {
      console.error(
        `[aai-from-blob] ${meetingId}: canonical media ${mediaId} is not there — ${source.blobName} is unreferenced`
      );
      return;
    }
    // Stage A.6: fills a NULL only. The upload pipeline's identity stamp
    // writes the same value from the other side and is the authority.
    await setRecordingSha256(recordingId, source.sha256).catch(() => false);
  });
}

// ---------------------------------------------------------------------------
// The background local copy
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  __mwBlobLocalCopyInflight?: Map<string, Promise<LocalCopyOutcome>>;
};
const inflight = (g.__mwBlobLocalCopyInflight ??= new Map<string, Promise<LocalCopyOutcome>>());

/** Fire-and-forget: fetch the VM's own copy. Never awaited, never throws. */
export function queueLocalCopyFromBlob(p: LocalCopyInput): void {
  void localCopyFromBlob(p).catch((err) =>
    console.warn(`[aai-from-blob] local copy ${p.meetingId} failed:`, redactSasInText(String(err)))
  );
}

export interface LocalCopyInput {
  userId: string;
  meetingId: string;
  blobName: string;
  sha256: string;
  bytes: number;
  filename: string;
}

export type LocalCopyOutcome =
  | { status: 'off' }
  | { status: 'landed'; bytes: number; ms: number; remuxed: boolean }
  | { status: 'already' }
  | { status: 'failed'; error: string };

/**
 * Serialised per meeting: the sweeper's retry must not race the first try, and
 * a second caller joins the one download instead of starting another. Never
 * rejects — every failure is an outcome.
 */
export function localCopyFromBlob(p: LocalCopyInput): Promise<LocalCopyOutcome> {
  const key = `${p.userId}|${p.meetingId}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run: Promise<LocalCopyOutcome> = fetchLocalCopy(p)
    .catch((err) => ({
      status: 'failed' as const,
      error: redactSasInText(err instanceof Error ? err.message : String(err)),
    }))
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

/**
 * Pull the permanent blob down to `storage/audio/<filename>`, hash-verified,
 * then run the local-only work the ingest normally does inline.
 *
 * `pullBlob`'s semantics with ONE deliberate difference: it deletes the blob
 * on a hash mismatch ("never adopt bytes that are not the file"), which is
 * right for a transit blob and catastrophic for the permanent one — these are
 * the bytes AssemblyAI is transcribing and the only copy we have. So a
 * mismatch here keeps the blob, keeps the file, corrects the hashes to what
 * the bytes actually are, and says so loudly: the client's claimed sha256 was
 * wrong, which only ever mattered to the duplicate check.
 */
async function fetchLocalCopy(p: LocalCopyInput): Promise<LocalCopyOutcome> {
  const store = mediaStore();
  if (!store) return { status: 'off' };
  const started = Date.now();
  await ensureAudioDir();

  const existing = await fsp.stat(resolveAudioPath(p.filename)).catch(() => null);
  if (existing?.isFile() && existing.size === p.bytes) {
    await stampLanded(p, { remuxed: false });
    return { status: 'already' };
  }

  const temp = `blobfetch-${randomUUID()}.part`;
  const tempAbs = resolveAudioPath(temp);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const reader = (await store.read(p.blobName)).getReader();
    const ws = createWriteStream(tempAbs, { flags: 'w' });
    const writer = (Writable.toWeb(ws) as unknown as WritableStream<Uint8Array>).getWriter();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        bytes += value.byteLength;
        hash.update(value);
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      await reader.cancel().catch(() => {});
      await writer.abort().catch(() => {});
      throw err;
    }
  } catch (err) {
    await deleteAudioFile(temp);
    const error = redactSasInText(err instanceof Error ? err.message : String(err));
    await stampLocalCopyFailure(p, error);
    return { status: 'failed', error };
  }

  const digest = hash.digest('hex');
  if (bytes !== p.bytes) {
    await deleteAudioFile(temp);
    const error = `blob is ${bytes} B, the row says ${p.bytes} B`;
    console.error(`[aai-from-blob] ${p.meetingId}: ${error} — the local copy was not kept`);
    await stampLocalCopyFailure(p, error);
    return { status: 'failed', error };
  }
  await renameAudioFile(temp, p.filename);
  if (digest !== p.sha256) {
    console.error(
      `[aai-from-blob] SHA MISMATCH ${p.meetingId}: the upload claimed ${p.sha256.slice(0, 12)}…, ` +
        `the bytes AssemblyAI is reading hash to ${digest.slice(0, 12)}… — correcting the row and the blob`
    );
    await correctHash(p, digest).catch((err) =>
      console.warn(`[aai-from-blob] ${p.meetingId}: correcting the hash failed:`, err)
    );
  }

  // The file exists now, so the graph can fill in its bytes, and the local-only
  // preparation can run. Faststart FIRST and awaited, because it rewrites the
  // file in place — after which the blob is no longer these bytes.
  queueRecordingGraphSync(p.userId, p.meetingId, 'aai-from-blob/landed');
  // The declared track order, checked against the bytes at last (see verifyMixFirst).
  let remuxed = await verifyMixFirst(p);
  const fast = await ensureFaststart(p.filename).catch((err) => ({
    status: 'error' as const,
    error: String(err),
  }));
  if (fast.status === 'remuxed' || remuxed) {
    remuxed = true;
    await reArchiveAfterRemux(p).catch((err) =>
      console.warn(`[aai-from-blob] ${p.meetingId}: re-archive after the remux failed:`, err)
    );
  }
  // The rest of the usual preparation (the audio-only extract + the media
  // marker); faststart is a no-op inside it now. Imported HERE rather than at
  // the top: `media-sweeper` imports this module for its retry pass, and a
  // static cycle between two modules Next bundles per route graph is not worth
  // the risk for one call.
  const { prepareMediaForPlayback } = await import('@/lib/server/media-sweeper');
  prepareMediaForPlayback(p.userId, p.meetingId);
  await stampLanded(p, { remuxed });

  const ms = Date.now() - started;
  console.log(
    `[aai-from-blob] ${p.meetingId}: local copy landed, ${fmtBytes(bytes)} in ${(ms / 1000).toFixed(1)}s` +
      (remuxed ? ' (faststart remuxed → re-archived)' : '')
  );
  return { status: 'landed', bytes, ms, remuxed };
}

/**
 * The bytes AssemblyAI is reading, checked at last: is audio track 0 really
 * the mix?
 *
 * Taking the fast path with a multi-track file rests on a CLIENT's promise
 * (`tracks.mixFirst`, DEC-1) and this is the first moment anyone here can look
 * at the file itself. Normally the probe says yes and there is nothing to do —
 * the stored file's track order is already what `normalizeMultiTrack` would
 * have produced, so the pass is SKIPPED rather than run to no effect.
 *
 * A no: the promise was wrong (a tray bug, a file the recorder did not write).
 * The transcript is already being made from whichever track the decoder picked
 * and cannot be helped from here, but the file people will play, re-transcribe
 * and cut clips from can be, so the ordinary mix-down runs on it — which
 * rewrites the file, exactly like a faststart remux, hence the `true` return
 * that makes the caller re-archive. Loud, because it means a client is lying
 * to the fast path.
 *
 * Never throws: ffprobe/ffmpeg trouble leaves the file as it is.
 */
async function verifyMixFirst(p: LocalCopyInput): Promise<boolean> {
  let streams;
  try {
    streams = await probeAudioStreams(p.filename);
  } catch (err) {
    console.warn(`[aai-from-blob] ${p.meetingId}: could not probe the landed copy:`, err);
    return false;
  }
  if (streams.length < 2) return false;
  if (isMixTrack(streams[0])) {
    console.log(
      `[aai-from-blob] ${p.meetingId}: ${streams.length} audio tracks, track 0 is the mix as declared — nothing to normalise`
    );
    return false;
  }
  console.error(
    `[aai-from-blob] ${p.meetingId}: DECLARED mixFirst but the landed file's track 0 is not the mix ` +
      `(${streams.length} audio tracks, lang ${streams[0].language ?? '?'}) — AssemblyAI heard one track; ` +
      `mixing the stored file down so playback and any re-transcribe are whole`
  );
  try {
    const mt = await normalizeMultiTrack(p.filename);
    if (mt.mixed) await deleteAudioFile(mt.aaiSource).catch(() => {});
    return mt.mixed;
  } catch (err) {
    console.warn(`[aai-from-blob] ${p.meetingId}: the repair mix failed:`, err);
    return false;
  }
}

/**
 * The faststart pass rewrote the canonical file, so the archived blob is not
 * the file any more. Forget the stamp and let the ordinary archive copy the
 * REMUXED file up, replacing the blob under the same deterministic name —
 * which is the invariant everything downstream leans on: what a media row says
 * about its blob is true of the file that row names.
 *
 * Refused (and left alone) in the two cases where clearing would make things
 * worse: a host that is not archiving at all would simply lose the blob
 * pointer, and a row whose blob is NOT at the deterministic name would strand
 * that blob.
 */
async function reArchiveAfterRemux(p: LocalCopyInput): Promise<void> {
  if (!archiveStore()) {
    console.warn(
      `[aai-from-blob] ${p.meetingId}: faststart rewrote the file but MW_MEDIA_ARCHIVE is off — ` +
        `${p.blobName} still holds the pre-remux bytes`
    );
    return;
  }
  const recordingId = await recordingIdForMeeting(p.userId, p.meetingId);
  if (!recordingId) return;
  const mediaId = mediaIdFor(recordingId, 'canonical', 0);
  const row = await getRecordingMediaRow(mediaId);
  if (!row?.blob_name || !row.filename) return;
  const deterministic = mediaBlobName(row.recording_id, row.id, row.filename);
  if (row.blob_name !== deterministic) {
    console.warn(
      `[aai-from-blob] ${p.meetingId}: ${row.blob_name} is not the name the archive would use — ` +
        'leaving it as it is rather than stranding it'
    );
    return;
  }
  if (!(await clearMediaArchiveStamp(row.id, row.blob_name))) return;
  const fresh = await getRecordingMediaRow(mediaId);
  if (!fresh) return;
  const outcome = await archiveMedia(fresh);
  if (outcome.status === 'failed') {
    console.warn(`[aai-from-blob] ${p.meetingId}: re-archive failed: ${outcome.error}`);
  }
}

/** The bytes are not what the client said: make the row and the blob honest. */
async function correctHash(p: LocalCopyInput, observed: string): Promise<void> {
  const store = mediaStore();
  const recordingId = await recordingIdForMeeting(p.userId, p.meetingId);
  if (!recordingId) return;
  const mediaId = mediaIdFor(recordingId, 'canonical', 0);
  await stampMediaArchived(mediaId, { blobName: p.blobName, sha256: observed, bytes: p.bytes });
  await store?.setMetadata(p.blobName, { sha256: observed, kind: 'canonical' }).catch(() => {});
}

async function stampLanded(p: LocalCopyInput, o: { remuxed: boolean }): Promise<void> {
  const row = await getForUser(p.userId, p.meetingId).catch(() => null);
  const prev = row?.gmeet_context?.blobFirst;
  if (!prev) return;
  await mergeGmeetContextForUser(
    p.userId,
    p.meetingId,
    {
      blobFirst: {
        ...prev,
        landedAt: new Date().toISOString(),
        ...(o.remuxed ? { remuxed: true } : {}),
      },
    },
    { quiet: true }
  ).catch(() => {});
}

async function stampLocalCopyFailure(p: LocalCopyInput, error: string): Promise<void> {
  const row = await getForUser(p.userId, p.meetingId).catch(() => null);
  const prev = row?.gmeet_context?.blobFirst;
  if (!prev) return;
  await mergeGmeetContextForUser(
    p.userId,
    p.meetingId,
    { blobFirst: { ...prev, error: error.slice(0, 300), attempts: (prev.attempts ?? 0) + 1 } },
    { quiet: true }
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// The sweeper's retry
// ---------------------------------------------------------------------------

interface BlobFirstRow {
  user_id: string;
  assemblyai_id: string;
  local_audio_path: string | null;
  gmeet_context: GmeetContext | null;
}

/**
 * Rows whose bytes went to AssemblyAI from the blob and whose local copy never
 * landed. Recent only: a row older than the retry window is a job for Stage D's
 * `ensureLocal`, not for this, and the pass must never turn into a re-download
 * of the whole archive once `storage/` is drained.
 */
async function listPendingLocalCopies(limit: number): Promise<BlobFirstRow[]> {
  return sql<BlobFirstRow[]>`
    SELECT user_id, assemblyai_id, local_audio_path, gmeet_context
    FROM ${sql(SCHEMA)}.transcripts
    WHERE deleted_at IS NULL
      AND gmeet_context->'blobFirst' IS NOT NULL
      AND gmeet_context->'blobFirst'->>'landedAt' IS NULL
      AND created_at > now() - ${LOCAL_COPY_RETRY_WINDOW}::interval
      AND COALESCE((gmeet_context->'blobFirst'->>'attempts')::int, 0) < ${LOCAL_COPY_MAX_ATTEMPTS}
    ORDER BY created_at
    LIMIT ${limit}
  `;
}

/**
 * The media sweeper's Stage C pass: finish the local copies that did not.
 * Inert — not one query — unless the flag and the account are both there.
 */
export async function sweepPendingLocalCopies(limit: number): Promise<number> {
  if (!aaiFromBlobFlagOn() || !mediaStore()) return 0;
  const rows = await listPendingLocalCopies(limit);
  let done = 0;
  for (const row of rows) {
    const marker = row.gmeet_context?.blobFirst;
    const filename = row.local_audio_path;
    if (!marker?.blobName || !marker.sha256 || !filename) continue;
    const outcome = await localCopyFromBlob({
      userId: row.user_id,
      meetingId: row.assemblyai_id,
      blobName: marker.blobName,
      sha256: marker.sha256,
      bytes: marker.bytes,
      filename,
    });
    if (outcome.status === 'landed' || outcome.status === 'already') done += 1;
    else if (outcome.status === 'failed') {
      console.warn(`[aai-from-blob] retry for ${row.assemblyai_id} failed: ${outcome.error}`);
    }
  }
  return done;
}
