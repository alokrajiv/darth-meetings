import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  createUploadSession,
  findOpenUploadSession,
  listReceivedChunks,
  setUploadSessionStatus,
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

export const runtime = 'nodejs';

/**
 * POST /api/uploads — open (or resume) a chunked upload session.
 *
 * Body (JSON): { fingerprint, size, filename, contentType?, languageCode?,
 *   linkedEvent?, reportPref?, sourceId?, multi?: {group,index,total,comment},
 *   scratch?: true (temporary transcript, migration 042 — ignored when a
 *   calendar event is linked) }
 *
 * Same user + same fingerprint + same size while a session is still open →
 * that session comes back with the chunks already acknowledged, so the
 * client only sends what is missing (a re-dropped file after a network
 * drop, a closed tab or a reload resumes instead of restarting). Otherwise
 * a fresh session: placeholder row created (visible in listings from now),
 * empty temp file created, chunk plan returned.
 *
 * Reply: { id, chunkSize, chunkCount, received: number[], resumed, transcript }
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
    const fileBytes = await audioFileSize(existing.temp_filename);
    const placeholder = await getForUser(user.userId, existing.placeholder_id);
    const alive =
      existing.size === size &&
      fileBytes !== null &&
      placeholder !== null &&
      placeholder.status === 'uploading' &&
      placeholder.deleted_at == null;
    if (alive) {
      const received = await listReceivedChunks(existing.id);
      return NextResponse.json({
        id: existing.id,
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
  });
  if (!opened.ok) return NextResponse.json({ error: opened.error }, { status: opened.status });

  const plan = chunkPlanFor(size);
  await ensureTempFileExists(opened.spec.tempFilename);
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
  });
  return NextResponse.json(
    {
      id: session.id,
      chunkSize: session.chunk_size,
      chunkCount: session.chunk_count,
      received: [] as number[],
      resumed: false,
      transcript: opened.placeholder,
    },
    { status: 201 }
  );
});
