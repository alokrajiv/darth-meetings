import 'server-only';
import {
  createMeetingFromRecording,
  getStandaloneForOwner,
  getStandaloneViewForOwner,
  keepStandalone,
  meetingsHoldingRecording,
  type RecordingMeetingRef,
  type StandaloneListRow,
} from '@/db-ops/standalone-recordings';
import { announceMeetingInserted, getForUser } from '@/db-ops/transcripts';
import { resolveAccess } from '@/db-ops/transcript-access';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import {
  buildGmeetContext,
  sanitizeLinkedEvent,
  type LinkedEventInput,
} from '@/lib/server/upload-pipeline';
import { attachSeriesForRow } from '@/lib/server/ingest';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';
import { prepareMediaForPlayback } from '@/lib/server/media-sweeper';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import { addClip } from '@/lib/server/clip-combine';
import { purgeStandaloneRecording, refreshBornBare } from '@/lib/server/born-bare';
import { suggestedEventFromMatch } from '@/lib/server/recorder-match';
import { isClipTextPolicy, type ClipTextPolicy } from '@/lib/recording-clips';
import type { GmeetContext, SuggestedEvent } from '@/lib/format';

/**
 * The owner's actions on a STANDALONE recording (design P7/P8,
 * docs/recordings-meetings-series-design.md §3.1, §4.1) and the one view of it
 * the owner is served.
 *
 * Every function here takes the caller and constrains on OWNERSHIP first: a
 * recording that is not the caller's answers exactly like one that does not
 * exist (`not-found` → 404, invariant I2). Nothing here writes a share —
 * linking a recording never shares (design P4); sharing is something the
 * person does to the MEETING afterwards.
 */

export interface Caller {
  userId: string;
  email: string;
}

export type RecordingStatus = 'uploading' | 'transcribing' | 'ready' | 'failed';

