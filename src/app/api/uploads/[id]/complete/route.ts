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
