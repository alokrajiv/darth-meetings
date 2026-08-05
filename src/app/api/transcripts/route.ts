import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  listVisibleToUser,
  setRecordedAtForUser,
  updateStatusForUser,
} from '@/db-ops/transcripts';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getTranscript } from '@/lib/server/assemblyai';
import {
  deleteAudioFile,
  saveAudioBytes,
  saveAudioStreamToTemp,
} from '@/lib/server/audio-storage';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import type { StoredTranscript } from '@/lib/format';

export const runtime = 'nodejs';
// Handler wall-clock budget (only enforced on serverless hosts). Receiving a
// multi-GB body over a slow uplink plus re-uploading it to AssemblyAI can
// take a while.
export const maxDuration = 900;

/**
 * GET /api/transcripts
 * List every transcript the caller can see: ones they own plus ones shared
 * with their email. Each row carries an `access` field so the UI can render
 * the All / Mine / Shared tabs and gate read-only vs editor controls.
 *
 * This is a DB-only, pure-Postgres path — no AssemblyAI calls. The query
 * deliberately omits the large `imported_content` JSONB so responses stay
 * small. Pending rows (queued/processing) are the only ones that hit AAI,
 * and only for status/duration/speaker-count. For a 100% DB experience,
 * the user can disable refresh by setting MW_LISTING_REFRESH_PENDING=false.
 */
export const GET = withAuth(async ({ user }) => {
  const rows = await listVisibleToUser(user.userId, user.email);

  // Refresh pending rows in parallel. Completed rows (the common case)
  // skip the network hop entirely — refreshIfPending short-circuits on
  // `status === 'completed'`. So for a list of 36 finished transcripts
  // this is still a pure-DB call.
  const pendingIdx = rows
    .map((r, i) => (r.status === 'completed' || r.status === 'error' ? -1 : i))
    .filter((i) => i >= 0);

  if (pendingIdx.length > 0) {
    await Promise.all(
      pendingIdx.map(async (i) => {
        const row = rows[i]!;
        try {
          const aai = await getTranscript(row.assemblyai_id);
          const speakerCount = aai.utterances
            ? new Set(aai.utterances.map((u) => u.speaker)).size
            : null;
          await updateStatusForUser(row.user_id, row.assemblyai_id, {
            status: aai.status,
            completedAt: aai.completed ? new Date(aai.completed) : null,
            duration: aai.audio_duration ?? null,
            speakerCount,
            languageCode: aai.language_code ?? null,
          });
          rows[i] = {
            ...row,
            status: aai.status,
            completed_at: aai.completed ?? row.completed_at,
            duration: aai.audio_duration ?? row.duration,
            speaker_count: speakerCount ?? row.speaker_count,
          };
          // First observation of completion → auto-notes + speaker
          // suggestions (fire-and-forget, owner-scoped).
          if (aai.status === 'completed') {
            onTranscriptCompleted(row.user_id, row.assemblyai_id);
          }
        } catch (err) {
          console.warn('[GET /api/transcripts] refresh failed for', row.assemblyai_id, err);
        }
      })
    );
  }

  return NextResponse.json({ transcripts: rows });
});

/**
 * POST /api/transcripts
 * Raw-body upload: the file bytes ARE the request body (streamed to disk,
 * constant memory — this is how multi-GB recordings survive). Metadata rides
 * alongside: `x-filename` header (URI-encoded) and `?language_code=` query
 * param. A legacy multipart/form-data body (`file` + `language_code` fields)
 * is still accepted for stale tabs, but that path buffers in memory — fine
 * for small files only.
 *
 * Either way the bytes land in a temp file first, then go to AssemblyAI via
 * the SDK's disk-streaming path, and finally get renamed to their permanent
 * `<aai-id>.<ext>` name once the transcription is accepted.
 *
 * `?source_id=` re-transcribes an existing text-only import (`ext-…` rows)
 * from a real recording: the uploaded bytes become a NEW transcript row
 * (the import stays untouched, same convention as the Meet re-diarize flow)
 * that inherits the source's title / language / recorded_at, with the
 * source's speaker names fed to AAI as recognition-bias keyterms. This
 * rides the raw-body endpoint on purpose — it is the one route excluded
 * from the proxy matcher, so a multi-GB video still streams to disk
 * instead of being buffered in memory by the middleware.
 */