/** What `GET /api/recordings/:id` and the Recordings surface serve — OWNER ONLY. */
export interface RecordingView {
  id: string;
  /** `rec-<id>` — the pseudo meeting id the upload routes answered with. */
  pseudo_id: string;
  title: string | null;
  source_kind: string;
  status: RecordingStatus;
  /** One sentence when something is wrong or pending ("retrying at 14:05"). */
  status_note: string | null;
  started_at: string | null;
  created_at: string;
  duration_sec: number | null;
  speaker_count: number | null;
  language_code: string | null;
  original_filename: string | null;
  bytes: number | null;
  has_video: boolean | null;
  part_count: number;
  /** P8: set = temporary, gone after this unless kept / linked. */
  expires_at: string | null;
  temporary: boolean;
  /** Upload progress while bytes arrive. */
  upload: { bytes_received: number | null; bytes_total: number | null } | null;
  /** Meetings holding a clip on it that the caller can open. */
  meetings: Array<{ id: string; title: string | null; trashed: boolean }>;
  /** Clips held by any live meeting — > 0 means it is "in a meeting". */
  in_meeting: boolean;
  /** The confident calendar match, un-dismissed, while not in a meeting. */
  suggested_event: SuggestedEvent | null;
  recorder_recording_id: string | null;
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function statusOf(r: Pick<StandaloneListRow, 'active_transcription_id' | 'txn_status' | 'upload_state'>): {
  status: RecordingStatus;
  note: string | null;
} {
  const f = r.upload_state?.ingestFailure;
  if (!r.active_transcription_id) {
    if (f) {
      return {
        status: 'failed',
        note: f.retryable && f.nextAt
          ? `Handing it to transcription failed (${f.message}) — retrying automatically`
          : `Handing it to transcription failed: ${f.message}`,
      };
    }
    return { status: 'uploading', note: null };
  }
  if (r.txn_status === 'completed') return { status: 'ready', note: null };
  if (r.txn_status === 'error') {
    return { status: 'failed', note: r.upload_state?.failedReason ?? 'Transcription failed' };
  }
  return { status: 'transcribing', note: null };
}

export function recordingViewOf(r: StandaloneListRow, meetings: RecordingMeetingRef[] = []): RecordingView {
  const { status, note } = statusOf(r);
  const inMeeting = r.live_clips > 0;
  const suggestion =
    !inMeeting && !r.upload_state?.suggestionDismissedAt
      ? suggestedEventFromMatch(r.recorder_matched, r.recorder_call)
      : null;
  return {
    id: r.id,
    pseudo_id: `rec-${r.id}`,
    title: r.title,
    source_kind: r.source_kind,
    status,
    status_note: note,
    started_at: iso(r.started_at),
    created_at: iso(r.created_at) ?? String(r.created_at),
    duration_sec: r.duration_ms != null ? Math.round(r.duration_ms / 1000) : null,
    speaker_count: r.upload_state?.speakerCount ?? null,
    language_code: r.txn_language_code ?? r.upload_state?.languageCode ?? null,
    original_filename: r.upload_state?.originalFilename ?? null,
    bytes: r.canonical_bytes ?? null,
    has_video: r.canonical_has_video ?? null,
    part_count: r.part_count,
    expires_at: iso(r.expires_at),
    temporary: !!r.expires_at,
    upload:
      status === 'uploading'
        ? {
            bytes_received: r.upload_state?.bytesReceived ?? null,
            bytes_total: r.upload_state?.bytesTotal ?? null,
          }
        : null,
    meetings: meetings.map((m) => ({ id: m.assemblyai_id, title: m.title, trashed: m.trashed })),
    in_meeting: inMeeting,
    suggested_event: suggestion,
    recorder_recording_id: r.recorder_recording_id,
  };
}

/** CALLER-SCOPED — the owner's recording, or null (not theirs / not there). */
export async function getRecordingView(caller: Caller, id: string): Promise<RecordingView | null> {
  let row = await getStandaloneViewForOwner(caller.userId, id);
  if (!row) return null;
  // A job still at AssemblyAI is asked once more before answering, like the
  // meeting detail route does — the watcher and the sweeper are the backstop.
  if (row.txn_status === 'processing') {
    await refreshBornBare(row.id).catch(() => false);
    row = (await getStandaloneViewForOwner(caller.userId, id)) ?? row;
  }
  const meetings = row.all_clips > 0 ? await meetingsHoldingRecording(row.id, caller) : [];
  return recordingViewOf(row, meetings);
}

// ---------------------------------------------------------------------------
// Link / Make a meeting
// ---------------------------------------------------------------------------

export type ActionResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; error: string; code?: string };

export interface MadeMeeting {
  meeting: { id: string; title: string | null };
  recordingId: string;
  /** Always 0 — a link never shares (design P4). Present so a client can say so. */
  shares: 0;
}

const NOT_FOUND = { ok: false as const, status: 404, error: 'Not found' };

function refusalFor(code: 'not-found' | 'not-ready' | 'already-linked'): ActionResult<never> {
  if (code === 'not-found') return NOT_FOUND;
  if (code === 'not-ready') {
    return {
      ok: false,
      status: 409,
      code,
      error: 'The recording is not transcribed yet — link it once its transcript is ready.',
    };
  }
  return {
    ok: false,
    status: 409,
    code,
    error: 'The recording is already part of a meeting. Open that meeting to change it.',
  };
}

/**
 * The meeting row + clip, then everything a newly created meeting gets:
 * the listing/`/m` ledger, series auto-attach on a STRONG key (as linked
 * uploads do), the graph sync (a borrower: clip rows only), playback prep,
 * and the speaker passes — with NO ready DM (the recording already sent the
 * one DM it gets; "meeting made" needs none — risk §6.1).
 */
