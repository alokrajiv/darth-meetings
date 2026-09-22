import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  claimUploadSessionForComplete,
  clearUploadSessionBlobIntent,
  getUploadSessionForUser,
  listReceivedChunks,
  setUploadSessionStatus,
  stampUploadSessionBlobIntent,
} from '@/db-ops/upload-sessions';
import { audioFileSize } from '@/lib/server/audio-storage';
import { abandonUpload, finalizeUpload, groupProgressAdder } from '@/lib/server/upload-pipeline';
import { findUploadGroupRow, updateUploadProgress } from '@/db-ops/transcripts';
import { pullBlobToTemp, uploadsStore } from '@/lib/server/darth-uploads-store';
import {
  BlobIngestFailed,
  aaiFromBlobFlagOn,
  blobIntentOf,
  copyTransitToMedia,
  planBlobIngest,
} from '@/lib/server/aai-from-blob';
import {
  duplicateForUpload,
  identityForPart,
  sameFileStoreEnabled,
  sha256OfTempFile,
} from '@/lib/server/same-file';
import { wantsForce } from '@/lib/same-file';
import type { UploadSessionRow } from '@/db-ops/upload-sessions';
import type { DarthUser } from '@/lib/auth/session';

export const runtime = 'nodejs';
// The finalize tail re-uploads the file to AssemblyAI (minutes for a
// multi-GB recording) — same budget the one-shot route has.
export const maxDuration = 900;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What these bytes ARE, and whether the caller already has them
 * (docs/recordings-same-file-spec.md, MW_SAME_FILE_CHECK).
 *
 * `part` is this session's own sha256 — the blob transit's verified hash,
 * already known, or the chunk path's temp file streamed once here, ~1 s/GB
 * and always BEFORE the AssemblyAI hand-off, so a duplicate saves the
 * transcription. `identity` is the recording's: the file's hash for a single
 * upload, `sha256(part hashes joined by '\n')` for a group (declared at open,
 * or assembled from the parts that have landed once the last one arrives).
 *
 * PRIVACY: `duplicateForUpload` is owner-scoped; a hash another user holds
 * does the same single indexed read and answers null, so the reply and the
 * timing are the same as for a hash nobody has.
 */
async function sameFileVerdict(
  user: DarthUser,
  session: UploadSessionRow,
  force: boolean
): Promise<{ part: string | null; identity: string | null; duplicate: unknown | null }> {
  // The part's hash is measured whenever identities are being STORED; whether
  // a match is ANSWERED is duplicateForUpload's own gate (flag + dupAware).
  if (!(await sameFileStoreEnabled())) return { part: null, identity: null, duplicate: null };
  const part =
    session.via === 'blob' ? session.sha256 : await sha256OfTempFile(session.temp_filename);
  const groupRow = session.spec.multi
    ? await findUploadGroupRow(user.userId, session.spec.multi.group).catch(() => null)
    : null;
  const identity = identityForPart(session.spec, part, groupRow?.gmeet_context);
  const duplicate = await duplicateForUpload(user.userId, identity, {
    dupAware: session.spec.dupAware === true,
    force,
  });
  return { part, identity, duplicate };
}

/**
 * DEC-3 Stage C — try to finish this blob session WITHOUT the bytes ever
 * touching the VM (`docs/recordings-blob-spec.md`, `MW_AAI_FROM_BLOB`).
 *
 * `null` = not taken; the caller pulls exactly as before and nothing has
 * changed (no blob written, no row touched, the transit blob intact). A
 * non-null answer is the response to send, plus whether it succeeded — the
 * caller then deletes the transit blob, which on this path happens after the
 * row exists rather than after the pull, so that every failure mode above can
 * still fall back.
 *
 * The three failure shapes, all of which fall back:
 *  - not eligible (flag, account, recorder upload, group, unknown extension);
 *  - the server-side copy or its verify failed;
 *  - AssemblyAI refused the submit — nothing was created, and the pull path
 *    can do better (it keeps the bytes as a visible Failed row for the
 *    ingest-retry sweeper).
 *
 * And the fourth, which does NOT fall back because it cannot: this process
 * dying between the copy and the row. That is what the `blobIntent` stamp
 * below is for — it is written before the copy and cleared once the row
 * exists, so the expired-session sweeper can delete a blob nothing ever came
 * to name (`abandonedBlobOf`).
 */