export const POST = withAuth(async ({ user, request }) => {
  const contentType = request.headers.get('content-type') ?? '';

  let tempFilename: string;
  let originalFilename: string | null = null;
  let languageCode: string | undefined;
  let sourceRow: StoredTranscript | null = null;

  if (contentType.includes('multipart/form-data')) {
    // Legacy path — whole body in memory. Kept only so an already-open old
    // client doesn't break; the shipped client sends raw bodies.
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      return NextResponse.json(
        { error: 'Invalid multipart body', detail: String(error) },
        { status: 400 }
      );
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing `file` field' }, { status: 400 });
    }
    const rawLang = form.get('language_code');
    languageCode =
      typeof rawLang === 'string' && rawLang.length > 0 ? rawLang : undefined;
    originalFilename = file.name || null;

    tempFilename = `upload-${crypto.randomUUID()}.part`;
    await saveAudioBytes(tempFilename, Buffer.from(await file.arrayBuffer()));
  } else {
    if (!request.body) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }

    const rawName = request.headers.get('x-filename');
    if (rawName) {
      try {
        originalFilename = decodeURIComponent(rawName);
      } catch {
        originalFilename = rawName;
      }
    }
    const rawLang = request.nextUrl.searchParams.get('language_code');
    languageCode = rawLang && rawLang.length > 0 ? rawLang : undefined;

    // Re-transcription of an existing import: resolve the source row BEFORE
    // consuming the (potentially huge) body so a bad id fails fast.
    const sourceId = request.nextUrl.searchParams.get('source_id');
    if (sourceId) {
      const access = await resolveAccess(user.userId, user.email, sourceId);
      if (!access) {
        return NextResponse.json({ error: 'Source transcript not found' }, { status: 404 });
      }
      sourceRow = access.row;
      languageCode = languageCode ?? sourceRow.language_code ?? undefined;
    }

    let bytes: number;
    try {
      ({ tempFilename, bytes } = await saveAudioStreamToTemp(request.body));
    } catch (error) {
      console.error('[POST /api/transcripts] body stream failed:', error);
      return NextResponse.json(
        { error: 'Upload stream failed', detail: String(error) },
        { status: 400 }
      );
    }
    if (bytes === 0) {
      await deleteAudioFile(tempFilename);
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }
  }

  // Shared tail: AAI upload (disk-streamed) → vocab-biased submit → DB row →
  // rename temp file to its permanent name. Same path as the Meet import.
  try {
    // Speaker names from the source import (Teams/Zoom/… labels) are exactly
    // the words AAI tends to mis-hear — feed them in as bias keyterms.
    const sourceSpeakers = [
      ...new Set(
        (sourceRow?.imported_content?.utterances ?? [])
          .map((u) => u.speaker?.trim())
          .filter((s): s is string => !!s && s.length > 1 && !/^speaker\s*\d+$/i.test(s))
      ),
    ];

    const row = await ingestLocalAudio(user.userId, tempFilename, {
      originalFilename,
      languageCode,
      title: sourceRow?.title ?? null,
      extraKeyterms: sourceSpeakers.length > 0 ? sourceSpeakers : undefined,
    });
    if (sourceRow?.recorded_at) {
      await setRecordedAtForUser(
        user.userId,
        row.assemblyai_id,
        new Date(sourceRow.recorded_at)
      ).catch(() => {});
    }
    return NextResponse.json({ transcript: row }, { status: 201 });
  } catch (error) {
    if (error instanceof IngestError) {
      console.error(`[POST /api/transcripts] ${error.stage} failed:`, error.causeErr);
      return NextResponse.json(
        { error: error.message, detail: String(error.causeErr) },
        { status: 502 }
      );
    }
    throw error;
  }
});