async function makeMeeting(
  caller: Caller,
  recordingId: string,
  opts: { title: string | null; recordedAt: string | null; ctx: GmeetContext; how: 'link' | 'make-meeting' }
): Promise<ActionResult<MadeMeeting>> {
  const meetingId = crypto.randomUUID();
  const ctx: GmeetContext = {
    ...opts.ctx,
    fromRecording: { recordingId, at: new Date().toISOString(), how: opts.how },
  };
  const made = await createMeetingFromRecording({
    ownerUserId: caller.userId,
    recordingId,
    meetingId,
    title: opts.title,
    recordedAt: opts.recordedAt,
    gmeetContext: ctx,
  });
  if (!made.ok) return refusalFor(made.code);

  await announceMeetingInserted(made.assemblyaiId, ctx, opts.title, caller.userId);
  const row = await getForUser(caller.userId, made.assemblyaiId);
  if (row) {
    await attachSeriesForRow(row).catch((err) =>
      console.warn(`[recording-actions] series attach ${made.assemblyaiId} failed:`, err)
    );
  }
  queueRecordingGraphSync(caller.userId, made.assemblyaiId, `recording-${opts.how}`);
  prepareMediaForPlayback(caller.userId, made.assemblyaiId);
  onTranscriptCompleted(caller.userId, made.assemblyaiId, { utterances: null, silent: true });
  console.log(
    `[recording-actions] ${opts.how}: recording ${recordingId} → meeting ${made.assemblyaiId} (owner ${caller.userId}, 0 shares)`
  );
  return {
    ok: true,
    body: { meeting: { id: made.assemblyaiId, title: opts.title }, recordingId, shares: 0 },
  };
}

export interface LinkInput {
  /**
   * The web link dialog's whole calendar event (the shape the upload stepper
   * and `…/link-event` already send: id, title, startTime, endTime,
   * meetingCode, attendees). The caller's own pick from their own calendar —
   * trusted exactly as far as the upload stepper's `linkedEvent` is.
   */
  event?: unknown;
  eventRef?: string | null;
  eventKey?: string | null;
  meetingId?: string | null;
  title?: string | null;
  /** Adding to an EXISTING meeting: where it lands on that meeting's timeline. */
  offsetMs?: number | null;
  textPolicy?: ClipTextPolicy | null;
}

/**
 * `POST /api/recordings/:id/link` — owner only.
 *
 *  - `eventRef` / `eventKey` (a meeting code, or the calendar event key):
 *    creates the meeting linked to that occurrence of the CALLER'S calendar,
 *    with the recording as its one clip. No share (P4); the invitees become
 *    the share dialog's suggestions.
 *  - `meetingId`: adds the recording to a meeting the caller owns or can edit
 *    (the Phase 3b clip add, behind MW_COMBINE; its own refusals pass through).
 */
export async function linkRecording(
  caller: Caller,
  recordingId: string,
  input: LinkInput
): Promise<ActionResult<MadeMeeting | Record<string, unknown>>> {
  const rec = await getStandaloneForOwner(caller.userId, recordingId);
  if (!rec) return NOT_FOUND;
  const title = cleanTitle(input.title);
  if (title === false) return { ok: false, status: 400, error: 'title must be 1–300 characters' };

  const picked = input.event ? sanitizeLinkedEvent(input.event) : null;
  if (picked && (picked.id || picked.meetingCode || picked.title)) {
    const { gmeetContext } = buildGmeetContext(picked, null);
    return makeMeeting(caller, recordingId, {
      title: title ?? picked.title?.slice(0, 300) ?? rec.title,
      recordedAt: picked.startTime ?? null,
      ctx: gmeetContext ?? {},
      how: 'link',
    });
  }

  const ref = (input.eventRef ?? input.eventKey ?? '').trim();
  if (ref) {
    const resolved = await resolveLinkedEventRef(caller.userId, ref);
    if (!resolved.ok) return { ok: false, status: resolved.status, error: resolved.error };
    const event: LinkedEventInput = resolved.event;
    const { gmeetContext } = buildGmeetContext(event, null);
    return makeMeeting(caller, recordingId, {
      title: title ?? event.title?.slice(0, 300) ?? rec.title,
      recordedAt: event.startTime ?? null,
      ctx: gmeetContext ?? {},
      how: 'link',
    });
  }

  const meetingId = (input.meetingId ?? '').trim();
  if (meetingId) {
    const access = await resolveAccess(caller.userId, caller.email, meetingId);
    if (!access || access.row.deleted_at) return NOT_FOUND;
    if (access.access === 'read') {
      return { ok: false, status: 403, error: 'You can only add a recording to a meeting you own or can edit.' };
    }
    const policy = input.textPolicy && isClipTextPolicy(input.textPolicy) ? input.textPolicy : 'include';
    const out = await addClip({
      access,
      by: { userId: caller.userId, email: caller.email },
      recordingId,
      fromMs: 0,
      toMs: null,
      offsetMs: typeof input.offsetMs === 'number' && input.offsetMs >= 0 ? Math.round(input.offsetMs) : 0,
      textPolicy: policy,
    });
    if (!out.ok) {
      const body = out.body as { error?: string; code?: string };
      return { ok: false, status: out.status, error: body.error ?? 'Could not add the recording', code: body.code };
    }
    // In a meeting now: no longer temporary (I6 — the same write as far as
    // the owner can tell; the sweeper never removes a clipped recording anyway).
    await keepStandalone(caller.userId, recordingId, { keep: true });
    return { ok: true, body: { ...(out.body as object), recordingId, shares: 0 } };
  }

  return { ok: false, status: 400, error: 'Give event, eventRef (a meeting code or event key) or meetingId' };
}

