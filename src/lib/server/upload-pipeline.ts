import 'server-only';
import {
  createUploadingPlaceholder,
  deleteForUser,
  findUploadGroupRow,
  getForUser,
  mergeGmeetContextForUser,
  setRecordedAtForUser,
  updateUploadProgress,
} from '@/db-ops/transcripts';
import { autoShareToInternalInvitees } from '@/lib/server/auto-share';
import { resolveAccess } from '@/db-ops/transcript-access';
import { deleteAudioFile, deleteAudioFilesByPrefix } from '@/lib/server/audio-storage';
import { concatMediaSmart, probeDurationSec } from '@/lib/server/media-concat';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import type { GmeetAttendee, GmeetContext, StoredTranscript } from '@/lib/format';
import type { DarthUser } from '@/lib/auth/session';
import type { SpeechModel } from '@/lib/aai-language';

/**
 * The media-upload pipeline shared by the two byte-delivery routes:
 *
 *   - POST /api/transcripts (legacy raw body: the whole file in one request)
 *   - POST /api/uploads → PUT /api/uploads/:id/chunks/:n → POST …/complete
 *     (chunked, parallel, resumable — the shipped client)
 *
 * Both produce the same thing: a temp file in the audio dir plus a frozen
 * `UploadSpec`, then `finalizeUpload` runs the identical tail (multi-file
 * group bookkeeping / stitch, AAI ingest, placeholder promotion). Keeping
 * the tail here means resume can never drift from the one-shot path.
 */

/** Calendar event the upload-media stepper linked to this file. Shape
 * mirrors the Meet import's event payload. */
export interface LinkedEventInput {
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

export type ReportPref = NonNullable<NonNullable<GmeetContext['uploadPrefs']>['report']>;
const REPORT_PREFS = new Set<string>(['summary', 'detailed-video', 'detailed-text', 'later']);

export function parseReportPref(raw: string | null | undefined): ReportPref | null {
  return raw && REPORT_PREFS.has(raw) ? (raw as ReportPref) : null;
}

export function sanitizeLinkedEvent(parsed: unknown): LinkedEventInput | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const ev = { ...(parsed as LinkedEventInput) };
  if (ev.startTime && Number.isNaN(Date.parse(ev.startTime))) ev.startTime = undefined;
  if (ev.endTime && Number.isNaN(Date.parse(ev.endTime))) ev.endTime = undefined;
  return ev;
}

