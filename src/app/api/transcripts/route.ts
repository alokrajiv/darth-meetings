import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  createUploadingPlaceholder,
  deleteForUser,
  listDeletedForUser,
  listPagedForUser,
  listPendingVisibleToUser,
  listVisibleToUser,
  setRecordedAtForUser,
  updateStatusForUser,
  updateUploadProgress,
  type PendingRefreshRow,
} from '@/db-ops/transcripts';
import { autoShareToInternalInvitees } from '@/lib/server/auto-share';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getTranscript } from '@/lib/server/assemblyai';
import {
  deleteAudioFile,
  saveAudioBytes,
  saveAudioStreamToTemp,
} from '@/lib/server/audio-storage';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import type { GmeetAttendee, GmeetContext, StoredTranscript } from '@/lib/format';

/** Calendar event the upload-media stepper linked to this file — rides in
 * the `x-linked-event` header (URI-encoded JSON) because the body is the
 * raw file bytes. Shape mirrors the Meet import's event payload. */
interface LinkedEventHeader {
  id?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  meetingCode?: string;
  recurringEventId?: string;
  iCalUID?: string;
  organizerEmail?: string;
  attendees?: Array<{ email?: string; name?: string; responseStatus?: string }>;
}

function parseLinkedEventHeader(raw: string | null): LinkedEventHeader | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as LinkedEventHeader;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.startTime && Number.isNaN(Date.parse(parsed.startTime))) {
      parsed.startTime = undefined;
    }
    if (parsed.endTime && Number.isNaN(Date.parse(parsed.endTime))) {
      parsed.endTime = undefined;
    }
    return parsed;
  } catch {
    return null;
  }
}

const REPORT_PREFS = new Set(['summary', 'detailed-video', 'detailed-text', 'later']);

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
 * Params: tab=all|mine|shared|trash, from/to (YYYY-MM-DD in tz), tz (IANA),
 * q (>= 2 chars → server-side search with matched_in/snippet), days (max day
 * buckets, default 14 cap 60), minRows (soft row target, default 40 cap 200),
 * cursor (exclusive day key — only strictly older days). Envelope:
 * TranscriptListV2Response (src/lib/format.ts).
 */
