import 'server-only';
import { promises as fsp } from 'node:fs';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { getAudioOnlyPath } from '@/lib/server/audio-only';
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
  type GraphFileFacts,
  type GraphMeetingRow,
} from '@/lib/recording-graph';
import {
  activeTranscriptionIdOf,
  applyMeetingClips,
  applyRecordingGraph,
  dropDerivativeMediaByFilename,
  loadGraphMeetingRows,
  recordingExists,
  removeMeetingFromRecordingGraph,
  stampTranscriptionProviderDeleted,
} from '@/db-ops/recordings';
import {
  blobsHeldByMeeting,
  deleteBlobsForRemovedRecordings,
  queueMediaArchiveForRecording,
} from '@/lib/server/media-archive';

/**
 * Dual-write: keep recordings / recording_media / recording_transcriptions /
 * meeting_clips equal to what the `transcripts` row says
 * (docs/recordings-phase1-spec.md §3, "Writers").
 *
 * ONE function does it. Every writer — ingest, the stitcher, the Meet/Teams
 * importers, the pollers, the derivative sweeper, delete — re-reads the row
 * it just wrote and hands it here; the desired graph is then derived with the
 * SAME rules the backfill uses (`lib/recording-graph.ts`) and applied
 * idempotently on deterministic ids. There is deliberately no "apply this
 * delta" API: a writer that forgets a field would silently desync, whereas
 * re-deriving the whole graph cannot.
 *
 * `MW_RECORDINGS_WRITE` gates it, separately from the readers' flag
 * `MW_RECORDINGS` so writes can be switched on first and soak. Unset/`0` =
 * today's behaviour, byte for byte, and not one new query.
 *
 * NOTE on turning the flag back OFF: writes stop, so the tables drift from
 * the rows (a permanently deleted meeting leaves its clips behind). Turning
 * it on again heals every row that is written afterwards; run
 * `scripts/recordings-verify.ts` to find the rest.
 *
 * Callers use `queueRecordingGraphSync` — fire-and-forget with a logged
 * catch. A user's upload must never fail, or wait, because a mirror table
 * could not be written.
 */

/**
 * Read lazily, never at module scope: `bun run build` must succeed with no
 * env at all, and the flag is flipped by restarting the server, not by
 * rebuilding.
 */