/** `POST /api/recordings/:id/make-meeting {title}` — a standalone meeting. */
export async function makeMeetingFromRecording(
  caller: Caller,
  recordingId: string,
  rawTitle: unknown
): Promise<ActionResult<MadeMeeting>> {
  const rec = await getStandaloneForOwner(caller.userId, recordingId);
  if (!rec) return NOT_FOUND;
  const title = cleanTitle(rawTitle);
  if (!title) return { ok: false, status: 400, error: 'A title is required (1–300 characters)' };
  return makeMeeting(caller, recordingId, { title, recordedAt: null, ctx: {}, how: 'make-meeting' });
}

/** `PATCH /api/recordings/:id {keep?, title?, dismissSuggestedEvent?}`. */
export async function patchRecording(
  caller: Caller,
  recordingId: string,
  body: Record<string, unknown>
): Promise<ActionResult<{ recording: RecordingView }>> {
  const keep = body.keep === true;
  const dismiss = body.dismissSuggestedEvent === true;
  let title: string | null | undefined;
  if (body.title !== undefined) {
    const t = body.title === null || body.title === '' ? null : cleanTitle(body.title);
    if (t === false) return { ok: false, status: 400, error: 'title must be 1–300 characters' };
    title = t ?? null;
  }
  if (!keep && !dismiss && title === undefined) {
    return { ok: false, status: 400, error: 'Nothing to change (keep, title, dismissSuggestedEvent)' };
  }
  const ok = await keepStandalone(caller.userId, recordingId, {
    keep,
    ...(title !== undefined ? { title } : {}),
    dismissSuggestion: dismiss,
  });
  if (!ok) return NOT_FOUND;
  const view = await getRecordingView(caller, recordingId);
  return view ? { ok: true, body: { recording: view } } : NOT_FOUND;
}

/** `DELETE /api/recordings/:id` — refused while a meeting (live or trashed) uses it. */
export async function deleteRecording(
  caller: Caller,
  recordingId: string
): Promise<ActionResult<{ ok: true; deleted: true }>> {
  const rec = await getStandaloneForOwner(caller.userId, recordingId);
  if (!rec) return NOT_FOUND;
  const out = await purgeStandaloneRecording(recordingId, '[recordings] delete');
  if (out === 'in-meeting') {
    return {
      ok: false,
      status: 409,
      code: 'in-meeting',
      error:
        'A meeting uses this recording (it may be in your trash). Remove it from that meeting, or delete the meeting for good, first.',
    };
  }
  if (out === 'not-found') return NOT_FOUND;
  return { ok: true, body: { ok: true, deleted: true } };
}

/** `false` = present but invalid; `null` = absent/empty. */
function cleanTitle(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  if (!t) return null;
  if (t.length > 300) return false;
  return t;
}