async function listingV2(
  user: { userId: string; email: string },
  params: URLSearchParams
) {
  const tabRaw = params.get('tab');
  const tab =
    tabRaw === 'mine' || tabRaw === 'shared' || tabRaw === 'trash' ? tabRaw : 'all';
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
  const qRaw = (params.get('q') ?? '').trim();
  const q = qRaw.length >= 2 ? qRaw : null;
  const days = clampInt(params.get('days'), 14, 1, 60);
  const minRows = clampInt(params.get('minRows'), 40, 1, 200);

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
 * Without it the legacy shape (`{transcripts: [...]}` full array, `?trash=1`)
 * is preserved byte-for-byte — darth-cli consumes it.
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

  // Upload-media stepper extras ride in headers/query, so they're available
  // BEFORE the body is consumed — the live-visibility placeholder row needs
  // the linked event's title and invitees up front.
  const linkedEvent = parseLinkedEventHeader(request.headers.get('x-linked-event'));
  const rawPref = request.nextUrl.searchParams.get('report_pref');
  const reportPref =
    rawPref && REPORT_PREFS.has(rawPref)
      ? (rawPref as NonNullable<NonNullable<GmeetContext['uploadPrefs']>['report']>)
      : null;
  // Invitee names from the linked event double as AAI bias keyterms — they
  // are exactly the names AAI would otherwise mis-hear.
  const attendees: GmeetAttendee[] = (linkedEvent?.attendees ?? [])
    .filter((a): a is { email: string; name?: string; responseStatus?: string } =>
      typeof a?.email === 'string'
    )
    .slice(0, 100)
    .map((a) => ({ email: a.email, name: a.name, responseStatus: a.responseStatus }));
  const attendeeNames = attendees
    .map((a) => a.name?.trim())
    .filter((n): n is string => !!n && n.length > 1);

  const gmeetContext: GmeetContext | null =
    linkedEvent || reportPref
      ? {
          ...(linkedEvent
            ? {
                eventId: linkedEvent.id,
                eventTitle: linkedEvent.title?.slice(0, 300),
                startTime: linkedEvent.startTime,
                endTime: linkedEvent.endTime,
                meetingCode: linkedEvent.meetingCode,
                recurringEventId: linkedEvent.recurringEventId,
                iCalUID: linkedEvent.iCalUID,
                organizerEmail: linkedEvent.organizerEmail,
                attendees,
              }
            : {}),
          ...(reportPref ? { uploadPrefs: { report: reportPref } } : {}),
        }
      : null;

  let tempFilename: string;
  let originalFilename: string | null = null;
  let languageCode: string | undefined;
  let sourceRow: StoredTranscript | null = null;
  /** Set on the raw-body path: the `up-<uuid>` id of the placeholder row
   * that makes this upload visible in every listing while bytes stream. */
  let placeholderId: string | null = null;

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

    // Create the row BEFORE consuming the body so the upload is visible in
    // the listing (owner + auto-shared invitees) from the first byte. The
    // temp filename shares the placeholder's uuid so the stale-upload
    // sweeper can find and delete the file when reaping an orphaned row.
    const uploadUuid = crypto.randomUUID();
    placeholderId = `up-${uploadUuid}`;
    tempFilename = `upload-${uploadUuid}.part`;
    const rawLen = request.headers.get('content-length');
    const bytesTotal = rawLen && /^\d+$/.test(rawLen) ? Number(rawLen) : null;

    const placeholder = await createUploadingPlaceholder(user.userId, {
      placeholderId,
      originalFilename,
      languageCode: languageCode ?? null,
      title: sourceRow?.title ?? linkedEvent?.title?.slice(0, 300) ?? null,
      gmeetContext,
      bytesTotal,
    });
    // Same "throw them in" rule as the Meet import: internal invitees on the
    // linked event can see (and follow) the upload from the moment it starts.
    if (attendees.length > 0) {
      await autoShareToInternalInvitees(
        placeholder.id,
        user.userId,
        user.email,
        attendees
      ).catch((err) => console.warn('[POST /api/transcripts] auto-share failed:', err));
    }
    const earlyRecordedAt = sourceRow?.recorded_at ?? linkedEvent?.startTime;
    if (earlyRecordedAt) {
      await setRecordedAtForUser(
        user.userId,
        placeholderId,
        new Date(earlyRecordedAt)
      ).catch(() => {});
    }

    // Debounced progress writes: at most one UPDATE every ~2s, never more
    // than one in flight. Each write publishes a 'status' SSE event, and the
    // listing's own 800ms debounce coalesces the refetches.
    let lastFlush = 0;
    let flushing = false;
    let pendingFlush: Promise<void> = Promise.resolve();
    const pid = placeholderId;
    const onProgress = (streamed: number) => {
      const now = Date.now();
      if (flushing || now - lastFlush < 2000) return;
      flushing = true;
      lastFlush = now;
      pendingFlush = updateUploadProgress(user.userId, pid, streamed)
        .catch(() => {})
        .finally(() => {
          flushing = false;
        });
    };

    let bytes: number;
    try {
      ({ bytes } = await saveAudioStreamToTemp(request.body, {
        tempFilename,
        onProgress,
      }));
    } catch (error) {
      console.error('[POST /api/transcripts] body stream failed:', error);
      await deleteForUser(user.userId, placeholderId).catch(() => {});
      return NextResponse.json(
        { error: 'Upload stream failed', detail: String(error) },
        { status: 400 }
      );
    }
    if (bytes === 0) {
      await deleteAudioFile(tempFilename);
      await deleteForUser(user.userId, placeholderId).catch(() => {});
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }
    // Final progress write (after any in-flight throttled one) so viewers see
    // 100% while the AAI re-upload leg runs.
    await pendingFlush;
    await updateUploadProgress(user.userId, placeholderId, bytes).catch(() => {});
  }

  // Shared tail: AAI upload (disk-streamed) → vocab-biased submit → DB row
  // (placeholder promoted in place on the raw-body path) → rename temp file
  // to its permanent name. Same path as the Meet import.
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

    // The AAI re-upload leg can run many minutes with no byte-count movement;
    // keep the placeholder's heartbeat alive so the stale-upload sweeper
    // doesn't reap a live row.
    const heartbeat = placeholderId
      ? setInterval(() => {
          void updateUploadProgress(user.userId, placeholderId!).catch(() => {});
        }, 60_000)
      : null;
    heartbeat?.unref?.();
    let row;
    try {
      row = await ingestLocalAudio(user.userId, tempFilename, {
        originalFilename,
        languageCode,
        title: sourceRow?.title ?? linkedEvent?.title?.slice(0, 300) ?? null,
        extraKeyterms:
          sourceSpeakers.length > 0 || attendeeNames.length > 0
            ? [...sourceSpeakers, ...attendeeNames]
            : undefined,
        gmeetContext,
        placeholderAssemblyaiId: placeholderId,
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    const recordedAt = sourceRow?.recorded_at ?? linkedEvent?.startTime;
    if (recordedAt) {
      await setRecordedAtForUser(
        user.userId,
        row.assemblyai_id,
        new Date(recordedAt)
      ).catch(() => {});
    }
    return NextResponse.json({ transcript: row }, { status: 201 });
  } catch (error) {
    // A failed ingest leaves the placeholder stuck at 'uploading' — remove it
    // so viewers see the upload vanish rather than a zombie row. (No-op once
    // promoted: the row's id is the real AAI one by then.)
    if (placeholderId) {
      await deleteForUser(user.userId, placeholderId).catch(() => {});
    }
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
