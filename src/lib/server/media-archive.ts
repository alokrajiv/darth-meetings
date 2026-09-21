import 'server-only';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { getAudioOnlyPath } from '@/lib/server/audio-only';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import {
  mediaBlobName,
  mediaContentType,
  mediaStore,
  type MediaBlobLike,
} from '@/lib/server/media-store';
import {
  clearPendingBlobDelete,
  insertMediaCanary,
  listClipsForMeeting,
  listMediaBlobsForRecordings,
  listMediaCanaries,
  listPendingBlobDeletes,
  listRecordingMedia,
  markMediaCanaryMissing,
  markMediaCanarySeen,
  markPendingBlobDeleteFailed,
  queueBlobDeletes,
  setRecordingSha256,
  stampMediaArchived,
  type ArchivedBlobRef,
  type RecordingMediaRow,
} from '@/db-ops/recordings';

/**
 * Stage A of DEC-3 — the ARCHIVE (docs/recordings-blob-spec.md).
 *
 * Durability first, zero reader change: every file we hold on the VM gets a
 * copy in the permanent media container, verified and stamped onto its
 * `recording_media` row (`blob_name`, `sha256`, `bytes`). Nothing reads the
 * blob yet — that is Stage B — and **the local file is never deleted here**.
 * Until Stage D drains `storage/`, both copies exist on purpose.
 *
 * Two gates, both lazy, both off by default:
 *  - `DARTH_MEDIA_ACCOUNT` unset → `mediaStore()` is null → every function
 *    below returns `off` before it touches the database. A laptop, a build,
 *    a test that does not opt in: zero queries, zero network.
 *  - `MW_MEDIA_ARCHIVE` unset/`0` → configured but not archiving (the account
 *    can be provisioned and the code deployed days apart).
 * Blob DELETES are gated on the store alone: once bytes are up there they must
 * be removable even with archiving switched off.
 *
 * The write order is the whole design: upload → set the sha256/kind metadata →
 * re-read the blob's size + metadata → only then stamp the row. A stamped row
 * therefore means "Azure has confirmed these exact bytes", which is what makes
 * Stage D's eviction safe later. A crash anywhere before the stamp leaves the
 * row unstamped and the next pass redoes it; a block-blob upload commits
 * nothing until its block list is committed, so an interrupted upload leaves
 * uncommitted blocks and no readable blob.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const MEDIA_ARCHIVE_FLAG_ENV = 'MW_MEDIA_ARCHIVE';

/** A canary must be at least this old before its absence means anything. */
export const CANARY_MIN_AGE_MS = 36 * 60 * 60 * 1000;
/** A fresh canary is written when the newest one is older than this. */
export const CANARY_WRITE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** The gate's answer is reused for this long rather than re-stat'ing per file. */
const CANARY_CACHE_MS = 15 * 60 * 1000;

/**
 * Read lazily, never at module scope: `bun run build` must succeed with no env
 * at all, and the flag is flipped by restarting the server.
 */
