import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  listDeletedForUser,
  listPagedForUser,
  listPendingVisibleToUser,
  listVisibleToUser,
  updateStatusForUser,
  updateUploadProgress,
  type PendingRefreshRow,
} from '@/db-ops/transcripts';
import { getTranscript } from '@/lib/server/assemblyai';
import { saveAudioBytes, saveAudioStreamToTemp } from '@/lib/server/audio-storage';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import { parseMeetingFilters } from '@/lib/server/meeting-filters';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import { parseLabelFilter } from '@/lib/labels';
import {
  abandonUpload,
  finalizeUpload,
  openUpload,
  parseLinkedEventHeader,
  parseMultiParams,
  parseReportPref,
  textDocRejection,
} from '@/lib/server/upload-pipeline';

export const runtime = 'nodejs';
// Handler wall-clock budget (only enforced on serverless hosts). Receiving a
// multi-GB body over a slow uplink plus re-uploading it to AssemblyAI can
// take a while.
export const maxDuration = 900;

/**
 * Refresh rows still in flight at AssemblyAI, in parallel, patching each
 * refreshed row in place. Completed/error rows and the synthetic `up-…` /
 * `defer-…` placeholders (statuses 'uploading' / 'waiting' — AAI has never
 * heard of their ids) are skipped, so for an all-finished list this is a
 * no-op with zero network hops. Shared by the legacy full listing (which
 * passes every row) and the v2 path (which passes a dedicated pending-only
 * query's rows, decoupled from pagination). First observed completion fires
 * onTranscriptCompleted (auto-notes + speaker suggestions, fire-and-forget).
 */
