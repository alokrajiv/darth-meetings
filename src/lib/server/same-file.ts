import 'server-only';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { findOwnRecordingBySha256, recordingTablesExist } from '@/db-ops/same-file';
import { mergeGmeetContextForUser } from '@/db-ops/transcripts';
import { setPartMediaSha256, setRecordingUploadSha256 } from '@/db-ops/recordings';
import { queueAfterRecordingSync, recordingIdForMeeting, recordingsWriteEnabled } from '@/lib/server/recording-sync';
import { mediaIdFor } from '@/lib/recording-graph';
import {
  SAME_FILE_FLAG_ENV,
  normalizeSha256,
  partHashesInOrder,
  uploadIdentityHash,
  type DuplicateMatch,
} from '@/lib/same-file';
import type { UploadSpec } from '@/lib/server/upload-pipeline';
import type { GmeetContext } from '@/lib/format';

/**
 * "The same file is never transcribed twice by accident" — the server half
 * (docs/recordings-same-file-spec.md). The pure rules are in
 * `src/lib/same-file.ts`; the ONE owner-scoped lookup is in
 * `src/db-ops/same-file.ts`. This module is the glue the two upload routes
 * call, and nothing else.
 *
 * THREE gates, all lazy, all off by default, ALL required:
 *  - `MW_SAME_FILE_CHECK` — the feature's own flag, flipped by a pm2 restart;
 *  - `MW_RECORDINGS_WRITE` — the check reads `recordings`, which only means
 *    anything on a host that is maintaining it;
 *  - migration 044 applied (probed once, `db-ops/same-file.ts`).
 * With any of them off this module answers "no duplicate" and writes nothing,
 * and the upload path is byte-for-byte today's.
 *
 * A FOURTH gate lives on the request: the server answers `duplicate` only to a
 * caller that said `dupAware: true`. An older tray / darth-cli / tab would not
 * understand the answer, so it never sees one.
 */

