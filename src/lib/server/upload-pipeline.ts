import 'server-only';
import {
  createUploadingPlaceholder,
  deleteForUser,
  findUploadGroupRow,
  getForUser,
  mergeGmeetContextForUser,
  setRecordedAtForUser,
  setUploadPartBytesForUser,
  updateUploadProgress,
} from '@/db-ops/transcripts';
import { getOwnRecording, linkRecordingTranscript } from '@/db-ops/recorder';
import { recorderCallTitle } from '@/lib/recorder';
import { suggestedEventFromMatch } from '@/lib/server/recorder-match';
import { resolveAccess } from '@/db-ops/transcript-access';
import { deleteAudioFile, deleteAudioFilesByPrefix } from '@/lib/server/audio-storage';
import { concatMediaSmart, probeDurationSec } from '@/lib/server/media-concat';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { BlobIngestFailed, ingestBlobAudio, type BlobIngestSource } from '@/lib/server/aai-from-blob';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';
import { stampUploadIdentity } from '@/lib/server/same-file';
import { normalizePartSha256, normalizeSha256, partHashesInOrder, uploadIdentityHash } from '@/lib/same-file';
import type { GmeetAttendee, GmeetContext, StoredTranscript, SuggestedEvent } from '@/lib/format';
import type { DarthUser } from '@/lib/auth/session';
import type { SpeechModel } from '@/lib/aai-language';
import type { ReportPref } from '@/lib/report-pref';
import type { AttachToMarker } from '@/lib/clips';

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

/** The generation preference a row carries — one definition in
 * lib/report-pref, re-exported here because both byte-delivery routes
 * already import the parser from the pipeline. `parseReportPref` reads a
 * legacy 'summary' (old darth-cli, old tabs) as the detailed default. */
export { parseReportPref, defaultReportPref } from '@/lib/report-pref';
export type { ReportPref };

export function sanitizeLinkedEvent(parsed: unknown): LinkedEventInput | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const ev = { ...(parsed as LinkedEventInput) };
  if (ev.startTime && Number.isNaN(Date.parse(ev.startTime))) ev.startTime = undefined;
  if (ev.endTime && Number.isNaN(Date.parse(ev.endTime))) ev.endTime = undefined;
  return ev;
}

/**
 * The event KEY of a `linkedEvent` payload that carries nothing but a key
 * (`{ key: "<meetingCode>|<startIso>" }` — the Darth Recorder after Link is
 * tapped, docs/recorder-link-confirm-spec.md §3). Null for a real event
 * payload (anything with an id, a meetingCode or a title) and for no payload.
 */
export function linkedEventKeyOnly(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const key = typeof e.key === 'string' ? e.key.trim() : '';
  if (!key) return null;
  const hasEvent = ['id', 'meetingCode', 'title', 'iCalUID'].some(
    (k) => typeof e[k] === 'string' && (e[k] as string).trim().length > 0
  );
  return hasEvent ? null : key;
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
  /** Sum of every part's size, declared once by the client at open
   * (docs/recorder-upload-ux.md P2). Stored on the group row as
   * `uploadGroup.bytesTotal` + `upload_bytes_total` so the listing's "x of y"
   * is about the whole recording instead of part 1. */
  groupBytes?: number;
  /**
   * Every part's sha256, in part order, declared once at open of part 1 by a
   * client that holds the whole recording up front (the tray). It makes the
   * group's identity — `sha256(part hashes joined by '\n')` — known before a
   * byte moves, so the same-file check runs at OPEN instead of at the last
   * part's complete (docs/recordings-same-file-spec.md).
   */
  partSha256?: string[];
}

/** Validate multi-file single-meeting group params. `undefined` = not a
 * multi upload; `null` = present but invalid (400). */
