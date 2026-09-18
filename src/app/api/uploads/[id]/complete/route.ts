import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  claimUploadSessionForComplete,
  getUploadSessionForUser,
  listReceivedChunks,
  setUploadSessionStatus,
} from '@/db-ops/upload-sessions';
import { audioFileSize } from '@/lib/server/audio-storage';
import { abandonUpload, finalizeUpload } from '@/lib/server/upload-pipeline';
import { updateUploadProgress } from '@/db-ops/transcripts';
import { pullBlobToTemp, uploadsStore } from '@/lib/server/darth-uploads-store';

export const runtime = 'nodejs';
// The finalize tail re-uploads the file to AssemblyAI (minutes for a
// multi-GB recording) — same budget the one-shot route has.
export const maxDuration = 900;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  void request;
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
    if (!(await claimUploadSessionForComplete(user.userId, session.id))) {
      return NextResponse.json(
        { error: 'Upload is already being finalized', status: 'completing' },
        { status: 409 }
      );
    }
    // Pull. Progress writes keep the listing moving and the placeholder's
    // heartbeat alive (the stale-upload sweeper keys on it).
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
        void updateUploadProgress(user.userId, session.placeholder_id, bytes).catch(() => {});
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
      const done = await finalizeUpload(user, session.spec, session.size);
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

  if (!(await claimUploadSessionForComplete(user.userId, session.id))) {
    return NextResponse.json(
      { error: 'Upload is already being finalized', status: 'completing' },
      { status: 409 }
    );
  }

  try {
    const done = await finalizeUpload(user, session.spec, session.size);
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
