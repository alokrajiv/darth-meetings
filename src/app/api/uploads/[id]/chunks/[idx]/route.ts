import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  ackUploadChunk,
  getUploadSessionForUser,
  setUploadSessionStatus,
} from '@/db-ops/upload-sessions';
import { updateUploadProgress } from '@/db-ops/transcripts';
import { audioFileSize, writeChunkAt } from '@/lib/server/audio-storage';
import { chunkByteRange } from '@/lib/upload-chunking';

export const runtime = 'nodejs';
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-session throttle for the listing's progress writes: several chunks
// finish per second with 4 in flight, and every UPDATE fans out an SSE
// event. State lives on globalThis — Next bundles a route module more than
// once, so a module-level Map would be per-bundle.
declare global {
  var __mwUploadProgressFlush: Map<string, number> | undefined;
}
const flushAt = (globalThis.__mwUploadProgressFlush ??= new Map<string, number>());

/**
 * PUT /api/uploads/:id/chunks/:idx — one chunk, raw body, at its byte offset.
 * Optional `x-chunk-sha256` (hex) is verified over the streamed bytes. The
 * chunk is acknowledged only when its length (and hash) match; anything
 * else is a 4xx and the client simply re-sends the same range. Idempotent:
 * a retry racing its own slow original rewrites identical bytes.
 *
 * 404 unknown session · 410 session no longer open (client restarts with a
 * new POST /api/uploads) · 409 bad index · 400 length/hash mismatch.
 */
export const PUT = withAuth(async ({ user, request }, { params }) => {
  const { id, idx: rawIdx } = await params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const idx = Number(rawIdx);
  const session = await getUploadSessionForUser(user.userId, id);
  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  if (session.status !== 'open') {
    return NextResponse.json(
      { error: `Upload session is ${session.status}`, status: session.status },
      { status: 410 }
    );
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= session.chunk_count) {
    return NextResponse.json({ error: 'Chunk index out of range' }, { status: 409 });
  }
  if (!request.body) return NextResponse.json({ error: 'Empty chunk body' }, { status: 400 });

  // The temp file is the session's ground truth; if the sweeper reaped it
  // there is nothing to resume into.
  if ((await audioFileSize(session.temp_filename)) === null) {
    await setUploadSessionStatus(session.id, 'failed', 'temp file missing');
    return NextResponse.json({ error: 'Upload session expired', status: 'failed' }, { status: 410 });
  }

  const range = chunkByteRange(session.size, session.chunk_size, idx);
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) !== range.length) {
    return NextResponse.json(
      { error: `Chunk ${idx} must be ${range.length} bytes (got content-length ${declared})` },
      { status: 400 }
    );
  }

  let written: { bytes: number; sha256: string };
  try {
    written = await writeChunkAt(session.temp_filename, range.start, request.body);
  } catch (error) {
    console.error(`[uploads] chunk write failed ${id}#${idx}:`, error);
    return NextResponse.json(
      { error: 'Chunk write failed', detail: String(error) },
      { status: 500 }
    );
  }
  if (written.bytes !== range.length) {
    return NextResponse.json(
      { error: `Chunk ${idx} truncated: expected ${range.length} bytes, received ${written.bytes}` },
      { status: 400 }
    );
  }
  const expectedHash = request.headers.get('x-chunk-sha256')?.trim().toLowerCase();
  if (expectedHash && expectedHash !== written.sha256) {
    return NextResponse.json({ error: `Chunk ${idx} hash mismatch` }, { status: 400 });
  }

  const ack = await ackUploadChunk(session.id, idx, written.bytes);

  // Listing progress: throttled to ~1 write / 1.5s per session, always
  // flushed on the final chunk. Heartbeats the placeholder too, which is
  // what keeps the stale-upload sweeper off a live session.
  const now = Date.now();
  const last = flushAt.get(session.id) ?? 0;
  const complete = ack.receivedCount >= session.chunk_count;
  if (complete || now - last >= 1500) {
    flushAt.set(session.id, now);
    if (complete) flushAt.delete(session.id);
    void updateUploadProgress(user.userId, session.placeholder_id, ack.receivedBytes).catch(
      () => {}
    );
  }

  return NextResponse.json({
    idx,
    received: ack.receivedCount,
    receivedBytes: ack.receivedBytes,
    chunkCount: session.chunk_count,
  });
});