export function parseMultiParams(raw: {
  group?: string | null;
  index?: string | number | null;
  total?: string | number | null;
  comment?: string | null;
  groupBytes?: string | number | null;
  partSha256?: unknown;
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
  // Optional: the whole group's byte count. Present-but-nonsense is a 400
  // (a wrong total is worse than none — the listing would lie).
  let groupBytes: number | undefined;
  if (raw.groupBytes !== undefined && raw.groupBytes !== null && raw.groupBytes !== '') {
    const declared = Number(raw.groupBytes);
    if (!Number.isSafeInteger(declared) || declared <= 0) return null;
    groupBytes = declared;
  }
  // Present-but-nonsense is a 400 for the same reason as `groupBytes`: an
  // identity that is wrong is worse than an identity we do not have — it
  // would make the duplicate check answer about a recording that is not this
  // one. Absent is fine (the check moves to the last part's complete).
  const partSha256 = normalizePartSha256(raw.partSha256, total);
  if (partSha256 === null) return null;
  return { group, index, total, comment, groupBytes, partSha256 };
}

/** The `uploadGroup` marker as it lives on the placeholder's gmeet_context. */
type UploadGroupState = NonNullable<GmeetContext['uploadGroup']>;

function sumPartBytes(parts: UploadGroupState['parts'] | undefined): number {
  let sum = 0;
  for (const p of parts ?? []) {
    if (typeof p.bytes === 'number' && Number.isFinite(p.bytes) && p.bytes > 0) sum += p.bytes;
  }
  return sum;
}

/**
 * Bytes of a multi-part upload that are already on disk: Σ `bytes` of the
 * parts that landed. Parts still in flight — and every part of a row written
 * by an older client — carry no `bytes` and count as 0.
 */
export function groupBytesBefore(
  groupRow: { gmeet_context?: GmeetContext | null } | null | undefined
): number {
  return sumPartBytes(groupRow?.gmeet_context?.uploadGroup?.parts);
}

/**
 * What `upload_bytes_received` should say for a group row: the parts already
 * landed plus the part in flight, so the listing's number is about the whole
 * recording (P2). Clamped to the declared total, and exactly the total once
 * every part has landed (a declared total a few bytes off must still read
 * 100%). `group = null` (a single-file upload) is the identity.
 */
export function groupProgressBytes(
  group: UploadGroupState | null | undefined,
  inflightBytes = 0
): number {
  if (!group) return inflightBytes;
  const total =
    typeof group.bytesTotal === 'number' && group.bytesTotal > 0 ? group.bytesTotal : null;
  const landedParts = (group.parts ?? []).filter((p) => typeof p.bytes === 'number').length;
  if (total !== null && inflightBytes === 0 && landedParts >= group.total) return total;
  const value = sumPartBytes(group.parts) + inflightBytes;
  return total !== null ? Math.min(value, total) : value;
}

/**
 * Progress translator for one byte-delivery session: turns "bytes of THIS
 * part received" into "bytes of the whole recording received". Reads the
 * group row once — call it before the byte stream (the blob pull) or inside
 * the throttled flush (the chunk route).
 */
export async function groupProgressAdder(
  userId: string,
  spec: UploadSpec
): Promise<(bytesOfThisPart: number) => number> {
  if (!spec.multi) return (bytes: number) => bytes;
  const row = await findUploadGroupRow(userId, spec.multi.group).catch(() => null);
  const group = row?.gmeet_context?.uploadGroup ?? null;
  return (bytes: number) => groupProgressBytes(group, bytes);
}

export interface RecorderOpenFacts {
  /** The registry row's own id — the caller stamps THIS, not what it was
   * handed (a uuid may arrive in a different case). */
  id: string;
  recorderBirth: NonNullable<OpenUploadInput['recorderBirth']>;
  suggestedEvent: SuggestedEvent | null;
}

/**
 * What the registry row says about a Darth Recorder upload at OPEN time
 * (docs/recorder-link-confirm-spec.md D1 + D2): the call's own name and
 * start — which is what the meeting is born as — and the calendar occurrence
 * the matcher guessed, as a suggestion nothing acts on.
 *
 * Both upload routes go through here so `POST /api/transcripts` (darth-cli,
 * older trays) and `POST /api/uploads` (the tray since 0.3.x) cannot drift.
 * Returns null when the id is not the caller's own recording — the caller
 * decides whether that is a 404 (the chunked route) or simply nothing extra
 * (the one-shot route, which has never validated it here).
 */
export async function recorderOpenFacts(
  userId: string,
  recorderRecordingId: string | null | undefined
): Promise<RecorderOpenFacts | null> {
  if (!recorderRecordingId) return null;
  const rec = await getOwnRecording(userId, recorderRecordingId).catch(() => null);
  if (!rec) return null;
  return {
    id: rec.id,
    recorderBirth: {
      title: recorderCallTitle(rec.call),
      startedAt: rec.started_at ? new Date(rec.started_at).toISOString() : null,
      app: typeof rec.call?.app === 'string' ? rec.call.app.slice(0, 60) : null,
      kind: typeof rec.call?.kind === 'string' ? rec.call.kind.slice(0, 30) : null,
    },
    suggestedEvent: suggestedEventFromMatch(rec.matched, rec.call),
  };
}

/**
 * The ONE confidence definition lives in @/lib/recorder (pure, client-safe,
 * next to the match shape it reads) and is re-exported here because every
 * caller in the upload path has always imported it from this module.
 */
export {
  recorderMatchIsConfident,
  RECORDER_AUTOLINK_MIN_OVERLAP,
  RECORDER_AUTOLINK_MIN_SCORE,
} from '@/lib/recorder';

/**
 * The audio tracks of the file being uploaded, as the CLIENT describes them.
 *
 * Only the Darth Recorder tray sends this (0.3.12), and only `mixFirst` is
 * load-bearing: it promises that audio track 0 is the WHOLE recording — the
 * live mix of every source (`LiveMix.swift`), or the only source when there
 * is one — so AssemblyAI may be handed the bytes where they lie instead of the
 * VM pulling them down to mix them (`blobFastPathRefusal`, DEC-1). The tray
 * says it per FILE, from the registry row the recording controller wrote, not
 * from its own version: a recording made by an older tray is still on that Mac
 * and its files still start with the raw system track.
 *
 * `count` is informational (0 = the client does not know).
 */
export interface UploadTracks {
  count: number;
  mixFirst: boolean;
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
  /** Darth Recorder registry id (migration 041) — the recording these bytes
   * came from. Linked to the transcript once the ingest succeeds. */
  recorderRecordingId?: string | null;
  /** Temporary transcript (migration 042): the placeholder is created with
   * scratch = true and promote-in-place keeps it; replayed into the
   * fresh-insert fallback when the placeholder was reaped. */
  scratch?: boolean;
  /**
   * What the client says the file's audio tracks are, frozen at open
   * (Darth Recorder 0.3.12; `docs/recordings-blob-spec.md` DEC-1). Absent for
   * every other client and for every older tray, which reads as "unknown".
   */
  tracks?: UploadTracks | null;
  /**
   * The client that opened this session said `dupAware: true` — it
   * understands a `{duplicate}` answer. Frozen here at open because the
   * chunk path's check happens at COMPLETE, where the request body is not
   * the open body any more (docs/recordings-same-file-spec.md).
   */
  dupAware?: boolean;
  /**
   * DEC-3 Stage C's INTENT (`docs/recordings-blob-spec.md`). The one part of
   * the spec that is NOT frozen at open: it is written just before the
   * server-side copy into the permanent media container and cleared the
   * moment Stage C is over, either way. See `BlobCopyIntent`.
   */
  blobIntent?: BlobCopyIntent | null;
  /**
   * Phase 3b source (c): this upload JOINS an existing meeting as a clip
   * (`docs/recordings-phase3b-combine-spec.md` §API). Already resolved
   * against that meeting by `resolveAttachTarget` before this spec existed;
   * carried here only so the fresh-insert fallback — the one path where the
   * placeholder this marker was stamped on has been reaped — keeps it.
   */
  attachTo?: AttachToMarker | null;
}

/**
 * "This session is about to put bytes at `blobName`."
 *
 * Stamped on the session row BEFORE `copyTransitToMedia` runs, because the
 * blob's name is otherwise known only to a promise in flight: a crash between
 * the copy and the row that names it (`recording_media.blob_name`) would
 * leave bytes in the permanent container that NOTHING refers to, findable
 * afterwards only by listing the whole container. With the intent recorded,
 * the expired-session sweeper can enqueue exactly that blob for deletion when
 * the session dies without a media row claiming it (`abandonedBlobOf`).
 *
 * JSON-safe (it rides in `upload_sessions.spec`), and deliberately the same
 * three fields `media_blob_deletes` takes plus the time, so the hand-off is a
 * rename rather than a lookup.
 */
export interface BlobCopyIntent {
  /** `<recording id>/<media id><.ext>` in the media container. */
  blobName: string;
  recordingId: string;
  mediaId: string;
  /** ISO, for the log line and for forensics. */
  at: string;
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
  /** Darth Recorder registry id — see UploadSpec.recorderRecordingId. */
  recorderRecordingId?: string | null;
  /** Temporary transcript — see UploadSpec.scratch. Ignored when a calendar
   * event is linked (linking = "this is a real meeting"; the link-event
   * route clears the flag for the same reason). */
  scratch?: boolean;
  /** See `UploadSpec.dupAware`. */
  dupAware?: boolean;
  /** See `UploadSpec.tracks`. */
  tracks?: UploadTracks | null;
  /**
   * See `UploadSpec.attachTo`. Stamped on the placeholder as
   * `gmeet_context.attachTo`, alongside the group and recorder markers rather
   * than through `contextExtra` — a multi-part tray upload has a group marker
   * and must be able to attach too.
   */
  attachTo?: AttachToMarker | null;
  /**
   * D2 (docs/recorder-link-confirm-spec.md): the calendar occurrence this
   * Darth Recorder recording MIGHT be of, stamped on the placeholder as
   * `gmeet_context.suggestedEvent`. A suggestion and nothing else — it never
   * becomes a title, a date, an attendee or a share. Ignored when the caller
   * linked an event explicitly (there is nothing left to suggest) and for
   * parts 2..N of a group (the marker belongs to the group's row).
   */
  suggestedEvent?: SuggestedEvent | null;
  /**
   * D1: what an UNLINKED Darth Recorder upload is born as — the call's own
   * title (cleaned of the app suffix) and the moment the tray started
   * recording. Both are the lowest-priority fallbacks: a re-transcribe
   * source row wins, and an explicit `linkedEvent` wins over both.
   */
  recorderBirth?: {
    title?: string | null;
    startedAt?: string | null;
    /** The call's app + kind, stamped on the row's recorder marker. */
    app?: string | null;
    kind?: string | null;
  } | null;
}

/**
 * `tracks` off a request body: an object with a non-negative integer `count`
 * and a boolean `mixFirst`, or nothing at all. Returns `undefined` when the
 * field is absent and `null` when it is junk — the route answers 400 for the
 * second, because a client that means to make this promise and gets the shape
 * wrong must hear about it rather than silently lose the fast path.
 */
export function parseUploadTracks(raw: unknown): UploadTracks | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as { count?: unknown; mixFirst?: unknown };
  if (typeof t.mixFirst !== 'boolean') return null;
  const count = t.count === undefined ? 0 : t.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 64) return null;
  return { count, mixFirst: t.mixFirst };
}

const RECORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stamp the Darth Recorder registry row with the transcript that came out of
 * it (status → `uploaded`). Best-effort: a registry hiccup must never fail
 * an upload that already produced a transcript.
 */
async function linkRecorderRecording(
  userId: string,
  recordingId: string | null | undefined,
  transcriptId: string
): Promise<void> {
  if (!recordingId || !RECORDER_ID_RE.test(recordingId)) return;
  try {
    const ok = await linkRecordingTranscript(userId, recordingId, transcriptId);
    if (!ok) console.warn(`[upload] recorder recording ${recordingId} not found for this owner`);
    // The link is written AFTER ingest, and it is what makes the recording
    // `source_kind = 'recorder'` and gives it `recorder_recording_id` +
    // `started_at` (spec §5a) — so the graph is re-derived here, not left at
    // the value ingest saw a moment ago.
    if (ok) queueRecordingGraphSync(userId, transcriptId, 'upload/recorder-link');
  } catch (err) {
    console.warn('[upload] linking the recorder recording failed:', err);
  }
}

/**
 * Write the group's identity (`sha256(part hashes joined by '\n')`) and its
 * parts once the stitched meeting exists. Inert unless the same-file gates
 * are all on; never throws (the upload has already succeeded).
 */
/** A single-file upload's identity IS the file's sha256. */
async function stampSingleIdentity(
  userId: string,
  meetingId: string,
  sha256: string | null
): Promise<void> {
  if (!sha256) return;
  await stampUploadIdentity(userId, meetingId, { sha256 }, 'single').catch((err) =>
    console.warn('[upload] stamping the upload identity failed:', err)
  );
}