/** The feature flag alone. Read lazily — `bun run build` has no env at all. */
export function sameFileFlagOn(): boolean {
  const raw = process.env[SAME_FILE_FLAG_ENV];
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * STORING the identity is not the same decision as ANSWERING with it. The
 * hash is worth nothing on the day the check is switched on unless uploads
 * before that day already carry one, so it is stored whenever the recordings
 * tables are being written (`MW_RECORDINGS_WRITE` + migration 044), flag or no
 * flag. Only the duplicate ANSWER waits for `MW_SAME_FILE_CHECK`.
 */
export async function sameFileStoreEnabled(): Promise<boolean> {
  if (!recordingsWriteEnabled()) return false;
  return recordingTablesExist().catch(() => false);
}

/** All three gates. One indexed probe the first time, cached afterwards. */
export async function sameFileCheckEnabled(): Promise<boolean> {
  if (!sameFileFlagOn() || !recordingsWriteEnabled()) return false;
  return recordingTablesExist().catch(() => false);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface DuplicateAsk {
  /** The request said `dupAware: true`. Without it: never an answer. */
  dupAware: boolean;
  /** The request said `force: true` — the user has seen the match. */
  force: boolean;
}

/**
 * The whole check: `null` means "carry on" for every reason there is — the
 * flag is off, the caller is an old client, the user forced it, we do not know
 * the hash yet, or the owner simply has no such recording. A caller therefore
 * never has to remember a gate.
 *
 * PRIVACY: `ownerUserId` is the authenticated caller and goes straight into
 * the query's WHERE clause. There is no path here that looks at anyone else's
 * recordings, and the work done is identical whether or not the hash exists
 * under another owner — one indexed lookup either way.
 */
export async function duplicateForUpload(
  ownerUserId: string,
  identitySha256: string | null,
  ask: DuplicateAsk
): Promise<DuplicateMatch | null> {
  if (!ask.dupAware || ask.force) return null;
  const sha256 = normalizeSha256(identitySha256);
  if (!sha256) return null;
  if (!(await sameFileCheckEnabled())) return null;
  return findOwnRecordingBySha256(ownerUserId, sha256).catch((err) => {
    // A lookup that cannot run must not block an upload: the worst case is
    // the behaviour we have today.
    console.warn('[same-file] duplicate lookup failed (continuing):', err);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Hashing what is on disk
// ---------------------------------------------------------------------------

/**
 * sha256 of a temp file, streamed (never read whole into memory). ~1 s/GB on
 * the VM, and it runs BEFORE the AssemblyAI hand-off — so what a duplicate
 * saves on this path is the transcription, not the upload.
 */
export async function sha256OfTempFile(tempFilename: string): Promise<string | null> {
  try {
    const abs = resolveAudioPath(tempFilename);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(abs, { highWaterMark: 1024 * 1024 })) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch (err) {
    console.warn(`[same-file] could not hash ${tempFilename} (continuing):`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Identity of one upload
// ---------------------------------------------------------------------------

/**
 * What identity THIS complete can decide, given the part's own hash:
 *  - a single file → its hash;
 *  - a group that declared `multi.partSha256` at open → the combined hash
 *    (already known since open, so every part answers the same thing);
 *  - a group's last part → the combined hash of the parts that have landed
 *    plus this one;
 *  - any other part of a group → `null`, the check waits.
 *
 * `groupRow` is the group's placeholder row (`findUploadGroupRow`); pass it
 * only for a multi-part spec.
 */
export function identityForPart(
  spec: Pick<UploadSpec, 'multi'>,
  partSha256: string | null,
  groupContext?: GmeetContext | null
): string | null {
  const mine = normalizeSha256(partSha256);
  if (!spec.multi) return mine;
  const group = groupContext?.uploadGroup;
  const declared = group?.partSha256;
  if (declared && declared.length === spec.multi.total) {
    try {
      return uploadIdentityHash({ partSha256: declared });
    } catch {
      return null;
    }
  }
  if (spec.multi.index !== spec.multi.total || !group) return null;
  const parts = [
    ...(group.parts ?? []).map((p) => ({ index: p.index, sha256: p.sha256 })),
    { index: spec.multi.index, sha256: mine ?? undefined },
  ];
  const ordered = partHashesInOrder(parts, spec.multi.total);
  if (!ordered) return null;
  return uploadIdentityHash({ partSha256: ordered });
}

// ---------------------------------------------------------------------------
// The stamp
// ---------------------------------------------------------------------------

export interface UploadIdentity {
  /** The recording's identity — a file's own hash, or a group's combined one. */
  sha256: string;
  /** A group's part hashes in order; absent for a single file. */
  partSha256?: string[] | null;
}

/**
 * Record what these bytes were, once the meeting exists.
 *
 * Two places, on purpose (spec §Storage):
 *  - `gmeet_context.upload` on the `transcripts` row — the MIRROR, written
 *    immediately, while the row is the source of truth;
 *  - `recordings.sha256` (+ each part's hash on its `recording_media` row) —
 *    written after the ingest's own graph sync has created the recording,
 *    because `applyRecordingGraph` deliberately never names those columns.
 *
 * Fire-and-forget for the recording half: an upload that produced a transcript
 * must never fail, or wait, because a mirror table could not be written.
 */
export async function stampUploadIdentity(
  userId: string,
  meetingId: string,
  identity: UploadIdentity,
  tag: string
): Promise<void> {
  const sha256 = normalizeSha256(identity.sha256);
  if (!sha256) return;
  if (!(await sameFileStoreEnabled())) return;
  const parts = identity.partSha256?.map((p) => normalizeSha256(p)).filter((p): p is string => !!p);
  const partSha256 = parts && parts.length === identity.partSha256?.length ? parts : undefined;

  await mergeGmeetContextForUser(
    userId,
    meetingId,
    { upload: { sha256, ...(partSha256 ? { partSha256 } : {}) } },
    { quiet: true }
  ).catch((err) => console.warn(`[same-file] ${tag} mirror write failed:`, err));

  queueAfterRecordingSync(userId, meetingId, `same-file/${tag}`, async () => {
    const recordingId = await recordingIdForMeeting(userId, meetingId);
    if (!recordingId) return;
    const wrote = await setRecordingUploadSha256(recordingId, sha256);
    // Each part's own hash on its `part` media row — the only record of what
    // went into the combined hash once the stitch has eaten the files.
    for (const [i, hash] of (partSha256 ?? []).entries()) {
      await setPartMediaSha256(mediaIdFor(recordingId, 'part', i), hash).catch(() => false);
    }
    if (wrote) {
      console.log(
        `[same-file] ${tag} ${meetingId}: recording ${recordingId} sha256 ${sha256.slice(0, 12)}…` +
          (partSha256 ? ` (${partSha256.length} parts)` : '')
      );
    }
  });
}
