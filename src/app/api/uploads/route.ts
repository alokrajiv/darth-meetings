import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  createUploadSession,
  findOpenUploadSession,
  listReceivedChunks,
  setUploadSessionStatus,
  touchUploadSessionSas,
} from '@/db-ops/upload-sessions';
import { getForUser } from '@/db-ops/transcripts';
import { audioFileSize, ensureTempFileExists } from '@/lib/server/audio-storage';
import {
  openUpload,
  parseMultiParams,
  parseReportPref,
  sanitizeLinkedEvent,
  textDocRejection,
} from '@/lib/server/upload-pipeline';
import { MAX_UPLOAD_BYTES, chunkPlanFor } from '@/lib/upload-chunking';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import { SHA256_HEX_RE } from '@/lib/darth-uploads-shared';
import { blobTransitFor, mintBlobTicket } from '@/lib/server/darth-uploads-store';
import { getOwnRecording } from '@/db-ops/recorder';

export const runtime = 'nodejs';

/**
 * POST /api/uploads — open (or resume) a chunked upload session.
 *
 * Body (JSON): { fingerprint, size, filename, contentType?, languageCode?,
 *   linkedEvent?, reportPref?, sourceId?, multi?: {group,index,total,comment},
 *   scratch?: true (temporary transcript, migration 042 — ignored when a
 *   calendar event is linked),
 *   via?: 'blob', sha256?, coarse? (darth uploads — below),
 *   recorderRecordingId? (Darth Recorder registry row these bytes came from) }
 *
 * Same user + same fingerprint + same size while a session is still open →
 * that session comes back with the chunks already acknowledged, so the
 * client only sends what is missing (a re-dropped file after a network
 * drop, a closed tab or a reload resumes instead of restarting). Otherwise
 * a fresh session: placeholder row created (visible in listings from now),
 * empty temp file created, chunk plan returned.
 *
 * darth uploads (migration 043, docs/darth-uploads.md): `via: 'blob'` +
 * `sha256` (the whole file, 64 hex) asks for the Azure Blob transit — the
 * reply carries `via: 'blob'` and a `blob` ticket {sasUrl, blobName,
 * blockBytes, parallel, expiresAt} and the client PUTs 4 MiB blocks straight
 * to Azure, then calls …/complete; the VM pulls the committed blob once.
 * Granted only when the host has DARTH_UPLOADS_ACCOUNT configured AND the
 * file is ≥ UPLOAD_BLOB_MIN_BYTES; otherwise the reply says `via: 'chunks'`
 * and the client takes the chunk path — never a 503 dance. A resumed blob
 * session re-mints the SAS on the SAME blob (the client asks Azure for the
 * uncommitted block list itself). `coarse: true` (a phone) halves the
 * parallelism.
 *
 * Reply: { id, via, chunkSize, chunkCount, received: number[], resumed,
 *   transcript, blob? }
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
  if (!/^[A-Za-z0-9:_|.-]{16,240}$/.test(fingerprint)) {
    return NextResponse.json({ error: 'Invalid fingerprint' }, { status: 400 });
  }
  const size = typeof body.size === 'number' ? body.size : Number(body.size);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Invalid size (1..${MAX_UPLOAD_BYTES} bytes)` },
      { status: 400 }
    );
  }
  const originalFilename =
    typeof body.filename === 'string' && body.filename.trim()
      ? body.filename.trim().slice(0, 300)
      : null;
  const contentType = typeof body.contentType === 'string' ? body.contentType : '';
  const languageCode =
    typeof body.languageCode === 'string' && body.languageCode ? body.languageCode : undefined;
  // `eventRef` (meeting code / event key) = headless pre-link, resolved from
  // the caller's own calendar cache; `linkedEvent` = the web stepper's whole
  // event. The ref wins when both are present.
  let linkedEvent = sanitizeLinkedEvent(body.linkedEvent);
  if (typeof body.eventRef === 'string' && body.eventRef.trim()) {
    const resolved = await resolveLinkedEventRef(user.userId, body.eventRef);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    linkedEvent = resolved.event;
  }
  const reportPref = parseReportPref(typeof body.reportPref === 'string' ? body.reportPref : null);
  const sourceId = typeof body.sourceId === 'string' && body.sourceId ? body.sourceId : null;
  const scratch = body.scratch === true;
  const wantsBlob = body.via === 'blob';
  const sha256 = typeof body.sha256 === 'string' ? body.sha256.trim().toLowerCase() : '';
  if (wantsBlob && !SHA256_HEX_RE.test(sha256)) {
    return NextResponse.json(
      { error: 'via: blob requires sha256 (64 lowercase hex characters of the whole file)' },
      { status: 400 }
    );
  }
  const coarse = body.coarse === true;
  // The Darth Recorder registry row (migration 041): must be the caller's own.
  let recorderRecordingId: string | null = null;
  if (typeof body.recorderRecordingId === 'string' && body.recorderRecordingId) {
    const rec = await getOwnRecording(user.userId, body.recorderRecordingId).catch(() => null);
    if (!rec) return NextResponse.json({ error: 'Recorder recording not found' }, { status: 404 });
    recorderRecordingId = rec.id;
  }
  const rawMulti = body.multi as Record<string, unknown> | undefined | null;
  const multi = rawMulti
    ? parseMultiParams({
        group: typeof rawMulti.group === 'string' ? rawMulti.group : null,
        index: rawMulti.index as string | number | null,
        total: rawMulti.total as string | number | null,
        comment: typeof rawMulti.comment === 'string' ? rawMulti.comment : null,
      })
    : undefined;
  if (multi === null) {
    return NextResponse.json({ error: 'Invalid multi-upload parameters' }, { status: 400 });
  }

  const rejected = textDocRejection(originalFilename, contentType);
  if (rejected) return NextResponse.json({ error: rejected }, { status: 415 });

  // --- Resume: an open session for this exact file. ---
  const existing = await findOpenUploadSession(user.userId, fingerprint);
  if (existing) {
    const isBlob = existing.via === 'blob';
    // A blob session has no temp file until the pull; a chunk session's
    // temp file is its ground truth.
    const fileBytes = isBlob ? 0 : await audioFileSize(existing.temp_filename);
    const placeholder = await getForUser(user.userId, existing.placeholder_id);
    const blobStore = isBlob ? blobTransitFor(existing.size) : null;
    const alive =
      existing.size === size &&
      fileBytes !== null &&
      placeholder !== null &&
      placeholder.status === 'uploading' &&
      placeholder.deleted_at == null &&
      // A blob session on a host that lost its store config cannot continue.
      (!isBlob || (blobStore !== null && existing.sha256 === sha256));
    if (alive) {
      if (isBlob && blobStore) {
        // Same blob, fresh SAS. The client asks Azure which blocks it holds.
        const blob = await mintBlobTicket(blobStore, {
          userId: user.userId,
          sessionId: existing.id,
          filename: existing.spec.originalFilename,
          coarse,
        });
        await touchUploadSessionSas(existing.id, new Date(blob.expiresAt));
        return NextResponse.json({
          id: existing.id,
          via: 'blob',
          chunkSize: existing.chunk_size,
          chunkCount: existing.chunk_count,
          received: [] as number[],
          resumed: true,
          transcript: placeholder,
          blob,
        });
      }
      const received = await listReceivedChunks(existing.id);
      return NextResponse.json({
        id: existing.id,
        via: 'chunks',
        chunkSize: existing.chunk_size,
        chunkCount: existing.chunk_count,
        received,
        resumed: received.length > 0,
        transcript: placeholder,
      });
    }
    // Reaped placeholder / vanished temp file / different size under the
    // same fingerprint: the old session is unusable — retire it and start
    // over below.
    await setUploadSessionStatus(existing.id, 'failed', 'stale session superseded');
  }

  // --- Fresh session. ---
  const uuid = crypto.randomUUID();
  const opened = await openUpload(user, {
    originalFilename,
    contentType,
    languageCode,
    linkedEvent,
    reportPref,
    sourceId,
    multi: multi ?? null,
    bytesTotal: size,
    uuid,
    scratch,
    recorderRecordingId,
  });
  if (!opened.ok) return NextResponse.json({ error: opened.error }, { status: opened.status });

  const plan = chunkPlanFor(size);
  const blobStore = wantsBlob ? blobTransitFor(size) : null;
  let blob: Awaited<ReturnType<typeof mintBlobTicket>> | null = null;
  if (blobStore) {
    // The session id is the placeholder's uuid for single-file uploads and a
    // fresh uuid for parts 2..N of a group — either way unique per session,
    // which is what keys the blob name.
    blob = await mintBlobTicket(blobStore, {
      userId: user.userId,
      sessionId: uuid,
      filename: originalFilename,
      coarse,
    });
  } else {
    await ensureTempFileExists(opened.spec.tempFilename);
  }
  const session = await createUploadSession({
    id: uuid,
    userId: user.userId,
    fingerprint,
    size,
    chunkSize: plan.chunkSize,
    chunkCount: plan.chunkCount,
    tempFilename: opened.spec.tempFilename,
    placeholderId: opened.spec.placeholderId,
    spec: opened.spec,
    blob: blob ? { blobName: blob.blobName, sha256, sasExpiresAt: new Date(blob.expiresAt) } : null,
  });
  return NextResponse.json(
    {
      id: session.id,
      via: blob ? 'blob' : 'chunks',
      chunkSize: session.chunk_size,
      chunkCount: session.chunk_count,
      received: [] as number[],
      resumed: false,
      transcript: opened.placeholder,
      ...(blob ? { blob } : {}),
    },
    { status: 201 }
  );
});