async function refreshPendingAgainstAai<T extends PendingRefreshRow>(
  rows: T[]
): Promise<void> {
  const pendingIdx = rows
    .map((r, i) =>
      r.status === 'completed' ||
      r.status === 'error' ||
      r.status === 'uploading' ||
      r.status === 'waiting' ||
      r.assemblyai_id.startsWith('up-') ||
      r.assemblyai_id.startsWith('defer-') ||
      // Text-import placeholders normalize via the LLM in the background —
      // they sit in 'processing' but AAI has never heard of their ids.
      r.assemblyai_id.startsWith('ext-')
        ? -1
        : i
    )
    .filter((i) => i >= 0);

  if (pendingIdx.length === 0) return;

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

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Conservative allow-list for IANA zone names ('Asia/Singapore',
// 'America/Port-au-Prince', 'Etc/GMT+8'). Anything else falls back to UTC;
// the value is additionally proven resolvable before reaching SQL.
const TZ_RE = /^[A-Za-z0-9_/+-]{1,64}$/;

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * GET /api/transcripts?v=2 — day-bucketed pagination + unified search.
 * Params: tab=all|mine|shared|trash|scratch (scratch = the caller's visible
 * temporary rows, migration 042 — every other tab excludes them),
 * from/to (YYYY-MM-DD in tz), tz (IANA),
 * q (>= 2 chars → server-side search with matched_in/snippet), days (max day
 * buckets, default 14 cap 60), minRows (soft row target, default 40 cap 200),
 * cursor (exclusive day key — only strictly older days), plus the shared
 * people/provider filters participant / organizer / provider / speaker
 * (lib/server/meeting-filters — comma = OR, filters AND together, applied to
 * rows AND tab counts; bad provider → 400), and the label filter
 * label=<id|none> (+ exact=1; docs/labels-design.md §7 — subtree-inclusive
 * unless exact; bad values are ignored). Envelope:
 * TranscriptListV2Response (src/lib/format.ts); rows carry an optional
 * `participants` string[] (organizer + attendee emails) and `labels[]`.
 */
async function listingV2(
  user: { userId: string; email: string },
  params: URLSearchParams
) {
  const tabRaw = params.get('tab');
  const tab =
    tabRaw === 'mine' || tabRaw === 'shared' || tabRaw === 'trash' || tabRaw === 'scratch'
      ? tabRaw
      : 'all';
  const fromRaw = params.get('from');
  const toRaw = params.get('to');
  const cursorRaw = params.get('cursor');
  const from = fromRaw && DAY_KEY_RE.test(fromRaw) ? fromRaw : null;
  const to = toRaw && DAY_KEY_RE.test(toRaw) ? toRaw : null;
  const cursor = cursorRaw && DAY_KEY_RE.test(cursorRaw) ? cursorRaw : null;
  let tz = params.get('tz') ?? 'UTC';
  if (!TZ_RE.test(tz)) {
    tz = 'UTC';
  } else {
    // Reject names Postgres would error on ('Foo/Bar') before they hit SQL.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      tz = 'UTC';
    }
  }
  const parsed = parseMeetingFilters(params);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const filters = parsed.filters;
  // Same >= 2 chars rule as before — the parser applies it.
  const q = filters.q;
  const days = clampInt(params.get('days'), 14, 1, 60);
  const minRows = clampInt(params.get('minRows'), 40, 1, 200);
  const labelFilter = parseLabelFilter(params.get('label'), params.get('exact'));

  // Pending-refresh fan-out, decoupled from the page: refresh EVERY visible
  // in-flight row (usually zero) so rows outside the requested page keep
  // progressing. The paged query below then reads the fresh statuses.
  try {
    const pending = await listPendingVisibleToUser(user.userId, user.email);
    await refreshPendingAgainstAai(pending);
  } catch (err) {
    console.warn('[GET /api/transcripts?v=2] pending refresh failed:', err);
  }

  const result = await listPagedForUser(user.userId, user.email, {
    tab,
    from,
    to,
    tz,
    q,
    days,
    minRows,
    cursor,
    filters,
    labelFilter,
  });
  return NextResponse.json(result);
}

/**
 * GET /api/transcripts
 * List every transcript the caller can see: ones they own plus ones shared
 * with their email. Each row carries an `access` field so the UI can render
 * the All / Mine / Shared tabs and gate read-only vs editor controls.
 *
 * `?v=2` switches to the paginated day-bucketed listing (listingV2 above).
 * Without it the legacy shape (`{transcripts: [...]}` full array, `?trash=1`,
 * `?scratch=1` = the caller's visible temporary rows) is preserved
 * byte-for-byte — darth-cli consumes it. Temporary (scratch) rows never
 * appear in the default listing; every row carries `scratch`.
 *
 * This is a DB-only, pure-Postgres path — no AssemblyAI calls. The query
 * deliberately omits the large `imported_content` JSONB so responses stay
 * small. Pending rows (queued/processing) are the only ones that hit AAI,
 * and only for status/duration/speaker-count.
 */
export const GET = withAuth(async ({ user, request }) => {
  const params = new URL(request.url).searchParams;

  if (params.get('v') === '2') {
    return listingV2(user, params);
  }

  // ?trash=1: the caller's own soft-deleted rows (trash tab). Pure DB —
  // trashed rows never join the AAI refresh fan-out.
  if (params.get('trash') === '1') {
    return NextResponse.json({ transcripts: await listDeletedForUser(user.userId) });
  }

  // ?scratch=1: the caller's visible temporary rows (owned + shared) —
  // real transcripts, so still-transcribing ones join the AAI refresh.
  if (params.get('scratch') === '1') {
    const scratchRows = await listVisibleToUser(user.userId, user.email, { scratch: true });
    await refreshPendingAgainstAai(scratchRows);
    return NextResponse.json({ transcripts: scratchRows });
  }

  const rows = await listVisibleToUser(user.userId, user.email);

  // Refresh pending rows in parallel. Completed rows (the common case)
  // skip the network hop entirely, so for a list of 36 finished transcripts
  // this is still a pure-DB call.
  await refreshPendingAgainstAai(rows);

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
 * This is the ONE-SHOT delivery route (darth-cli, curl, older tabs). The
 * shipped web client uses the chunked, parallel, resumable route family
 * under /api/uploads instead — both end in the same
 * `finalizeUpload` tail (src/lib/server/upload-pipeline.ts).
 *
 * `?source_id=` re-transcribes an existing text-only import (`ext-…` rows)
 * from a real recording: the uploaded bytes become a NEW transcript row
 * (the import stays untouched, same convention as the Meet re-diarize flow)
 * that inherits the source's title / language / recorded_at, with the
 * source's speaker names fed to AAI as recognition-bias keyterms. This
 * rides the raw-body endpoint on purpose — it is excluded from the proxy
 * matcher, so a multi-GB video still streams to disk instead of being
 * buffered in memory by the middleware.
 *
 * `?scratch=1` creates a TEMPORARY transcript (migration 042): out of the
 * main listing, under the Temporary tab, auto-trashed after 30 days.
 * Ignored when the upload is pre-linked to a calendar event.
 */
export const POST = withAuth(async ({ user, request }) => {
  const contentType = request.headers.get('content-type') ?? '';
  const scratch = request.nextUrl.searchParams.get('scratch') === '1';
  // Two ways to pre-link the recording to a calendar event: the web stepper
  // sends the whole event (x-linked-event); headless callers (darth-cli
  // `upload --event <ref>`) send a meeting code / event key in ?event= and
  // the server resolves it from the caller's own calendar cache.
  let linkedEvent = parseLinkedEventHeader(request.headers.get('x-linked-event'));
  const eventRef = request.nextUrl.searchParams.get('event');
  if (eventRef) {
    const resolved = await resolveLinkedEventRef(user.userId, eventRef);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    linkedEvent = resolved.event;
  }
  const reportPref = parseReportPref(request.nextUrl.searchParams.get('report_pref'));
  // Darth Recorder (migration 041): the tray passes the registry id of the
  // recording it is uploading; the finalize tail stamps transcript_id +
  // status 'uploaded' on it. Accepted as a query param (either spelling) or
  // an equivalent header for clients that would rather not touch the URL.
  const recorderRecordingId =
    request.nextUrl.searchParams.get('recorderRecordingId') ??
    request.nextUrl.searchParams.get('recorder_recording_id') ??
    request.headers.get('x-recorder-recording-id');

  if (contentType.includes('multipart/form-data')) {
    // Legacy path — whole body in memory. Kept only so an already-open old
    // client doesn't break; the shipped clients send raw bodies / chunks.
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
    const languageCode =
      typeof rawLang === 'string' && rawLang.length > 0 ? rawLang : undefined;
    const originalFilename = file.name || null;
    const rejected = textDocRejection(originalFilename, file.type || '');
    if (rejected) return NextResponse.json({ error: rejected }, { status: 415 });

    const opened = await openUpload(user, {
      originalFilename,
      contentType: file.type || '',
      languageCode,
      linkedEvent,
      reportPref,
      bytesTotal: file.size,
      recorderRecordingId,
      scratch,
    });
    if (!opened.ok) return NextResponse.json({ error: opened.error }, { status: opened.status });
    await saveAudioBytes(opened.spec.tempFilename, Buffer.from(await file.arrayBuffer()));
    const done = await finalizeUpload(user, opened.spec, file.size);
    return NextResponse.json(done.body, { status: done.status });
  }

  if (!request.body) {
    return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
  }

  let originalFilename: string | null = null;
  const rawName = request.headers.get('x-filename');
  if (rawName) {
    try {
      originalFilename = decodeURIComponent(rawName);
    } catch {
      originalFilename = rawName;
    }
  }
  const rawLang = request.nextUrl.searchParams.get('language_code');
  const languageCode = rawLang && rawLang.length > 0 ? rawLang : undefined;

  // --- Multi-file single-meeting upload (N recordings of ONE meeting,
  // stitched server-side into one transcript). Files arrive sequentially,
  // each tagged ?multi_group/&multi_index/&multi_total; per-file user
  // comments ride in x-part-comment. ---
  let partComment: string | null = null;
  const rawComment = request.headers.get('x-part-comment');
  if (rawComment) {
    try {
      partComment = decodeURIComponent(rawComment);
    } catch {
      partComment = rawComment;
    }
  }
  const multi = parseMultiParams({
    group: request.nextUrl.searchParams.get('multi_group'),
    index: request.nextUrl.searchParams.get('multi_index'),
    total: request.nextUrl.searchParams.get('multi_total'),
    comment: partComment,
  });
  if (multi === null) {
    return NextResponse.json({ error: 'Invalid multi-upload parameters' }, { status: 400 });
  }

  const rawLen = request.headers.get('content-length');
  const bytesTotal = rawLen && /^\d+$/.test(rawLen) ? Number(rawLen) : null;

  const opened = await openUpload(user, {
    originalFilename,
    contentType,
    languageCode,
    linkedEvent,
    reportPref,
    sourceId: request.nextUrl.searchParams.get('source_id'),
    multi: multi ?? null,
    bytesTotal,
    recorderRecordingId,
    scratch,
  });
  if (!opened.ok) return NextResponse.json({ error: opened.error }, { status: opened.status });
  const { spec } = opened;

  // Debounced progress writes: at most one UPDATE every ~2s, never more
  // than one in flight. Each write publishes a 'status' SSE event, and the
  // listing's own 800ms debounce coalesces the refetches.
  let lastFlush = 0;
  let flushing = false;
  let pendingFlush: Promise<void> = Promise.resolve();
  const onProgress = (streamed: number) => {
    const now = Date.now();
    if (flushing || now - lastFlush < 2000) return;
    flushing = true;
    lastFlush = now;
    pendingFlush = updateUploadProgress(user.userId, spec.placeholderId, streamed)
      .catch(() => {})
      .finally(() => {
        flushing = false;
      });
  };

  let bytes: number;
  try {
    ({ bytes } = await saveAudioStreamToTemp(request.body, {
      tempFilename: spec.tempFilename,
      onProgress,
    }));
  } catch (error) {
    console.error('[POST /api/transcripts] body stream failed:', error);
    await abandonUpload(user, spec);
    return NextResponse.json(
      { error: 'Upload stream failed', detail: String(error) },
      { status: 400 }
    );
  }
  if (bytes === 0) {
    await abandonUpload(user, spec);
    return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
  }
  await pendingFlush;

  const done = await finalizeUpload(user, spec, bytes);
  return NextResponse.json(done.body, { status: done.status });
});