export function recordingsWriteEnabled(): boolean {
  const raw = process.env.MW_RECORDINGS_WRITE;
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

export type RecordingSyncResult =
  | { status: 'off' }
  | { status: 'skipped'; reason: string }
  | {
      status: 'written';
      recordingId: string;
      clips: number;
      media: number;
      migratedFrom: string[];
      staleMediaRemoved: number;
      /** Phase 3a: the meeting only CLIPS a recording somebody else owns, so
       * nothing but its clip rows was written. */
      borrowed?: true;
    };

// globalThis, not module scope: Next bundles this module once per route
// graph, so a module-scope map would not serialise a sync started in a route
// against one started from the instrumentation graph's pollers.
const g = globalThis as unknown as {
  __mwRecordingSyncInflight?: Map<string, Promise<RecordingSyncResult>>;
};
const inflight = (g.__mwRecordingSyncInflight ??= new Map<string, Promise<RecordingSyncResult>>());

/** Bytes on disk for the row's own files, and which extracts exist. */
async function probeFiles(row: GraphMeetingRow): Promise<GraphFileFacts> {
  const audio = new Map<string, number | null>();
  const audioOnly = new Map<string, number | null>();
  for (const name of recordingFilenames(row)) {
    let src: string;
    try {
      src = resolveAudioPath(name);
    } catch {
      continue; // an unsafe stored name: nothing on disk answers to it
    }
    const st = await fsp.stat(src).catch(() => null);
    if (st) audio.set(name, st.size);
    const extract = await fsp.stat(getAudioOnlyPath(name)).catch(() => null);
    if (extract && extract.size > 0) {
      audioOnly.set(name.replace(/\.[^./]+$/, ''), extract.size);
    }
  }
  return { audio, audioOnly };
}

/**
 * Re-derive and write one meeting's graph. Awaitable — used by the tests,
 * the verifier's `--fix`-less counterpart and anywhere a caller genuinely
 * wants the result. Production call sites use `queueRecordingGraphSync`.
 *
 * `userId` is always the OWNER of the meeting row (every writer here already
 * holds it); it selects which of the rows sharing an `assemblyai_id` is
 * "mine". The RECORDING is derived from whichever of them owns it.
 */
export async function syncRecordingGraphForMeeting(
  userId: string,
  assemblyaiId: string,
  opts?: { probeFiles?: boolean }
): Promise<RecordingSyncResult> {
  if (!recordingsWriteEnabled()) return { status: 'off' };

  const rows = await loadGraphMeetingRows(assemblyaiId);
  const me = rows.find((r) => r.user_id === userId);
  if (!me) return { status: 'skipped', reason: 'row is gone' };
  const why = skipReason(me);
  if (why) return { status: 'skipped', reason: why };

  // Only a meeting whose id IS an AssemblyAI job collapses two meetings onto
  // one recording — the pre-1b rows two people imported. A synthetic id
  // (`gmeet-<record>`) is identical for every importer by design but each of
  // them parsed their own copy, and a minted id (Phase 1b) is unique to one
  // meeting by construction, so both stay separate — `canonicalKeyOf` keys
  // them on `transcripts.id`.
  // Phase 3a: a meeting split off another one BORROWS the source's recording.
  // It has an id of its own, so deriving would mint a second recording over
  // the same bytes; it has declared clips, so doing nothing would let the next
  // sync heal it back to the whole file. Write its clips and stop.
  if (borrowsRecording(me)) {
    const clips = desiredClipsFor(me);
    const recordingId = clips[0]!.recordingId!;
    if (!(await recordingExists(recordingId))) {
      return { status: 'skipped', reason: `clipped recording ${recordingId} is gone` };
    }
    const out = await applyMeetingClips(me.id, clips, 'recording-sync');
    return {
      status: 'written',
      recordingId,
      clips: out.written,
      media: 0,
      migratedFrom: [],
      staleMediaRemoved: 0,
      borrowed: true,
    };
  }

  const owner = (isJobIdMeeting(me) ? ownerRowOf(rows) : me) ?? me;
  if (skipReason(owner)) return { status: 'skipped', reason: 'owner row is a placeholder' };

  const files = opts?.probeFiles === false ? undefined : await probeFiles(owner);
  // Which transcription the row describes is a question only the TABLE can
  // answer once a meeting has been re-transcribed (Phase 2): the live version
  // was minted, not derived, so re-deriving `txn:<rec>:0` here would point the
  // recording back at the version the user switched away from and overwrite
  // that version's payload with the current one. One indexed read.
  const activeTranscriptionId = await activeTranscriptionIdOf(
    recordingIdFor(canonicalKeyOf(owner))
  ).catch(() => null);
  const graph = deriveRecordingGraph(owner, files, { activeTranscriptionId });

  // The owner's own clip is written too when someone else triggered this, so
  // a shared job converges from whichever side is touched first. Both come
  // from `desiredClipsFor`, which honours the row's declared windows — that
  // is what stops a re-derivation healing a SPLIT meeting back to one clip
  // over the whole recording (docs/recordings-phase3-clips-spec.md).
  const clips = [...desiredClipsFor(me), ...(owner.id === me.id ? [] : desiredClipsFor(owner))];
  const applied = await applyRecordingGraph({ graph, clips, createdBy: 'recording-sync' });

  // DEC-3 Stage A: the files this sync has just described get their permanent
  // copy in Azure Blob. Fire-and-forget and inert unless both
  // DARTH_MEDIA_ACCOUNT and MW_MEDIA_ARCHIVE are set — see media-archive.ts.
  queueMediaArchiveForRecording(applied.recordingId, 'recording-sync');

  return {
    status: 'written',
    recordingId: applied.recordingId,
    clips: clips.length,
    media: applied.mediaWritten,
    migratedFrom: applied.migratedFrom,
    staleMediaRemoved: applied.staleMediaRemoved,
  };
}

/**
 * The call every writer makes: never awaited, never throws, one log line
 * when something interesting happened (a promotion, a stale file dropped) or
 * when it failed.
 *
 * Concurrent syncs of the same meeting are serialised — two writers touching
 * one row (the poller stamping a part while a fetch stores its bytes) would
 * otherwise update the same recording rows in two transactions at once.
 */
export function queueRecordingGraphSync(
  userId: string,
  assemblyaiId: string,
  tag: string
): void {
  if (!recordingsWriteEnabled()) return;
  const key = `${userId}|${assemblyaiId}`;
  const previous = inflight.get(key);
  const run = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(() => syncRecordingGraphForMeeting(userId, assemblyaiId))
    .then((result) => {
      if (result.status === 'written' && result.migratedFrom.length > 0) {
        console.log(
          `[recording-sync] ${tag} ${assemblyaiId}: promoted onto ${result.recordingId}, ` +
            `dropped ${result.migratedFrom.join(', ')}`
        );
      } else if (result.status === 'written' && result.staleMediaRemoved > 0) {
        console.log(
          `[recording-sync] ${tag} ${assemblyaiId}: ${result.staleMediaRemoved} stale media row(s) removed`
        );
      }
      return result;
    })
    .catch((err) => {
      console.warn(`[recording-sync] ${tag} ${assemblyaiId} failed:`, err);
      return { status: 'skipped', reason: 'error' } as RecordingSyncResult;
    })
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  inflight.set(key, run);
}

/**
 * Run `fn` AFTER whatever graph sync is in flight for this meeting, and hold
 * the next one behind it — the same serialisation `queueRecordingGraphSync`
 * gives itself, for a writer that needs the recording row to exist first.
 *
 * The same-file check's hash stamp is the only caller
 * (docs/recordings-same-file-spec.md): `recordings.sha256` is NOT derived from
 * the `transcripts` row — `applyRecordingGraph` deliberately never names the
 * column — so it is written here, once the ingest's own fire-and-forget sync
 * has created the recording. Never awaited, never throws.
 */
export function queueAfterRecordingSync(
  userId: string,
  assemblyaiId: string,
  tag: string,
  fn: () => Promise<void>
): void {
  if (!recordingsWriteEnabled()) return;
  const key = `${userId}|${assemblyaiId}`;
  const previous = inflight.get(key);
  const run: Promise<RecordingSyncResult> = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(() => fn())
    .then(() => ({ status: 'skipped', reason: tag }) as RecordingSyncResult)
    .catch((err) => {
      console.warn(`[recording-sync] ${tag} ${assemblyaiId} failed:`, err);
      return { status: 'skipped', reason: 'error' } as RecordingSyncResult;
    })
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  inflight.set(key, run);
}

/**
 * Which recording a meeting's row derives to — the same id the dual-write
 * would mint. Exported for the hash stamp, which has to name the recording
 * without loading the whole graph. `null` = the row is gone or is a
 * placeholder with nothing behind it.
 */
export async function recordingIdForMeeting(
  userId: string,
  assemblyaiId: string
): Promise<string | null> {
  const rows = await loadGraphMeetingRows(assemblyaiId);
  const me = rows.find((r) => r.user_id === userId);
  if (!me || skipReason(me)) return null;
  const owner = (isJobIdMeeting(me) ? ownerRowOf(rows) : me) ?? me;
  return recordingIdFor(canonicalKeyOf(owner));
}

/**
 * What a permanent delete's graph cleanup did — the input to the FILE
 * decision (`mayDeleteRecordingFiles`, lib/clips.ts).
 */
export interface RecordingGraphCleanup {
  /** False = the flag is off or the cleanup threw; the caller keeps today's
   * behaviour (walk the row and unlink), which is all that can be true then. */
  applied: boolean;
  recordingsRemoved: string[];
  /** Still clipped by another meeting — live OR trashed. Their bytes must
   * survive this delete. */
  recordingsKept: string[];
}

/**
 * Permanent delete: the meeting's clips go, and with them any recording that
 * has no clip left. Awaited by the delete route — a meeting the user asked
 * to destroy must not leave rows behind, and the call is already on a slow
 * path (AAI delete + unlinking files).
 *
 * Phase 3a changed what the CALLER does with the answer. Until clips had real
 * windows, a meeting's `local_audio_path` was its own file and the route could
 * simply unlink it. A split-off meeting borrows the source's canonical
 * filename so it can play, so that walk would take the bytes out from under
 * every other meeting on the recording. `recordingsKept` is the gate: files go
 * only when the recording itself went.
 *
 * The BLOBS of the recordings that were actually removed go too (DEC-3 Stage
 * A.7). Their names are read before the rows are destroyed — afterwards
 * nothing knows them — and a delete that fails is left in `media_blob_deletes`
 * for the sweeper. Soft delete never reaches here, so it never touches a blob.
 */
export async function removeRecordingGraphForMeeting(
  transcriptId: number,
  tag: string
): Promise<RecordingGraphCleanup> {
  if (!recordingsWriteEnabled()) {
    return { applied: false, recordingsRemoved: [], recordingsKept: [] };
  }
  try {
    const blobs = await blobsHeldByMeeting(transcriptId);
    const out = await removeMeetingFromRecordingGraph(transcriptId);
    if (blobs.length > 0) {
      await deleteBlobsForRemovedRecordings(blobs, out.recordingsRemoved, tag);
    }
    if (out.recordingsKept.length > 0) {
      console.log(
        `[recording-sync] ${tag} meeting ${transcriptId}: kept ${out.recordingsKept.length} ` +
          `recording(s) still clipped by another meeting (${out.recordingsKept.join(', ')}) ` +
          '— their files stay'
      );
    }
    return {
      applied: true,
      recordingsRemoved: out.recordingsRemoved,
      recordingsKept: out.recordingsKept,
    };
  } catch (err) {
    console.warn(`[recording-sync] ${tag} meeting ${transcriptId} cleanup failed:`, err);
    // A cleanup that threw tells us nothing about who else holds the bytes.
    // Keeping the files is the only safe answer.
    return { applied: true, recordingsRemoved: [], recordingsKept: ['unknown'] };
  }
}

/**
 * Same, for a row the caller only knows by its `assemblyai_id` — the
 * placeholder retirements that `deleteForUser` performs (a deferred import
 * whose real row has just been created, a stitch that could not be kept).
 * Resolves the int id first, so a placeholder that never had a graph costs
 * one indexed read and nothing else.
 */
export async function removeRecordingGraphForMeetingId(
  userId: string,
  assemblyaiId: string,
  tag: string
): Promise<void> {
  if (!recordingsWriteEnabled()) return;
  try {
    const rows = await loadGraphMeetingRows(assemblyaiId);
    const mine = rows.find((r) => r.user_id === userId);
    if (mine) await removeRecordingGraphForMeeting(mine.id, tag);
  } catch (err) {
    console.warn(`[recording-sync] ${tag} ${assemblyaiId} cleanup failed:`, err);
  }
}

/**
 * The A5 derivative sweep removed these `audio-only/<stem>.m4a` files; drop
 * the rows that described them. Never touches a canonical or a part.
 */
export function queueDerivativeMediaDrop(filenames: string[], tag: string): void {
  if (!recordingsWriteEnabled() || filenames.length === 0) return;
  void dropDerivativeMediaByFilename(filenames)
    .then((n) => {
      if (n > 0) console.log(`[recording-sync] ${tag}: dropped ${n} derivative media row(s)`);
    })
    .catch((err) => console.warn(`[recording-sync] ${tag} derivative drop failed:`, err));
}

/**
 * DEC-4: the AssemblyAI job was deleted at AssemblyAI. Mirrors the
 * `gmeet_context.aai` stamp onto `recording_transcriptions`.
 */
export function queueProviderDeletedStamp(providerJobId: string, deletedAt: string): void {
  if (!recordingsWriteEnabled()) return;
  void stampTranscriptionProviderDeleted(providerJobId, deletedAt).catch((err) =>
    console.warn(`[recording-sync] provider-deleted stamp failed for ${providerJobId}:`, err)
  );
}