async function stampGroupIdentity(
  userId: string,
  meetingId: string,
  identity: string | null,
  partSha256: string[] | null
): Promise<void> {
  if (!identity) return;
  await stampUploadIdentity(userId, meetingId, { sha256: identity, partSha256 }, 'group').catch(
    (err) => console.warn('[upload] stamping the group identity failed:', err)
  );
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
        recorderRecordingId: input.recorderRecordingId ?? null,
        scratch: groupRow.scratch,
        dupAware: input.dupAware,
        tracks: input.tracks ?? null,
        // Not carried: the marker was stamped on the GROUP's row by part 1 and
        // that row is the meeting this attaches.
      },
    };
  }

  const { gmeetContext } = buildGmeetContext(input.linkedEvent, input.reportPref);
  const scratch = !!input.scratch && !input.linkedEvent;

  // Create the row BEFORE the bytes so the upload is visible in the owner's
  // listing from the first byte. The temp filename shares the placeholder's
  // uuid so the stale-upload sweeper can find and delete the file when
  // reaping an orphaned row.
  const uploadUuid = input.uuid ?? crypto.randomUUID();
  const placeholderId = `up-${uploadUuid}`;
  const tempFilename = `upload-${uploadUuid}.part`;

  // Markers stamped on the fresh placeholder. `contextExtra` (re-transcribe
  // provenance) and the group marker never co-occur — keep them exclusive as
  // they have always been.
  const groupMarker: Pick<GmeetContext, 'uploadGroup'> | null = multi
    ? {
        uploadGroup: {
          id: multi.group,
          total: multi.total,
          ...(multi.groupBytes ? { bytesTotal: multi.groupBytes } : {}),
          // Declared once, on part 1: the group's identity is known from here
          // on and every part's check answers the same thing.
          ...(multi.partSha256 ? { partSha256: multi.partSha256 } : {}),
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
    : null;
  // The Darth Recorder row behind these bytes: the listing says "uploading
  // from your Mac" and pairs the row with the tray's live progress.
  const recorderMarker: Pick<GmeetContext, 'recorder'> | null = input.recorderRecordingId
    ? {
        recorder: {
          recordingId: input.recorderRecordingId,
          ...(input.recorderBirth?.app ? { app: input.recorderBirth.app } : {}),
          ...(input.recorderBirth?.kind ? { kind: input.recorderBirth.kind } : {}),
        },
      }
    : null;
  const contextExtra = multi ? null : (input.contextExtra ?? null);
  // Phase 3b source (c): "these bytes are a second recording OF that meeting",
  // resolved before this call (`resolveAttachTarget`). It rides the row rather
  // than only the upload session because the completion hook that acts on it
  // runs from a poll that knows nothing about either.
  const attachMarker: Pick<GmeetContext, 'attachTo'> | null = input.attachTo
    ? { attachTo: input.attachTo }
    : null;
  // D2: the match, as a suggestion. Never alongside a real link.
  const suggestionMarker: Pick<GmeetContext, 'suggestedEvent'> | null =
    !input.linkedEvent && input.suggestedEvent ? { suggestedEvent: input.suggestedEvent } : null;
  const placeholderContext: GmeetContext | null =
    gmeetContext ||
    groupMarker ||
    recorderMarker ||
    contextExtra ||
    attachMarker ||
    suggestionMarker
      ? {
          ...(gmeetContext ?? {}),
          ...(contextExtra ?? {}),
          ...(groupMarker ?? {}),
          ...(recorderMarker ?? {}),
          ...(attachMarker ?? {}),
          ...(suggestionMarker ?? {}),
        }
      : null;

  const placeholder = await createUploadingPlaceholder(user.userId, {
    placeholderId,
    originalFilename: input.originalFilename,
    languageCode: languageCode ?? null,
    // D1: an unlinked recorder upload is born with the CALL's own name, not
    // with some meeting's.
    title:
      sourceRow?.title ??
      input.linkedEvent?.title?.slice(0, 300) ??
      input.recorderBirth?.title?.slice(0, 300) ??
      null,
    gmeetContext: placeholderContext,
    // A group declares the whole recording's size once (P2); a single file is
    // its own total.
    bytesTotal: multi?.groupBytes ?? input.bytesTotal,
    scratch,
  });
  // NO SHARES HERE (design P4, owner 2026-09-23): linking a recording to a
  // calendar occurrence never shares — only meetings carry shares, and sharing
  // is a separate act the person takes. The linked event's invitees land in
  // gmeet_context.attendees above, which is what the share dialog's
  // "Suggested from this meeting" (GET …/share-suggestions) offers them from.
  // Until 2026-09-23 this shared with every internal invitee, with edit
  // access, the moment an upload opened linked (tray Link, web stepper,
  // calendar-row Upload, darth-cli --event). Cloud imports still share —
  // that arm is `shareCloudImportWithInternalInvitees` (lib/server/auto-share).
  // D1: the placeholder is born with the moment the tray started recording
  // as its date (after the title above), so an
  // unlinked recording still lands on the right day in the listing.
  const earlyRecordedAt =
    sourceRow?.recorded_at ?? input.linkedEvent?.startTime ?? input.recorderBirth?.startedAt;
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
      recorderRecordingId: input.recorderRecordingId ?? null,
      scratch,
      dupAware: input.dupAware,
      tracks: input.tracks ?? null,
      attachTo: input.attachTo ?? null,
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

/** What the byte-delivery route already knows about these bytes. */
export interface FinalizeHashes {
  /**
   * sha256 of THIS part's bytes: the blob session's verified hash, or the
   * temp file streamed at complete. It becomes the recording's identity for a
   * single file, and one term of the combined hash for a group
   * (docs/recordings-same-file-spec.md).
   */
  part?: string | null;
  /**
   * DEC-3 Stage C: the bytes are already in the PERMANENT media container and
   * there is no temp file on this VM. AssemblyAI reads them from the SAS this
   * carries, and the local copy is fetched afterwards
   * (`lib/server/aai-from-blob.ts`). Absent = today's local-file ingest, byte
   * for byte. Single files only — a group is stitched on the VM first.
   */
  fromBlob?: BlobIngestSource | null;
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
  bytes: number,
  hashes: FinalizeHashes = {}
): Promise<FinalizeResult> {
  const { placeholderId, tempFilename, multi } = spec;
  const partHash = normalizeSha256(hashes.part);

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
        ...(partHash ? { sha256: partHash } : {}),
      },
    ].sort((a, b) => a.index - b.index);
    await mergeGmeetContextForUser(
      user.userId,
      groupRow.assemblyai_id,
      { uploadGroup: { ...group, parts } },
      { quiet: true }
    );
    // P2: the listing's number is "bytes of the whole recording received",
    // never this part's — `parts` already carries every landed part's bytes.
    await updateUploadProgress(
      user.userId,
      groupRow.assemblyai_id,
      groupProgressBytes({ ...group, parts })
    ).catch(() => {});

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
    // The group's identity, before anything can throw (the kept-failure path
    // below stamps it too). The OBSERVED part hashes win over the list a
    // client declared at open — those are the bytes that actually landed (a
    // blob pull verifies its hash, a chunk stream is measured at complete) —
    // and the declared list is the fallback when one part's hash was never
    // computed (the flag was off while it landed, an older client).
    const groupPartHashes = partHashesInOrder(parts, multi.total) ?? group.partSha256 ?? null;
    const groupIdentity = groupPartHashes
      ? uploadIdentityHash({ partSha256: groupPartHashes })
      : null;
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
          // The durable record of what went into the group's combined hash:
          // the temp files are about to be deleted by the stitch.
          ...(p.sha256 ? { sha256: p.sha256 } : {}),
        };
        offset += durations[i] ?? 0;
        return entry;
      });
      // The stitch works on the NVMe when `MW_SCRATCH_DIR` is set (DEC-3's
      // scratch rule) and in the audio dir exactly as before when it is not.
      const { filename: combinedTemp, reencoded } = await concatMediaSmart(
        parts.map((p) => p.tempFilename),
        { scratchId: groupUuid }
      );
      console.log(
        `[upload] stitched ${multi.total} recordings for ${groupRow.assemblyai_id}` +
          (reencoded ? ' (re-encoded — mixed codecs)' : ' (stream-copy)')
      );
      for (const p of parts) await deleteAudioFile(p.tempFilename);
      // Persist the stitch map on the row BEFORE ingest — the placeholder
      // is promoted in place, context intact, so the map survives. That
      // ordering is also what lets the dual-write inside `ingestLocalAudio`
      // see the group: ONE recording whose canonical is the concat
      // (`source_ref.derived = 'concat'`) with a `part` row per
      // `uploadedParts` entry, offsets included.
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
        scratch: groupRow.scratch,
      });
      await linkRecorderRecording(user.userId, spec.recorderRecordingId, row.assemblyai_id);
      await stampGroupIdentity(user.userId, row.assemblyai_id, groupIdentity, groupPartHashes);
      return { status: 201, body: { transcript: row } };
    } catch (error) {
      if (error instanceof IngestError && error.keptRow) {
        // Bytes are stored, the row stays visible as Failed and the sweeper
        // retries the hand-off: for the client this upload succeeded.
        console.error(`[upload] ${error.stage} failed — kept for retry:`, error.causeErr);
        await linkRecorderRecording(user.userId, spec.recorderRecordingId, error.keptRow.assemblyai_id);
        await stampGroupIdentity(
          user.userId,
          error.keptRow.assemblyai_id,
          groupIdentity,
          groupPartHashes
        );
        return { status: 201, body: { transcript: error.keptRow } };
      }
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

  if (multi) {
    // Part 1 of a multi-file group: the bytes are parked, the group marker
    // is on the placeholder — ingest waits for the last part. Record this
    // part's bytes on the group (atomically — siblings finalize in parallel)
    // so every later progress write can add them up (P2).
    const ctx = await setUploadPartBytesForUser(user.userId, placeholderId, multi.index, {
      bytes,
      // The part's own hash rides along atomically — the last part's complete
      // reads them all back to build the group's identity.
      ...(partHash ? { sha256: partHash } : {}),
    }).catch(() => null);
    await updateUploadProgress(
      user.userId,
      placeholderId,
      ctx?.uploadGroup ? groupProgressBytes(ctx.uploadGroup) : bytes
    ).catch(() => {});
    const row = await getForUser(user.userId, placeholderId);
    if (!row) return { status: 404, body: { error: 'Upload placeholder vanished' } };
    return { status: 201, body: { transcript: row } };
  }

  // Final progress write so viewers see 100% while the AAI re-upload leg runs.
  await updateUploadProgress(user.userId, placeholderId, bytes).catch(() => {});

  // Shared tail: AAI upload (disk-streamed) → vocab-biased submit → DB row
  // (placeholder promoted in place) → rename temp file to its permanent
  // name. Same path as the Meet import.
  let sourceRow: StoredTranscript | null = null;
  if (spec.sourceId) {
    const access = await resolveAccess(user.userId, user.email, spec.sourceId);
    sourceRow = access?.row ?? null;
  }
  const { gmeetContext, attendeeNames } = buildGmeetContext(spec.linkedEvent, spec.reportPref);
  // The placeholder already carries the attach marker and is promoted in
  // place, context intact — this is for the ONE path that inserts a fresh row
  // instead (the sweeper reaped the placeholder mid-upload), which would
  // otherwise land a meeting that silently forgot it was joining another one.
  const ingestContext: GmeetContext | null = spec.attachTo
    ? { ...(gmeetContext ?? {}), attachTo: spec.attachTo }
    : gmeetContext;
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
    const ingestOpts = {
      originalFilename: spec.originalFilename,
      languageCode: spec.languageCode,
      title: sourceRow?.title ?? spec.linkedEvent?.title?.slice(0, 300) ?? null,
      extraKeyterms:
        sourceSpeakers.length > 0 || attendeeNames.length > 0
          ? [...sourceSpeakers, ...attendeeNames]
          : undefined,
      gmeetContext: ingestContext,
      placeholderAssemblyaiId: placeholderId,
      speechModel: spec.speechModel,
      scratch: spec.scratch ?? false,
    };
    try {
      // Stage C or today's path — the SAME options, the same row, the same
      // everything after it. The difference is only where AssemblyAI reads the
      // bytes from and whether this VM holds them yet.
      row = hashes.fromBlob
        ? await ingestBlobAudio(user.userId, hashes.fromBlob, ingestOpts)
        : await ingestLocalAudio(user.userId, tempFilename, ingestOpts);
    } finally {
      clearInterval(heartbeat);
    }
    const recordedAt = sourceRow?.recorded_at ?? spec.linkedEvent?.startTime;
    if (recordedAt) {
      await setRecordedAtForUser(user.userId, row.assemblyai_id, new Date(recordedAt)).catch(
        () => {}
      );
    }
    await linkRecorderRecording(user.userId, spec.recorderRecordingId, row.assemblyai_id);
    await stampSingleIdentity(user.userId, row.assemblyai_id, partHash);
    return { status: 201, body: { transcript: row } };
  } catch (error) {
    // Stage C's submit failed before anything was created: the placeholder is
    // untouched and the transit blob is still there, so the caller re-runs
    // this same tail on the pull path — which, unlike this one, can keep the
    // bytes on disk as a visible Failed row. Rethrown BEFORE any cleanup.
    if (error instanceof BlobIngestFailed) throw error;
    if (error instanceof IngestError && error.keptRow) {
      // Bytes are stored, the row stays visible as Failed and the sweeper
      // retries the hand-off: for the client this upload succeeded.
      console.error(`[upload] ${error.stage} failed — kept for retry:`, error.causeErr);
      await linkRecorderRecording(user.userId, spec.recorderRecordingId, error.keptRow.assemblyai_id);
      await stampSingleIdentity(user.userId, error.keptRow.assemblyai_id, partHash);
      return { status: 201, body: { transcript: error.keptRow } };
    }
    // A failed ingest that could NOT be kept leaves the placeholder stuck at
    // 'uploading' — remove it so viewers see the upload vanish rather than a
    // zombie row. (No-op once promoted: the row's id is the real AAI one.)
    await deleteForUser(user.userId, placeholderId).catch(() => {});
    if (error instanceof IngestError) {
      console.error(`[upload] ${error.stage} failed:`, error.causeErr);
      return { status: 502, body: { error: error.message, detail: String(error.causeErr) } };
    }
    throw error;
  }
}