async function tryAaiFromBlob(
  user: DarthUser,
  session: UploadSessionRow,
  partHash: string | null
): Promise<{ ok: boolean; response: NextResponse } | null> {
  const planned = await planBlobIngest(user.userId, session).catch((err) => {
    console.warn('[aai-from-blob] planning failed:', err);
    return { ok: false as const, reason: 'planning failed' };
  });
  if (!planned.ok) {
    if (aaiFromBlobFlagOn()) {
      console.log(`[aai-from-blob] ${session.id}: pull path — ${planned.reason}`);
    }
    return null;
  }
  // The INTENT, before a byte moves: from here until the media row names the
  // blob, this stamp is the ONLY record of where those permanent bytes are.
  // A crash in between leaves the session at `completing`, and the
  // expired-session sweeper deletes the blob it was going to write unless a
  // media row turns out to claim it (`abandonedBlobOf`).
  const intent = blobIntentOf(planned.plan);
  try {
    await stampUploadSessionBlobIntent(session.id, intent);
  } catch (err) {
    // Without the stamp the copy is exactly the leak this guards against, so
    // do not take the fast path at all — the pull path is not worse, only
    // slower.
    console.warn(`[aai-from-blob] ${session.id}: could not record the copy intent, pulling instead:`, err);
    return null;
  }
  const copied = await copyTransitToMedia(
    planned.store,
    planned.transit,
    session.blob_name!,
    planned.plan
  );
  if (!copied.ok) {
    // `copyTransitToMedia` already took the half-written blob back out.
    console.warn(`[aai-from-blob] ${session.id}: copy failed, pulling instead — ${copied.error}`);
    await clearUploadSessionBlobIntent(session.id).catch(() => {});
    return null;
  }
  console.log(
    `[aai-from-blob] ${session.id}: ${session.size} B copied to ${planned.plan.blobName} in ${copied.ms} ms (server-side)`
  );
  try {
    const done = await finalizeUpload(user, session.spec, session.size, {
      part: partHash,
      fromBlob: copied.source,
    });
    const ok = done.status >= 200 && done.status < 300 && 'transcript' in done.body;
    if (ok && 'transcript' in done.body) {
      // The row exists and the graph sync will stamp the media row with this
      // blob: Stage C is over, so the intent has nothing left to protect.
      // (From here the deterministic name is what lets `archiveMedia` adopt
      // the blob even if the stamp itself is lost — spec, Stage C as built.)
      await clearUploadSessionBlobIntent(session.id).catch(() => {});
      await setUploadSessionStatus(session.id, 'done', null, done.body.transcript.assemblyai_id);
    } else {
      // The intent STAYS: whether a row was created is exactly what this side
      // cannot tell, and the sweeper decides it by asking `recording_media`.
      const msg = 'error' in done.body ? done.body.error : `finalize returned ${done.status}`;
      await setUploadSessionStatus(session.id, 'failed', msg);
    }
    return { ok, response: NextResponse.json(done.body, { status: done.status }) };
  } catch (error) {
    if (error instanceof BlobIngestFailed) {
      // Nothing was created. Take the permanent copy back out — the pull path
      // will archive the file itself once it is on disk — and fall back.
      await planned.store.delete(planned.plan.blobName).catch(() => {});
      await clearUploadSessionBlobIntent(session.id).catch(() => {});
      return null;
    }
    console.error(`[uploads] finalize crashed ${session.id}:`, error);
    await setUploadSessionStatus(session.id, 'failed', String(error));
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Finalizing the upload failed', detail: String(error) },
        { status: 500 }
      ),
    };
  }
}

