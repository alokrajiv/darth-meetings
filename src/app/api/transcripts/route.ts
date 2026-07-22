import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  createForUser,
  listVisibleToUser,
  setLocalAudioPathForUser,
  updateStatusForUser,
} from '@/db-ops/transcripts';
import {
  uploadFile,
  submitTranscription,
  getTranscript,
} from '@/lib/server/assemblyai';
import {
  audioFilename,
  deleteAudioFile,
  renameAudioFile,
  resolveAudioPath,
  saveAudioBytes,
  saveAudioStreamToTemp,
} from '@/lib/server/audio-storage';
import { getForUser as getUserVocab } from '@/db-ops/user-vocab';
import { getCurrentPayload as getOrgVocabPayload } from '@/db-ops/org-vocab';
import { mergeVocabs } from '@/lib/server/vocab-merge';

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
 */
export const POST = withAuth(async ({ user, request }) => {
  const contentType = request.headers.get('content-type') ?? '';

  let tempFilename: string;
  let originalFilename: string | null = null;
  let languageCode: string | undefined;

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

  let audioUrl: string;
  try {
    // Path input → the SDK streams the file from disk.
    audioUrl = await uploadFile(resolveAudioPath(tempFilename));
  } catch (error) {
    console.error('[POST /api/transcripts] AAI upload failed:', error);
    await deleteAudioFile(tempFilename);
    return NextResponse.json(
      { error: 'Upload to AssemblyAI failed', detail: String(error) },
      { status: 502 }
    );
  }

  // Merge org + user vocab and pass to AAI as keyterms_prompt / custom_spelling.
  // This is what biases AAI's recognition toward company-specific terms and
  // employee names. Failures are non-fatal: we still submit, just without
  // the bias hints.
  let mergedVocab: ReturnType<typeof mergeVocabs> | null = null;
  try {
    const [orgVocabPayload, userVocab] = await Promise.all([
      getOrgVocabPayload(),
      getUserVocab(user.userId),
    ]);
    mergedVocab = mergeVocabs(orgVocabPayload, userVocab);
  } catch (error) {
    console.warn('[POST /api/transcripts] vocab merge failed (continuing without):', error);
  }

  let submitted: { id: string; status: string };
  try {
    submitted = await submitTranscription(audioUrl, {
      languageCode,
      keytermsPrompt: mergedVocab?.keyterms_prompt,
      customSpelling: mergedVocab?.custom_spelling,
    });
  } catch (error) {
    console.error('[POST /api/transcripts] AAI submit failed:', error);
    await deleteAudioFile(tempFilename);
    return NextResponse.json(
      { error: 'Transcription submission failed', detail: String(error) },
      { status: 502 }
    );
  }

  const row = await createForUser(user.userId, {
    assemblyaiId: submitted.id,
    originalFilename,
    status: submitted.status,
    languageCode: languageCode ?? null,
    audioUrl: audioUrl,
  });

  // Keep our own copy of the audio. AAI deletes uploaded audio immediately
  // after transcription, so their audio_url is useless for playback. The
  // bytes are already on disk as the temp file — just rename it to its
  // permanent name. We serve it via /api/transcripts/[id]/audio.
  try {
    const filename = audioFilename(submitted.id, originalFilename);
    await renameAudioFile(tempFilename, filename);
    await setLocalAudioPathForUser(user.userId, submitted.id, filename);
    row.local_audio_path = filename;
  } catch (error) {
    // Non-fatal: the transcription itself succeeded. Audio playback for this
    // row will fall back to (broken) remote URL until/unless we re-upload.
    console.error('[POST /api/transcripts] local audio rename failed:', error);
    await deleteAudioFile(tempFilename);
  }

  return NextResponse.json({ transcript: row }, { status: 201 });
});