export function mediaArchiveFlagOn(): boolean {
  const raw = process.env[MEDIA_ARCHIVE_FLAG_ENV];
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

/** The store to archive INTO, or null when this host archives nothing. */
export function archiveStore(): MediaBlobLike | null {
  return mediaArchiveFlagOn() ? mediaStore() : null;
}

export type ArchiveOutcome =
  | { status: 'off' }
  | { status: 'skipped'; mediaId: string; reason: string }
  | { status: 'adopted'; mediaId: string; blobName: string; bytes: number; sha256: string }
  | {
      status: 'archived';
      mediaId: string;
      blobName: string;
      bytes: number;
      sha256: string;
      ms: number;
    }
  | { status: 'failed'; mediaId: string; blobName: string; error: string };

// globalThis, not module scope: Next bundles this module once per route graph,
// so a module-scope map would not serialise an archive started by the
// recording-sync hook against one started by the sweeper.
const g = globalThis as unknown as {
  __mwMediaArchiveInflight?: Map<string, Promise<ArchiveOutcome>>;
  __mwMediaArchiveCanary?: { at: number; gate: CanaryGate };
};
const inflight = (g.__mwMediaArchiveInflight ??= new Map<string, Promise<ArchiveOutcome>>());

/**
 * Where a media row's bytes are on this VM. `audio_only` extracts live in
 * `storage/audio-only/`, everything else directly under `storage/audio/`;
 * both paths run through `resolveAudioPath`'s unsafe-name guard. Null = the
 * stored name is not one we will touch.
 */
export function localMediaPath(row: Pick<RecordingMediaRow, 'kind' | 'filename'>): string | null {
  if (!row.filename) return null;
  try {
    return row.kind === 'audio_only' ? getAudioOnlyPath(row.filename) : resolveAudioPath(row.filename);
  } catch {
    return null;
  }
}

/** sha256 of a local file, streamed (never read whole into memory). */
async function sha256OfFile(abs: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(abs, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// The lifecycle canary (spec Stage A.4)
// ---------------------------------------------------------------------------

export type CanaryGate = { ok: true; canary: string | null } | { ok: false; reason: string };

/** A tiny text blob whose whole job is to still be there tomorrow. */
function canaryBody(name: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    `darth-meetings media archive canary\n${name}\nwritten ${new Date().toISOString()}\n` +
      'If this blob disappears, a lifecycle rule is eating the archive. Do not delete it.\n'
  );
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/**
 * Ensure a canary exists, then check that the OLDEST one that is at least 36 h
 * old is still in the container. Gone = a lifecycle rule (or a person) is
 * deleting blobs nobody has touched, which is exactly what would silently eat
 * the archive — so archiving stops until a human clears `missing_at`.
 *
 * Within the first 36 h of enabling there is no canary old enough to prove
 * anything yet, and the gate passes: that window is the price of the check.
 * The answer is cached per process for CANARY_CACHE_MS so a 5-file tick costs
 * one `properties` call, not five.
 */
export async function canaryGate(store: MediaBlobLike, now = Date.now()): Promise<CanaryGate> {
  const cached = g.__mwMediaArchiveCanary;
  if (cached && now - cached.at < CANARY_CACHE_MS) return cached.gate;
  const gate = await evaluateCanary(store, now);
  g.__mwMediaArchiveCanary = { at: now, gate };
  return gate;
}

/** Tests / the sweeper after a failure: drop the cached gate answer. */
export function resetCanaryCache(): void {
  g.__mwMediaArchiveCanary = undefined;
}

async function evaluateCanary(store: MediaBlobLike, now: number): Promise<CanaryGate> {
  const canaries = await listMediaCanaries();
  const missing = canaries.find((c) => c.missing_at);
  if (missing) {
    return {
      ok: false,
      reason: `CANARY GONE — ${missing.name} vanished from the container (noticed ${missing.missing_at}). A lifecycle rule is deleting untouched blobs; archiving is stopped.`,
    };
  }

  const newest = canaries.at(-1);
  if (!newest || now - Date.parse(newest.written_at) > CANARY_WRITE_EVERY_MS) {
    const name = `_canary/${new Date(now).toISOString().slice(0, 10)}`;
    if (!canaries.some((c) => c.name === name)) {
      await store.putStream(name, canaryBody(name), { contentType: 'text/plain; charset=utf-8' });
      await insertMediaCanary(name);
      console.log(`[media-archive] canary written: ${name}`);
    }
  }

  const oldEnough = canaries.filter((c) => now - Date.parse(c.written_at) >= CANARY_MIN_AGE_MS);
  const probe = oldEnough[0];
  if (!probe) return { ok: true, canary: null }; // still inside the first 36 h
  const props = await store.properties(probe.name);
  if (!props) {
    await markMediaCanaryMissing(probe.name);
    console.error(
      `[media-archive] CANARY GONE — ${probe.name} (written ${probe.written_at}) is no longer in the container. Archiving stops.`
    );
    return {
      ok: false,
      reason: `CANARY GONE — ${probe.name} (written ${probe.written_at}) is no longer in the container.`,
    };
  }
  await markMediaCanarySeen(probe.name);
  return { ok: true, canary: probe.name };
}

// ---------------------------------------------------------------------------
// archiveMedia
// ---------------------------------------------------------------------------

/**
 * Copy ONE media row's bytes to its blob and stamp the row. Idempotent and
 * serialised per media id: a second call while the first is in flight joins
 * it, and a call on an already-stamped row is a no-op that costs nothing but
 * the flag read.
 */
export function archiveMedia(row: RecordingMediaRow): Promise<ArchiveOutcome> {
  const existing = inflight.get(row.id);
  if (existing) return existing;
  const run = archiveMediaOnce(row).finally(() => {
    if (inflight.get(row.id) === run) inflight.delete(row.id);
  });
  inflight.set(row.id, run);
  return run;
}

async function archiveMediaOnce(row: RecordingMediaRow): Promise<ArchiveOutcome> {
  const store = archiveStore();
  if (!store) return { status: 'off' };
  const mediaId = row.id;

  // Already proven: `blob_name` is only ever written after the blob agreed
  // with us about size and hash.
  if (row.blob_name && row.sha256) {
    return { status: 'skipped', mediaId, reason: 'already archived' };
  }
  if (!row.filename) return { status: 'skipped', mediaId, reason: 'row names no file' };
  const abs = localMediaPath(row);
  if (!abs) return { status: 'skipped', mediaId, reason: `unsafe stored name ${row.filename}` };
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) {
    return { status: 'skipped', mediaId, reason: 'no local file to archive' };
  }
  if (st.size === 0) return { status: 'skipped', mediaId, reason: 'local file is empty' };

  // A gate that cannot even be evaluated (migration 047 not applied on this
  // schema) is a refusal, not a crash: the flag is on, the tables are not
  // there, and every upload would otherwise log a stack trace.
  let gate: CanaryGate;
  try {
    gate = await canaryGate(store);
  } catch (err) {
    return {
      status: 'skipped',
      mediaId,
      reason: `canary check failed (is migrations/047_media_archive.sql applied?): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!gate.ok) return { status: 'skipped', mediaId, reason: gate.reason };

  const blobName = mediaBlobName(row.recording_id, mediaId, row.filename);
  const started = Date.now();

  // Adopt: a blob of the right size may be the last run's, finished but never
  // stamped (a pm2 restart between the upload and the UPDATE). Hashing the
  // local file costs one read and saves the whole upload.
  const before = await store.properties(blobName).catch(() => null);
  if (before && before.bytes === st.size && before.metadata.sha256) {
    const local = await sha256OfFile(abs);
    if (local === before.metadata.sha256) {
      await stampArchived(row, blobName, local, st.size);
      return { status: 'adopted', mediaId, blobName, bytes: st.size, sha256: local };
    }
  }

  const hash = createHash('sha256');
  let read = 0;
  const body = (
    Readable.toWeb(
      createReadStream(abs, { highWaterMark: 1024 * 1024 })
    ) as unknown as ReadableStream<Uint8Array>
  ).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        hash.update(chunk);
        read += chunk.byteLength;
        c.enqueue(chunk);
      },
    })
  );

  try {
    const { bytes } = await store.putStream(blobName, body, {
      contentType: mediaContentType(row.filename),
      contentDisposition: 'inline',
    });
    const sha256 = hash.digest('hex');
    if (bytes !== read || bytes !== st.size) {
      // The file changed under us (a re-transcribe renaming its source, an
      // ffmpeg remux). Leave the row unstamped; the next pass re-reads it.
      return {
        status: 'failed',
        mediaId,
        blobName,
        error: `size moved while uploading: stat ${st.size}, streamed ${read}, written ${bytes}`,
      };
    }
    // The hash is only known once the stream ends, so the metadata is a second
    // call — and the verify below is what makes the pair atomic for our
    // purposes: no stamp unless BOTH landed.
    await store.setMetadata(blobName, { sha256, kind: row.kind });
    const after = await store.properties(blobName);
    if (!after || after.bytes !== st.size || after.metadata.sha256 !== sha256) {
      return {
        status: 'failed',
        mediaId,
        blobName,
        error: `verify failed: blob reports ${after ? `${after.bytes} B / ${after.metadata.sha256 ?? 'no hash'}` : 'missing'}, expected ${st.size} B / ${sha256}`,
      };
    }
    await stampArchived(row, blobName, sha256, st.size);
    return { status: 'archived', mediaId, blobName, bytes: st.size, sha256, ms: Date.now() - started };
  } catch (err) {
    return {
      status: 'failed',
      mediaId,
      blobName,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The stamp, plus spec Stage A.6 as reconciled with the same-file check
 * (docs/recordings-same-file-spec.md): `recordings.sha256` is FILLED from the
 * canonical's hash, never overwritten (`setRecordingSha256` enforces that) —
 * the upload pipeline's value is the hash of the bytes the user handed us and
 * is the only one their file can reproduce, while this one is the file as it
 * sits on disk now (a video has been faststart-remuxed in place since).
 *
 * A DERIVED canonical — the ffmpeg concat of a stitched group — is skipped
 * entirely: its hash is the hash of nobody's file. The group's identity is
 * `sha256(part hashes joined by '\n')`, written by the upload pipeline, and
 * the concat's own bytes are recorded on its `recording_media` row like every
 * other archived file.
 */
async function stampArchived(
  row: RecordingMediaRow,
  blobName: string,
  sha256: string,
  bytes: number
): Promise<void> {
  await stampMediaArchived(row.id, { blobName, sha256, bytes });
  const derived = row.source_ref?.derived != null;
  if (row.kind === 'canonical' && !derived) await setRecordingSha256(row.recording_id, sha256);
}

/** Archive every file of one recording — canonical, parts and the extracts. */
export async function archiveRecording(recordingId: string): Promise<ArchiveOutcome[]> {
  if (!archiveStore()) return [{ status: 'off' }];
  const media = await listRecordingMedia([recordingId]);
  const out: ArchiveOutcome[] = [];
  for (const row of media) out.push(await archiveMedia(row));
  return out;
}

/**
 * The call the writers make: fire-and-forget, never awaited, never throws. A
 * user's upload must not wait for — or fail because of — a copy to Azure.
 */
export function queueMediaArchiveForRecording(recordingId: string, tag: string): void {
  if (!archiveStore()) return;
  void archiveRecording(recordingId)
    .then((outcomes) => {
      const done = outcomes.filter((o) => o.status === 'archived' || o.status === 'adopted');
      const failed = outcomes.filter((o) => o.status === 'failed');
      if (done.length > 0) {
        console.log(
          `[media-archive] ${tag} ${recordingId}: ${done.length} file(s) archived ` +
            `(${done.map((o) => ('bytes' in o ? fmtBytes(o.bytes) : '')).join(', ')})`
        );
      }
      for (const f of failed) {
        if (f.status === 'failed') {
          console.warn(`[media-archive] ${tag} ${recordingId} ${f.blobName}: ${f.error}`);
        }
      }
    })
    .catch((err) => console.warn(`[media-archive] ${tag} ${recordingId} failed:`, err));
}

export interface ArchiveBudget {
  maxFiles: number;
  maxBytes: number;
}

/**
 * The pacing rule of the backfill tick (spec Stage A.3), pure so it can be
 * reasoned about and tested on its own: stop once either cap is reached, and
 * never START a file that would push the tick past the byte cap — UNLESS it is
 * the first file of the tick, because a single 3 GB video larger than the whole
 * budget would otherwise never be archived at all.
 */
export function archiveBudgetVerdict(
  taken: { files: number; bytes: number },
  size: number,
  caps: ArchiveBudget
): 'take' | 'stop' {
  if (taken.files >= caps.maxFiles) return 'stop';
  if (taken.bytes >= caps.maxBytes) return 'stop';
  if (taken.files > 0 && taken.bytes + size > caps.maxBytes) return 'stop';
  return 'take';
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${n} B`;
}

// ---------------------------------------------------------------------------
// Deleting blobs whose rows are gone (spec Stage A.7)
// ---------------------------------------------------------------------------

/**
 * The blobs a meeting's recordings currently hold. Called BEFORE permanent
 * delete removes the rows — afterwards nothing knows the names any more.
 * Returns [] instantly when this host has no media account.
 */
export async function blobsHeldByMeeting(transcriptId: number): Promise<ArchivedBlobRef[]> {
  if (!mediaStore()) return [];
  const clips = await listClipsForMeeting(transcriptId);
  const recordingIds = [...new Set(clips.map((c) => c.recording_id))];
  if (recordingIds.length === 0) return [];
  return listMediaBlobsForRecordings(recordingIds);
}

/**
 * Delete the blobs of recordings that permanent delete actually removed —
 * never the ones it KEPT because another meeting still clips them (the shared
 * AssemblyAI job, landmine #14), and never on a soft delete.
 *
 * Order matters: the queue row is written FIRST, then the blob is deleted,
 * then the queue row is cleared. A crash between the two leaves a pending
 * delete the sweeper retries; the opposite order would lose the blob name for
 * good, because its media row no longer exists.
 */
export async function deleteBlobsForRemovedRecordings(
  refs: ArchivedBlobRef[],
  removedRecordingIds: string[],
  tag: string
): Promise<{ deleted: number; pending: number }> {
  const store = mediaStore();
  const removed = new Set(removedRecordingIds);
  const mine = refs.filter((r) => removed.has(r.recording_id));
  if (mine.length === 0) return { deleted: 0, pending: 0 };
  await queueBlobDeletes(mine);
  if (!store) return { deleted: 0, pending: mine.length };

  let deleted = 0;
  let pending = 0;
  for (const ref of mine) {
    try {
      await store.delete(ref.blob_name);
      await clearPendingBlobDelete(ref.blob_name);
      deleted += 1;
    } catch (err) {
      pending += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await markPendingBlobDeleteFailed(ref.blob_name, msg).catch(() => {});
      console.warn(`[media-archive] ${tag} delete of ${ref.blob_name} failed (queued for retry): ${msg}`);
    }
  }
  if (deleted > 0) console.log(`[media-archive] ${tag}: ${deleted} blob(s) deleted`);
  return { deleted, pending };
}

/** The sweeper's drain of `media_blob_deletes`. Inert with no media account. */
export async function drainPendingBlobDeletes(limit: number): Promise<{ deleted: number; failed: number }> {
  const store = mediaStore();
  if (!store) return { deleted: 0, failed: 0 };
  const rows = await listPendingBlobDeletes(limit);
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await store.delete(row.blob_name);
      await clearPendingBlobDelete(row.blob_name);
      deleted += 1;
    } catch (err) {
      failed += 1;
      await markPendingBlobDeleteFailed(
        row.blob_name,
        err instanceof Error ? err.message : String(err)
      ).catch(() => {});
    }
  }
  if (deleted > 0 || failed > 0) {
    console.log(`[media-archive] pending blob deletes: ${deleted} done, ${failed} still failing`);
  }
  return { deleted, failed };
}

// ---------------------------------------------------------------------------
// Pacing: is the VM busy with something the user is waiting for?
// ---------------------------------------------------------------------------

/**
 * The backfill must never compete with an ingest or an AI run (spec Stage
 * A.3). There is no shared "busy" flag in this app — `ai_runs` rows are only
 * written when a run FINISHES — so this reads the two signals that do exist:
 *
 *  - the DB: a row mid-upload/mid-transcription, or a notes / report /
 *    speaker-ID pass marked `running` recently. Time-bounded because those
 *    statuses get stuck when pm2 restarts mid-run (see `listNotesBacklog`) and
 *    a stuck row must not stop the archive forever.
 *  - this process: an ffmpeg transcode or a faststart remux in flight
 *    (`audio-only.ts` / `media-sweeper.ts` both keep their in-flight maps on
 *    globalThis, which is also how this module is reachable from either
 *    bundle).
 */
export async function archiveShouldYield(): Promise<string | null> {
  const local = globalThis as unknown as {
    __mwAudioOnlyInflight?: Map<string, unknown>;
    __mwMediaPrepInflight?: Map<string, unknown>;
  };
  if ((local.__mwAudioOnlyInflight?.size ?? 0) > 0) return 'an audio extract is running';
  if ((local.__mwMediaPrepInflight?.size ?? 0) > 0) return 'media prep is running';

  const rows = await sql<Array<{ ingesting: boolean; ai: boolean }>>`
    SELECT
      EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcripts
        WHERE deleted_at IS NULL
          AND status IN ('uploading', 'queued', 'processing')
          AND created_at > now() - interval '12 hours'
      ) AS ingesting,
      EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcripts
        WHERE deleted_at IS NULL
          AND (
            (auto_notes_status  = 'running' AND auto_notes_at  > now() - interval '30 minutes')
            OR (auto_report_status = 'running' AND auto_report_at > now() - interval '30 minutes')
            OR (speaker_id_status  = 'running' AND speaker_id_at  > now() - interval '30 minutes')
          )
      ) AS ai
  `;
  const r = rows[0];
  if (r?.ingesting) return 'an ingest is in flight';
  if (r?.ai) return 'an AI run is in flight';
  return null;
}