/**
 * POST /api/uploads/:id/complete — every chunk is in; run the shared
 * finalize tail (multi-file group bookkeeping / stitch, AAI ingest,
 * placeholder promotion). Exactly-once: the session flips open →
 * completing atomically, so a retried complete (client lost the response
 * mid-ingest) gets a 409 and should poll GET /api/uploads/:id instead.
 *
 * 409 {missing:[…]} when chunks are still outstanding · 409 already
 * completing · 410 failed/expired · 200 done (the transcript, or its id).
 *
 * Blob sessions (darth uploads, migration 043): instead of the chunk
 * bookkeeping the route asks Azure whether the blob is committed (409
 * {notCommitted:true} — the client re-syncs its blocks and commits), then
 * claims the session and PULLS the blob over the Azure backbone into the
 * session's temp file, verifying size + sha256 on the way (a mismatch
 * deletes the blob, abandons the placeholder and answers 410 — the client
 * starts over). From there the same finalize tail; the blob is deleted once
 * the bytes are on disk.
 *
 * With `MW_AAI_FROM_BLOB` on (DEC-3 Stage C) an eligible single-file blob
 * session skips the pull entirely: Azure copies the transit blob into the
 * permanent media container server-side and AssemblyAI is handed a read SAS on
 * it, so the recording is transcribing while the VM fetches its own copy in
 * the background. Anything not eligible — a group, a Darth Recorder upload
 * (multi-track, DEC-1), a copy that failed, a submit AssemblyAI refused —
 * falls through to the pull above with nothing changed (`tryAaiFromBlob`).
 *
 * The same file, again (MW_SAME_FILE_CHECK, docs/recordings-same-file-spec.md):
 * when the session was opened with `dupAware: true` and the caller already has
 * a live recording of these exact bytes, the answer is **200**
 * `{ duplicate: {…} }` with the session left OPEN and nothing submitted to
 * AssemblyAI. Re-send with `{"force": true}` as the body to go ahead.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  // The body is optional — every client but a `force` re-send sends none.
  const body = await request.json().catch(() => null);
  const force = wantsForce(body);
  const { id } = await params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getUploadSessionForUser(user.userId, id);
  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  if (session.status === 'done') {
    return NextResponse.json({ status: 'done', transcriptId: session.result_id });
  }
  if (session.status === 'completing') {
    return NextResponse.json(
      { error: 'Upload is already being finalized', status: 'completing' },
      { status: 409 }
    );
  }
  if (session.status !== 'open') {
    return NextResponse.json(
      { error: session.error ?? 'Upload session failed', status: session.status },
      { status: 410 }
    );
  }

  if (session.via === 'blob') {
    const store = uploadsStore();
    if (!store || !session.blob_name || !session.sha256) {
      await setUploadSessionStatus(session.id, 'failed', 'blob transit is not configured on this host');
      await abandonUpload(user, session.spec);
      return NextResponse.json(
        { error: 'Blob uploads are not available on this host any more — please upload again', status: 'failed' },
        { status: 410 }
      );
    }
    const committed = await store.stat(session.blob_name);
    if (!committed) {
      return NextResponse.json(
        { error: 'The upload has not been committed to blob storage yet', notCommitted: true },
        { status: 409 }
      );
    }
    if (committed.bytes !== session.size) {
      // Committed with the wrong length: the client's block list was wrong
      // or a different file went to this blob. Never adopt it.
      await store.delete(session.blob_name).catch(() => {});
      await setUploadSessionStatus(session.id, 'failed', `blob size mismatch (${committed.bytes} vs ${session.size})`);
      await abandonUpload(user, session.spec);
      return NextResponse.json(
        { error: 'Upload session expired (blob size mismatch) — please upload again', status: 'failed' },
        { status: 410 }
      );
    }
    // The hash is already known and about to be verified by the pull, so the
    // check happens BEFORE the session is claimed: a duplicate leaves it open
    // and nothing has moved. (Single files and declared groups were already
    // answered at open; this catches a group assembling its parts.)
    const blobVerdict = await sameFileVerdict(user, session, force);
    if (blobVerdict.duplicate) return NextResponse.json({ duplicate: blobVerdict.duplicate });

    if (!(await claimUploadSessionForComplete(user.userId, session.id))) {
      return NextResponse.json(
        { error: 'Upload is already being finalized', status: 'completing' },
        { status: 409 }
      );
    }

    // DEC-3 Stage C: hand AssemblyAI the bytes where they already are.
    // Azure copies the transit blob into the permanent container itself and
    // the job reads it from a short-lived read SAS (AAI_SAS_TTL_MS) — no pull, no `files.upload`,
    // no bytes through this VM. Every way of not being eligible (flag off, no
    // account, a recorder upload, a group, a copy that failed) falls through
    // to the pull below with nothing changed; the transit blob is still there
    // precisely because this path deletes it only once the row exists.
    const fast = await tryAaiFromBlob(user, session, blobVerdict.part);
    if (fast) {
      if (fast.ok) {
        await store
          .delete(session.blob_name)
          .catch((err) => console.warn(`[uploads] blob delete after copy failed ${id} (lifecycle rule will):`, err));
      }
      return fast.response;
    }

    // Pull. Progress writes keep the listing moving and the placeholder's
    // heartbeat alive (the stale-upload sweeper keys on it). One part of a
    // multi-file group reports the WHOLE recording's bytes (P2) — the group
    // row is read once, here, before the bytes start moving.
    const groupRelative = await groupProgressAdder(user.userId, session.spec);
    let lastFlush = 0;
    const t0 = Date.now();
    const pulled = await pullBlobToTemp(store, {
      blobName: session.blob_name,
      sha256: session.sha256,
      size: session.size,
      tempFilename: session.temp_filename,
      onProgress: (bytes) => {
        const now = Date.now();
        if (now - lastFlush < 1500) return;
        lastFlush = now;
        void updateUploadProgress(
          user.userId,
          session.placeholder_id,
          groupRelative(bytes)
        ).catch(() => {});
      },
    });
    if (!pulled.ok) {
      console.error(`[uploads] blob pull ${pulled.kind} ${id}: ${pulled.error}`);
      if (pulled.kind === 'mismatch') {
        await setUploadSessionStatus(session.id, 'failed', pulled.error);
        await abandonUpload(user, session.spec);
        return NextResponse.json(
          { error: 'Upload session expired (file mismatch) — please upload again', status: 'failed' },
          { status: 410 }
        );
      }
      // Transient (Azure hiccup): the blob stays; reopen the session so the
      // client's next complete tries the pull again.
      await setUploadSessionStatus(session.id, 'open', null);
      return NextResponse.json(
        { error: 'Transferring the upload from blob storage failed — retrying', detail: pulled.error },
        { status: 503 }
      );
    }
    console.log(
      `[uploads] blob pull ${id}: ${pulled.bytes} B in ${pulled.ms} ms (${Math.round(pulled.bytes / 1024 / 1024 / Math.max(0.001, pulled.ms / 1000))} MB/s, ${Date.now() - t0} ms total)`
    );
    // Bytes are on disk and verified: the blob has served its purpose.
    await store
      .delete(session.blob_name)
      .catch((err) => console.warn(`[uploads] blob delete after pull failed ${id} (lifecycle rule will):`, err));
    try {
      const done = await finalizeUpload(user, session.spec, session.size, {
        part: blobVerdict.part,
      });
      if (done.status >= 200 && done.status < 300 && 'transcript' in done.body) {
        await setUploadSessionStatus(session.id, 'done', null, done.body.transcript.assemblyai_id);
      } else {
        const msg = 'error' in done.body ? done.body.error : `finalize returned ${done.status}`;
        await setUploadSessionStatus(session.id, 'failed', msg);
      }
      return NextResponse.json(done.body, { status: done.status });
    } catch (error) {
      console.error(`[uploads] finalize crashed ${id}:`, error);
      await setUploadSessionStatus(session.id, 'failed', String(error));
      return NextResponse.json(
        { error: 'Finalizing the upload failed', detail: String(error) },
        { status: 500 }
      );
    }
  }

  const received = await listReceivedChunks(session.id);
  if (received.length < session.chunk_count) {
    const have = new Set(received);
    const missing: number[] = [];
    for (let i = 0; i < session.chunk_count && missing.length < 64; i++) {
      if (!have.has(i)) missing.push(i);
    }
    return NextResponse.json(
      {
        error: `Upload incomplete (${received.length}/${session.chunk_count} chunks)`,
        missing,
        received: received.length,
        chunkCount: session.chunk_count,
      },
      { status: 409 }
    );
  }
  const onDisk = await audioFileSize(session.temp_filename);
  if (onDisk !== session.size) {
    // Every chunk acknowledged yet the file is the wrong length: the temp
    // file was tampered with or reaped underneath us. Unrecoverable — the
    // client restarts from scratch.
    await setUploadSessionStatus(session.id, 'failed', `size mismatch on disk (${onDisk})`);
    await abandonUpload(user, session.spec);
    return NextResponse.json(
      { error: 'Upload session expired (file mismatch) — please upload again', status: 'failed' },
      { status: 410 }
    );
  }

  // Every chunk is in and the file is the right length: hash it ONCE, here,
  // and answer `duplicate` before anything is claimed or submitted. The bytes
  // are already on the VM, so what a duplicate saves on this path is the
  // transcription — which is the expensive half.
  const verdict = await sameFileVerdict(user, session, force);
  if (verdict.duplicate) return NextResponse.json({ duplicate: verdict.duplicate });

  if (!(await claimUploadSessionForComplete(user.userId, session.id))) {
    return NextResponse.json(
      { error: 'Upload is already being finalized', status: 'completing' },
      { status: 409 }
    );
  }

  try {
    const done = await finalizeUpload(user, session.spec, session.size, { part: verdict.part });
    if (done.status >= 200 && done.status < 300 && 'transcript' in done.body) {
      await setUploadSessionStatus(session.id, 'done', null, done.body.transcript.assemblyai_id);
    } else {
      const msg = 'error' in done.body ? done.body.error : `finalize returned ${done.status}`;
      await setUploadSessionStatus(session.id, 'failed', msg);
    }
    return NextResponse.json(done.body, { status: done.status });
  } catch (error) {
    console.error(`[uploads] finalize crashed ${id}:`, error);
    await setUploadSessionStatus(session.id, 'failed', String(error));
    return NextResponse.json(
      { error: 'Finalizing the upload failed', detail: String(error) },
      { status: 500 }
    );
  }
});
