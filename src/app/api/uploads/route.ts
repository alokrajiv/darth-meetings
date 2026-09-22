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
  parseUploadTracks,
  recorderOpenFacts,
  sanitizeLinkedEvent,
  textDocRejection,
  type RecorderOpenFacts,
} from '@/lib/server/upload-pipeline';
import type { SuggestedEvent } from '@/lib/format';
import { MAX_UPLOAD_BYTES, chunkPlanFor } from '@/lib/upload-chunking';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import { SHA256_HEX_RE } from '@/lib/darth-uploads-shared';
import { blobTransitFor, mintBlobTicket } from '@/lib/server/darth-uploads-store';
import { uploadIdentityHash, wantsDuplicateAnswer, wantsForce } from '@/lib/same-file';
import { duplicateForUpload } from '@/lib/server/same-file';
import { resolveAttachTarget } from '@/lib/server/clip-attach';
import { parseAttachTo, type AttachToMarker } from '@/lib/clips';

export const runtime = 'nodejs';

/**
 * POST /api/uploads — open (or resume) a chunked upload session.
 *
 * Body (JSON): { fingerprint, size, filename, contentType?, languageCode?,
 *   linkedEvent?, reportPref?, sourceId?,
 *   multi?: {group,index,total,comment,groupBytes,partSha256},
 *   dupAware?: true, force?: true (same-file check — below),
 *   scratch?: true (temporary transcript, migration 042 — ignored when a
 *   calendar event is linked),
 *   via?: 'blob', sha256?, coarse? (darth uploads — below),
 *   recorderRecordingId? (Darth Recorder registry row these bytes came from),
 *   tracks?: {count, mixFirst} (what the file's audio tracks are — below),
 *   attachTo?: {meetingId, offsetMs?, textPolicy?} (join an existing meeting
 *   as a second recording — below) }
 *
 * `multi.groupBytes` (optional, ≥ this part's size) is the sum of every
 * part's size: the group row is born with it as `upload_bytes_total`, so the
 * listing's "x of y" is about the whole recording instead of part 1
 * (docs/recorder-upload-ux.md §2.1/2.2).
 *
 * `recorderRecordingId` with no `linkedEvent`/`eventRef`: when the recorder
 * matcher already tied that recording to a calendar occurrence confidently
 * (score ≥ 0.6, overlap ≥ 0.5) the placeholder is linked to it here — one
 * meeting, one row, from the first byte (P1). Never a 4xx: an unresolvable
 * match just leaves the upload unlinked.
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
 * `tracks` (Darth Recorder 0.3.12): `{count, mixFirst}` describing the file's
 * audio tracks, frozen on the session. `mixFirst: true` is the client's
 * promise that audio track 0 is the WHOLE recording — the tray's live mix, or
 * the only source when there is one — which is what lets a recorder upload
 * hand its bytes to AssemblyAI where they lie instead of being pulled to the
 * VM and mixed there (DEC-1, docs/recordings-blob-spec.md). Absent = unknown,
 * and nothing changes; malformed = 400, because a client that meant to make
 * the promise should not silently lose it.
 *
 * `attachTo` (Phase 3b source (c), `MW_COMBINE`,
 * docs/recordings-phase3b-combine-spec.md §API): `{ meetingId, offsetMs?,
 * textPolicy? }` says these bytes are a SECOND recording of a meeting that
 * already exists. The upload runs exactly as it does without it — own
 * recording, own transcription, own meeting document — and is added to that
 * meeting as a clip when the transcription lands. Resolved HERE, before a
 * byte moves (`resolveAttachTarget`): 404 for a meeting the caller cannot
 * open, 403 read-only, 409 when it has no recording, is full, is in the trash
 * or the flag is off, 400 for a junk offset — a person must hear "no" before
 * they spend twenty minutes uploading, not after. A RESUMED session keeps the
 * marker it was opened with, like every other frozen field.
 *
 * The same file, again (MW_SAME_FILE_CHECK, docs/recordings-same-file-spec.md):
 * a client that says `dupAware: true` may get ONE other 200 answer,
 * `{ duplicate: { meetingId, title, when, status, durationSec, trashed } }`,
 * with nothing created at all — the caller already has a live recording of
 * these exact bytes. `force: true` on the re-send goes ahead. The hash is
 * `sha256` for a single file and `multi.partSha256` (every part, in order,
 * declared on index 1) for a group, whose identity is
 * `sha256(part hashes joined by '\n')`. Without a hash here the check happens
 * at …/complete instead. A client that does not say `dupAware` never sees
 * this answer — the tray, darth-cli and older tabs are version-gated by it.
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
  const tracks = parseUploadTracks(body.tracks);
  if (tracks === null) {
    return NextResponse.json(
      { error: 'Invalid tracks (expected {count: non-negative integer, mixFirst: boolean})' },
      { status: 400 }
    );
  }
  // Phase 3b source (c): resolved against the target meeting immediately, so
  // the refusal arrives before the bytes rather than after them.
  const attachRequest = parseAttachTo(body.attachTo);
  if (attachRequest === null) {
    return NextResponse.json(
      { error: 'Invalid attachTo (expected { meetingId, offsetMs?, textPolicy? })' },
      { status: 400 }
    );
  }
  let attachTo: AttachToMarker | null = null;
  if (attachRequest) {
    const resolved = await resolveAttachTarget(user, attachRequest);
    if (!resolved.ok) return NextResponse.json(resolved.body, { status: resolved.status });
    attachTo = resolved.marker;
  }

  // The Darth Recorder registry row (migration 041): must be the caller's own.
  let recorderRecordingId: string | null = null;
  // D2: the match, kept as a SUGGESTION. D1 removed the auto-link that used
  // to turn it into `linkedEvent` here.
  let suggestedEvent: SuggestedEvent | null = null;
  let recorderBirth: RecorderOpenFacts['recorderBirth'] | null = null;
  if (typeof body.recorderRecordingId === 'string' && body.recorderRecordingId) {
    // D1: the recording is born as the CALL, not as some meeting.
    const facts = await recorderOpenFacts(user.userId, body.recorderRecordingId);
    if (!facts) return NextResponse.json({ error: 'Recorder recording not found' }, { status: 404 });
    recorderRecordingId = facts.id;
    recorderBirth = facts.recorderBirth;
    suggestedEvent = facts.suggestedEvent;
  }
  const rawMulti = body.multi as Record<string, unknown> | undefined | null;
  const multi = rawMulti
    ? parseMultiParams({
        group: typeof rawMulti.group === 'string' ? rawMulti.group : null,
        index: rawMulti.index as string | number | null,
        total: rawMulti.total as string | number | null,
        comment: typeof rawMulti.comment === 'string' ? rawMulti.comment : null,
        groupBytes: rawMulti.groupBytes as string | number | null,
        // The whole recording's part hashes, declared on part 1 — see
        // docs/recordings-same-file-spec.md.
        partSha256: rawMulti.partSha256,
      })
    : undefined;
  if (multi === null) {
    return NextResponse.json({ error: 'Invalid multi-upload parameters' }, { status: 400 });
  }
  if (multi?.groupBytes !== undefined && multi.groupBytes < size) {
    return NextResponse.json(
      { error: `multi.groupBytes (${multi.groupBytes}) must be at least this part's size (${size})` },
      { status: 400 }
    );
  }

  // D1 (docs/recorder-link-confirm-spec.md) — THE SERVER NEVER LINKS BY
  // ITSELF. Until 2026-09-22 a confident recorder match was resolved into
  // `linkedEvent` right here, and the placeholder was born with that event's
  // title, date, attendees and auto-shares: a private Slack huddle went out
  // to 8 people with edit access because the clocks overlapped. Linking is a
  // user action now — the tray asks before it uploads, the web asks on the
  // row — and the match survives only as `suggestedEvent` (D2), which
  // nothing acts on. A group carries the suggestion on part 1 only; later
  // parts land on its row.
  if (linkedEvent || (multi && multi.index > 1)) suggestedEvent = null;

  const rejected = textDocRejection(originalFilename, contentType);
  if (rejected) return NextResponse.json({ error: rejected }, { status: 415 });

  // --- The same file, again (docs/recordings-same-file-spec.md). ---
  //
  // The hash is known HERE for a blob-transit upload (the client always sends
  // it), for a small web upload the browser hashed itself, and for a group
  // whose client declared every part's hash on index 1 (the tray). So the
  // answer costs nothing before any bytes move. Everything else is checked at
  // complete, from the temp file, still before the AssemblyAI hand-off.
  //
  // A match means NOTHING is created: no placeholder, no session, no temp
  // file — HTTP 200 with the match, and the client decides. `force: true` on
  // the re-send skips this and today's behaviour resumes.
  //
  // PRIVACY: the lookup is the caller's own recordings only, and a hash that
  // exists under a DIFFERENT owner takes the same one indexed read and
  // produces the identical 201 below — the response the caller sees and the
  // work the server did are the same as for a hash nobody has.
  const openIdentity = multi
    ? multi.index === 1 && multi.partSha256
      ? uploadIdentityHash({ partSha256: multi.partSha256 })
      : null
    : uploadIdentityHash({ sha256 });
  const duplicate = await duplicateForUpload(user.userId, openIdentity, {
    dupAware: wantsDuplicateAnswer(body),
    force: wantsForce(body),
  });
  if (duplicate) return NextResponse.json({ duplicate });

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
    // Frozen on the session: the chunk path's check runs at COMPLETE, where
    // this request's body is long gone. So does the track declaration, which
    // Stage C reads at complete time.
    dupAware: wantsDuplicateAnswer(body),
    tracks,
    attachTo,
    suggestedEvent,
    recorderBirth,
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
      // §3 of the contract: the match the server did NOT apply. The tray
      // shows it as "Link to '<title>'? [Link] [Not this]"; `linkedEvent` in
      // this answer is only ever the caller's own explicit link.
      ...(suggestedEvent ? { suggestedEvent } : {}),
    },
    { status: 201 }
  );
});