/** `x-linked-event` header: URI-encoded JSON (the body is the raw file). */
export function parseLinkedEventHeader(raw: string | null): LinkedEventInput | null {
  if (!raw) return null;
  try {
    return sanitizeLinkedEvent(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return null;
  }
}

/** Text documents AAI can't transcode — streaming one here dies minutes
 * later as an opaque AAI error row (the sibl_minutes.rtf incident). The
 * client diverts these to /api/transcripts/import-text itself; this is the
 * belt for older tabs, darth-cli and anything else hitting the API raw. */
const TEXT_DOC_FILE_RE =
  /\.(txt|md|markdown|rtf|vtt|srt|docx|doc|pdf|json|csv|tsv|html|htm|log)$/i;
const TEXT_DOC_MIMES = new Set([
  'application/rtf',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/** Returns the 415 message when the file is a text document, else null. */
export function textDocRejection(
  originalFilename: string | null,
  contentType: string
): string | null {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const isTextDoc =
    (originalFilename && TEXT_DOC_FILE_RE.test(originalFilename)) ||
    mime.startsWith('text/') ||
    TEXT_DOC_MIMES.has(mime);
  if (!isTextDoc) return null;
  return `${originalFilename ?? 'That file'} is a text document, not a recording — import it via POST /api/transcripts/import-text (the upload dialog's transcript lane) instead.`;
}

export interface MultiParams {
  group: string;
  index: number;
  total: number;
  comment?: string;
}

/** Validate multi-file single-meeting group params. `undefined` = not a
 * multi upload; `null` = present but invalid (400). */
export function parseMultiParams(raw: {
  group?: string | null;
  index?: string | number | null;
  total?: string | number | null;
  comment?: string | null;
}): MultiParams | null | undefined {
  const present =
    (raw.group !== undefined && raw.group !== null && raw.group !== '') ||
    (raw.index !== undefined && raw.index !== null && raw.index !== '');
  if (!present) return undefined;
  const group = raw.group ?? '';
  const index = Number(raw.index ?? NaN);
  const total = Number(raw.total ?? NaN);
  const ok =
    /^[0-9a-f-]{8,64}$/i.test(group) &&
    Number.isInteger(index) &&
    Number.isInteger(total) &&
    total >= 2 &&
    total <= 12 &&
    index >= 1 &&
    index <= total;
  if (!ok) return null;
  const comment = raw.comment?.trim().slice(0, 500) || undefined;
  return { group, index, total, comment };
}

/** Everything `finalizeUpload` needs — JSON-safe so a chunked session can
 * freeze it at open time and replay it at complete time. */
export interface UploadSpec {
  /** `up-<uuid>` — own placeholder, or the group's row for multi parts >1. */
  placeholderId: string;
  tempFilename: string;
  originalFilename: string | null;
  languageCode?: string;
  linkedEvent: LinkedEventInput | null;
  reportPref: ReportPref | null;
  /** Re-transcription source (`ext-…` import) — see POST /api/transcripts. */
  sourceId: string | null;
  multi: MultiParams | null;
  /** AAI model override (re-transcribe with the newer model); default = current. */
  speechModel?: SpeechModel;
}

export interface OpenUploadInput {
  originalFilename: string | null;
  contentType: string;
  languageCode?: string;
  linkedEvent: LinkedEventInput | null;
  reportPref: ReportPref | null;
  sourceId?: string | null;
  multi?: MultiParams | null;
  /** Total bytes expected (content-length / declared size) — listing progress. */
  bytesTotal: number | null;
  /** Pin the placeholder uuid (chunked sessions reuse it as the session id). */
  uuid?: string;
  /** AAI model override — see UploadSpec.speechModel. */
  speechModel?: SpeechModel;
  /** Extra gmeet_context keys stamped on the placeholder (provenance such as
   * retranscribedFrom, or the source row's meeting identity on a re-run). */
  contextExtra?: Partial<GmeetContext> | null;
}

export type OpenUploadResult =
  | { ok: true; spec: UploadSpec; placeholder: StoredTranscript }
  | { ok: false; status: number; error: string };

function buildGmeetContext(
  linkedEvent: LinkedEventInput | null,
  reportPref: ReportPref | null
): { gmeetContext: GmeetContext | null; attendees: GmeetAttendee[]; attendeeNames: string[] } {
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
  return { gmeetContext, attendees, attendeeNames };
}

/**
 * Stage 1 — before any bytes: validate, resolve the re-transcription source,
 * and either create the live-visibility placeholder row (single file / part
 * 1 of a group) or locate the group's row (parts 2..N). Returns the frozen
 * spec the byte-delivery route writes against.
 */
export async function openUpload(
  user: DarthUser,
  input: OpenUploadInput
): Promise<OpenUploadResult> {
  const rejected = textDocRejection(input.originalFilename, input.contentType);
  if (rejected) return { ok: false, status: 415, error: rejected };

  const multi = input.multi ?? null;
  let languageCode = input.languageCode;

  // Re-transcription of an existing import: resolve the source row BEFORE
  // the (potentially huge) body so a bad id fails fast.
  let sourceRow: StoredTranscript | null = null;
  if (input.sourceId) {
    const access = await resolveAccess(user.userId, user.email, input.sourceId);
    if (!access) return { ok: false, status: 404, error: 'Source transcript not found' };
    sourceRow = access.row;
    languageCode = languageCode ?? sourceRow.language_code ?? undefined;
  }

  if (multi && multi.index > 1) {
    const groupRow = await findUploadGroupRow(user.userId, multi.group);
    if (!groupRow) {
      return { ok: false, status: 404, error: 'Upload group not found (expired or reaped)' };
    }
    const group = groupRow.gmeet_context?.uploadGroup;
    if (!group || group.total !== multi.total || group.parts.some((p) => p.index === multi.index)) {
      return { ok: false, status: 409, error: 'Upload group state mismatch' };
    }
    const groupUuid = groupRow.assemblyai_id.slice(3);
    return {
      ok: true,
      placeholder: groupRow,
      spec: {
        placeholderId: groupRow.assemblyai_id,
        tempFilename: `upload-${groupUuid}.part${multi.index}`,
        originalFilename: input.originalFilename,
        languageCode,
        linkedEvent: null,
        reportPref: null,
        sourceId: null,
        multi,
      },
    };
  }

  const { gmeetContext, attendees } = buildGmeetContext(input.linkedEvent, input.reportPref);

  // Create the row BEFORE the bytes so the upload is visible in the listing
  // (owner + auto-shared invitees) from the first byte. The temp filename
  // shares the placeholder's uuid so the stale-upload sweeper can find and
  // delete the file when reaping an orphaned row.
  const uploadUuid = input.uuid ?? crypto.randomUUID();
  const placeholderId = `up-${uploadUuid}`;
  const tempFilename = `upload-${uploadUuid}.part`;

  const placeholder = await createUploadingPlaceholder(user.userId, {
    placeholderId,
    originalFilename: input.originalFilename,
    languageCode: languageCode ?? null,
    title: sourceRow?.title ?? input.linkedEvent?.title?.slice(0, 300) ?? null,
    gmeetContext: multi
      ? {
          ...(gmeetContext ?? {}),
          uploadGroup: {
            id: multi.group,
            total: multi.total,
            parts: [
              {
                index: 1,
                tempFilename,
                originalFilename: input.originalFilename ?? undefined,
                comment: multi.comment,
              },
            ],
          },
        }
      : input.contextExtra
        ? { ...(gmeetContext ?? {}), ...input.contextExtra }
        : gmeetContext,
    bytesTotal: input.bytesTotal,
  });
  // Same "throw them in" rule as the Meet import: internal invitees on the
  // linked event can see (and follow) the upload from the moment it starts.
  if (attendees.length > 0) {
    await autoShareToInternalInvitees(placeholder.id, user.userId, user.email, attendees).catch(
      (err) => console.warn('[upload] auto-share failed:', err)
    );
  }
  const earlyRecordedAt = sourceRow?.recorded_at ?? input.linkedEvent?.startTime;
  if (earlyRecordedAt) {
    await setRecordedAtForUser(user.userId, placeholderId, new Date(earlyRecordedAt)).catch(
      () => {}
    );
  }

  return {
    ok: true,
    placeholder,
    spec: {
      placeholderId,
      tempFilename,
      originalFilename: input.originalFilename,
      languageCode,
      linkedEvent: input.linkedEvent,
      reportPref: input.reportPref,
      sourceId: input.sourceId ?? null,
      multi,
      speechModel: input.speechModel,
    },
  };
}

/** Delete what `openUpload` created when the bytes never (fully) arrived. */
export async function abandonUpload(user: DarthUser, spec: UploadSpec): Promise<void> {
  if (spec.multi && spec.multi.index > 1) {
    await deleteAudioFile(spec.tempFilename);
    return;
  }
  await deleteAudioFile(spec.tempFilename);
  await deleteForUser(user.userId, spec.placeholderId).catch(() => {});
}

export interface FinalizeResult {
  status: number;
  body: { transcript: StoredTranscript } | { error: string; detail?: string };
}

/**
 * Stage 2 — the temp file is complete on disk. Multi-file groups: park the
 * part (or stitch + ingest when it's the last one). Everything else: AAI
 * ingest with the placeholder promoted in place. Never throws for the
 * expected failure modes — returns the HTTP status + body to send.
 */
export async function finalizeUpload(
  user: DarthUser,
  spec: UploadSpec,
  bytes: number
): Promise<FinalizeResult> {
  const { placeholderId, tempFilename, multi } = spec;

  if (multi && multi.index > 1) {
    const groupRow = await findUploadGroupRow(user.userId, multi.group);
    if (!groupRow || groupRow.assemblyai_id !== placeholderId) {
      await deleteAudioFile(tempFilename);
      return { status: 404, body: { error: 'Upload group not found (expired or reaped)' } };
    }
    const group = groupRow.gmeet_context?.uploadGroup;
    if (!group || group.total !== multi.total || group.parts.some((p) => p.index === multi.index)) {
      await deleteAudioFile(tempFilename);
      return { status: 409, body: { error: 'Upload group state mismatch' } };
    }
    const groupUuid = groupRow.assemblyai_id.slice(3);
    const parts = [
      ...group.parts,
      {
        index: multi.index,
        tempFilename,
        originalFilename: spec.originalFilename ?? undefined,
        comment: multi.comment,
        bytes,
      },
    ].sort((a, b) => a.index - b.index);
    await mergeGmeetContextForUser(
      user.userId,
      groupRow.assemblyai_id,
      { uploadGroup: { ...group, parts } },
      { quiet: true }
    );
    await updateUploadProgress(user.userId, groupRow.assemblyai_id, bytes).catch(() => {});

    if (multi.index < multi.total) {
      return { status: 201, body: { transcript: groupRow } };
    }

    // Last part landed: stitch in index order and ingest as ONE transcript.
    if (new Set(parts.map((p) => p.index)).size !== multi.total) {
      return {
        status: 409,
        body: { error: `Upload group incomplete (${parts.length}/${multi.total} parts)` },
      };
    }
    const heartbeat = setInterval(() => {
      void updateUploadProgress(user.userId, groupRow.assemblyai_id).catch(() => {});
    }, 60_000);
    heartbeat.unref?.();
    try {
      const durations: Array<number | null> = [];
      for (const p of parts) durations.push(await probeDurationSec(p.tempFilename));
      let offset = 0;
      const uploadedParts = parts.map((p, i) => {
        const entry = {
          index: p.index,
          originalFilename: p.originalFilename,
          comment: p.comment,
          durationSec: durations[i] ?? undefined,
          offsetSec: Math.round(offset * 10) / 10,
        };
        offset += durations[i] ?? 0;
        return entry;
      });
      const { filename: combinedTemp, reencoded } = await concatMediaSmart(
        parts.map((p) => p.tempFilename)
      );
      console.log(
        `[upload] stitched ${multi.total} recordings for ${groupRow.assemblyai_id}` +
          (reencoded ? ' (re-encoded — mixed codecs)' : ' (stream-copy)')
      );
      for (const p of parts) await deleteAudioFile(p.tempFilename);
      // Persist the stitch map on the row BEFORE ingest — the placeholder
      // is promoted in place, context intact, so the map survives.
      await mergeGmeetContextForUser(
        user.userId,
        groupRow.assemblyai_id,
        { uploadGroup: null, uploadedParts },
        { quiet: true }
      );
      const ctx = groupRow.gmeet_context ?? {};
      const groupAttendeeNames = (ctx.attendees ?? [])
        .map((a) => a.name?.trim())
        .filter((n): n is string => !!n && n.length > 1);
      const ext = combinedTemp.slice(combinedTemp.lastIndexOf('.'));
      const row = await ingestLocalAudio(user.userId, combinedTemp, {
        originalFilename: `stitched-${multi.total}-recordings${ext}`,
        languageCode: spec.languageCode ?? groupRow.language_code ?? undefined,
        title: groupRow.title ?? null,
        extraKeyterms: groupAttendeeNames.length > 0 ? groupAttendeeNames : undefined,
        gmeetContext: { ...ctx, uploadGroup: null, uploadedParts },
        placeholderAssemblyaiId: groupRow.assemblyai_id,
      });
      return { status: 201, body: { transcript: row } };
    } catch (error) {
      await deleteForUser(user.userId, groupRow.assemblyai_id).catch(() => {});
      await deleteAudioFilesByPrefix(`upload-${groupUuid}.part`);
      if (error instanceof IngestError) {
        console.error(`[upload] ${error.stage} failed:`, error.causeErr);
        return { status: 502, body: { error: error.message, detail: String(error.causeErr) } };
      }
      console.error('[upload] stitch failed:', error);
      return {
        status: 502,
        body: { error: 'Stitching the recordings failed', detail: String(error) },
      };
    } finally {
      clearInterval(heartbeat);
    }
  }

  // Final progress write so viewers see 100% while the AAI re-upload leg runs.
  await updateUploadProgress(user.userId, placeholderId, bytes).catch(() => {});

  if (multi) {
    // Part 1 of a multi-file group: the bytes are parked, the group marker
    // is on the placeholder — ingest waits for the last part.
    const row = await getForUser(user.userId, placeholderId);
    if (!row) return { status: 404, body: { error: 'Upload placeholder vanished' } };
    return { status: 201, body: { transcript: row } };
  }

  // Shared tail: AAI upload (disk-streamed) → vocab-biased submit → DB row
  // (placeholder promoted in place) → rename temp file to its permanent
  // name. Same path as the Meet import.
  let sourceRow: StoredTranscript | null = null;
  if (spec.sourceId) {
    const access = await resolveAccess(user.userId, user.email, spec.sourceId);
    sourceRow = access?.row ?? null;
  }
  const { gmeetContext, attendeeNames } = buildGmeetContext(spec.linkedEvent, spec.reportPref);
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
    const heartbeat = setInterval(() => {
      void updateUploadProgress(user.userId, placeholderId).catch(() => {});
    }, 60_000);
    heartbeat.unref?.();
    let row;
    try {
      row = await ingestLocalAudio(user.userId, tempFilename, {
        originalFilename: spec.originalFilename,
        languageCode: spec.languageCode,
        title: sourceRow?.title ?? spec.linkedEvent?.title?.slice(0, 300) ?? null,
        extraKeyterms:
          sourceSpeakers.length > 0 || attendeeNames.length > 0
            ? [...sourceSpeakers, ...attendeeNames]
            : undefined,
        gmeetContext,
        placeholderAssemblyaiId: placeholderId,
        speechModel: spec.speechModel,
      });
    } finally {
      clearInterval(heartbeat);
    }
    const recordedAt = sourceRow?.recorded_at ?? spec.linkedEvent?.startTime;
    if (recordedAt) {
      await setRecordedAtForUser(user.userId, row.assemblyai_id, new Date(recordedAt)).catch(
        () => {}
      );
    }
    return { status: 201, body: { transcript: row } };
  } catch (error) {
    // A failed ingest leaves the placeholder stuck at 'uploading' — remove it
    // so viewers see the upload vanish rather than a zombie row. (No-op once
    // promoted: the row's id is the real AAI one by then.)
    await deleteForUser(user.userId, placeholderId).catch(() => {});
    if (error instanceof IngestError) {
      console.error(`[upload] ${error.stage} failed:`, error.causeErr);
      return { status: 502, body: { error: error.message, detail: String(error.causeErr) } };
    }
    throw error;
  }
}
