import 'server-only';
import {
  attachMarker,
  attachOffsetMs,
  clipSourceLabel,
  combineRefusal,
  pendingAttachOf,
  MAX_CLIPS_PER_MEETING,
  type AttachToMarker,
  type AttachToRequest,
  type CombineRefusalCode,
  type PendingAttach,
} from '@/lib/clips';
import { combineEnabled, listMeetingClips, listPendingAttachments } from '@/db-ops/clips';
import { meetingRecordingRef } from '@/db-ops/transcriptions';
import { resolveAccess, type ResolvedAccess } from '@/db-ops/transcript-access';
import { mergeGmeetContextForUser } from '@/db-ops/transcripts';
import { identitiesForUsers, identityForUser } from '@/db-ops/transcript-activity';
import { addClip } from '@/lib/server/clip-combine';
import { syncRecordingGraphForMeeting } from '@/lib/server/recording-sync';
import type { StoredTranscript } from '@/lib/format';

/**
 * Source (c) — an upload that JOINS an existing meeting
 * (docs/recordings-phase3b-combine-spec.md §API, behind `MW_COMBINE`).
 *
 * Sources (a) and (b) add a recording that already exists, from the sheet.
 * This is the third one: the person is uploading the phone clip *now*, and
 * says at the upload dialog which meeting it belongs to. The upload then runs
 * exactly as any upload does — its own recording, its own AssemblyAI job, its
 * own diarization space, its own meeting document (DEC-1) — and when the
 * transcription lands it is ALSO added to the named meeting as a clip.
 *
 * Two halves, and they are deliberately far apart in time:
 *
 *   1. **At open**, before a byte moves: `resolveAttachTarget` answers the
 *      whole refusal table (read-only, unknown, full, flag off) and returns
 *      the MARKER, which `openUpload` stamps on the placeholder as
 *      `gmeet_context.attachTo`. Refusing here is the point — a person who
 *      cannot add to that meeting must be told before they spend twenty
 *      minutes uploading, not after.
 *   2. **At completion**, from the post-completion hook: `runPendingAttach`
 *      resolves the upload's OWN recording, re-checks access AS THE UPLOADER
 *      (a share can be withdrawn while a 4 GB file is on its way) and calls
 *      `addClip`, which is the same code path, and the same privacy rule, the
 *      sheet uses. The uploader owns the recording by construction, so the
 *      `not-owned` arm can never fire here.
 *
 * If the second half refuses, the uploaded meeting simply stays a normal
 * standalone meeting — nothing is lost, the bytes are transcribed and
 * readable — and the marker keeps the sentence so the card can say
 * "could not attach: …". Nothing is retried and no new DM is sent: the
 * ordinary "Transcript ready" DM has already gone out.
 */

export type AttachResolution =
  | { ok: true; marker: AttachToMarker }
  | { ok: false; status: number; body: { error: string; code?: CombineRefusalCode } };

function refuse(
  status: number,
  refusal: { message: string; code: CombineRefusalCode }
): AttachResolution {
  return { ok: false, status, body: { error: refusal.message, code: refusal.code } };
}

/**
 * Resolve `attachTo` at upload open, immediately.
 *
 * Everything `addClip` can refuse ABOUT THE MEETING is refused here, in the
 * same words, from the same functions. What is NOT checked is everything
 * about the RECORDING — it does not exist yet: no `already-clipped` (these
 * are fresh bytes), and no `not-transcribed` (by the time the clip is added
 * the transcription is exactly what has landed).
 *
 * PRIVACY: an unknown meeting and a meeting the caller cannot open give the
 * same 404 with the same sentence, so this is not an existence oracle for
 * meeting ids.
 */
export async function resolveAttachTarget(
  caller: { userId: string; email: string },
  req: AttachToRequest
): Promise<AttachResolution> {
  if (!(await combineEnabled())) return refuse(409, combineRefusal('disabled'));

  const access = await resolveAccess(caller.userId, caller.email, req.meetingId);
  if (!access) {
    return {
      ok: false,
      status: 404,
      body: { error: 'That meeting is not available to you.' },
    };
  }
  if (access.access === 'read') return refuse(403, combineRefusal('read-only'));
  if (access.row.deleted_at) {
    return refuse(409, combineRefusal('disabled', 'That meeting is in the trash.'));
  }

  // The meeting must already have a recording of its own to place this one
  // against, and there must be room. Both are `addPrecondition`'s rules; they
  // are re-checked at completion, when they are the ones that can have
  // changed under us.
  const clips = await listMeetingClips(access.row.id);
  if (clips.length === 0) return refuse(409, combineRefusal('no-clip'));
  if (clips.length >= MAX_CLIPS_PER_MEETING) return refuse(409, combineRefusal('too-many-clips'));

  const offsetMs = attachOffsetMs(req);
  if (offsetMs === null || !Number.isFinite(offsetMs) || offsetMs < 0) {
    return refuse(400, combineRefusal('offset-invalid'));
  }

  return { ok: true, marker: attachMarker(req, offsetMs, caller.email) };
}

export type AttachOutcome = 'none' | 'attached' | 'refused' | 'deferred';

/**
 * The completion half: add this finished upload to the meeting it named.
 *
 * Called from `onTranscriptCompleted` for every completed row and a no-op
 * without the marker, which is every row on prod. Never throws — the hook
 * that calls it must not be able to fail because of a clip.
 *
 * `deferred` means "not now, marker kept": the flag is off, or the identity
 * behind the row could not be resolved. Everything else is terminal, and the
 * marker either goes (attached) or carries its sentence (refused).
 */
export async function runPendingAttach(
  ownerUserId: string,
  row: Pick<StoredTranscript, 'id' | 'assemblyai_id' | 'gmeet_context'>
): Promise<AttachOutcome> {
  const marker = pendingAttachOf(row.gmeet_context);
  if (!marker) return 'none';
  if (!(await combineEnabled())) return 'deferred';

  const fail = async (message: string, code?: CombineRefusalCode): Promise<AttachOutcome> => {
    console.warn(`[attach] ${row.assemblyai_id} → ${marker.meetingId}: ${message}`);
    await mergeGmeetContextForUser(ownerUserId, row.assemblyai_id, {
      attachTo: {
        ...marker,
        error: message,
        ...(code ? { errorCode: code } : {}),
        failedAt: new Date().toISOString(),
      },
    }).catch(() => {});
    return 'refused';
  };

  // The uploader, as the marker froze them at open. The fallback exists for a
  // marker written before `by` did (and for a hand-stamped one); there is no
  // users table, so an id alone cannot be turned into the email `resolveAccess`
  // matches shares on.
  const email = marker.by ?? (await identityForUser(ownerUserId).catch(() => null))?.email ?? null;
  if (!email) return 'deferred';

  const access = await resolveAccess(ownerUserId, email, marker.meetingId);
  if (!access) return fail('That meeting is not available to you.');

  // The upload's OWN recording — the thing the clip will point at. It is
  // written by the dual-write the ingest queued; if that has not landed yet,
  // run it here rather than lose the attach.
  let ref = await meetingRecordingRef(row.id);
  if (!ref) {
    await syncRecordingGraphForMeeting(ownerUserId, row.assemblyai_id).catch(() => {});
    ref = await meetingRecordingRef(row.id);
  }
  if (!ref) {
    return fail('This upload’s recording is not set up on the server yet.', 'recording-not-found');
  }

  const out = await addClip({
    access,
    by: { userId: ownerUserId, email, name: null },
    recordingId: ref.recordingId,
    // The WHOLE upload, placed where the person put it. A window of it is a
    // later edit in the sheet (`PATCH …/clips/:ord`), never a guess here.
    fromMs: 0,
    toMs: null,
    offsetMs: marker.offsetMs,
    textPolicy: marker.textPolicy,
  });

  if (!out.ok) {
    // Already there: a re-entry of the hook (it is idempotent by design) or a
    // person who added the same recording by hand in the meantime. The marker
    // has done its job either way.
    if (out.body.code === 'already-clipped') {
      await clearMarker(ownerUserId, row.assemblyai_id);
      return 'attached';
    }
    // `ClipOpResult` types its code as a plain string; every code it can
    // actually carry is a `CombineRefusalCode`.
    return fail(out.body.error, out.body.code as CombineRefusalCode | undefined);
  }

  await clearMarker(ownerUserId, row.assemblyai_id);
  console.log(
    `[attach] ${row.assemblyai_id} → ${marker.meetingId}: added at ${marker.offsetMs} ms ` +
      `(${marker.textPolicy}); the meeting now holds ${out.body.recordingCount} recordings`
  );
  return 'attached';
}

/** The marker is gone the moment it has been acted on — it is an instruction,
 * not a record, and the clip list is the record. */
async function clearMarker(ownerUserId: string, assemblyaiId: string): Promise<void> {
  await mergeGmeetContextForUser(ownerUserId, assemblyaiId, { attachTo: null }).catch(() => {});
}

/**
 * "A recording is being added: Upload · transcribing…" — what the TARGET
 * meeting's recording card says while an upload is on its way into it.
 *
 * Caller-scoped in SQL (`listPendingAttachments`) and filename-free by
 * construction: the meeting's readers have not been given these bytes yet.
 */
export async function pendingAttachFor(
  access: ResolvedAccess,
  caller: { userId: string; email: string }
): Promise<PendingAttach[]> {
  const rows = await listPendingAttachments(caller, access.row.assemblyai_id);
  if (rows.length === 0) return [];
  const identities = await identitiesForUsers(rows.map((r) => r.user_id));
  return rows.map((r) => {
    const mine = r.user_id === caller.userId;
    const identity = identities.get(r.user_id) ?? null;
    return {
      sourceLabel: clipSourceLabel({
        sourceKind: r.from_recorder ? 'recorder' : 'upload',
        mine,
        ownerName: identity?.name ?? null,
        ownerEmail: identity?.email ?? null,
        // Never the filename: see the doc comment above.
        originalFilename: null,
      }),
      offsetMs: r.offset_ms ?? 0,
      textPolicy: r.text_policy === 'gap_fill' || r.text_policy === 'exclude' ? r.text_policy : 'include',
      state: r.status === 'uploading' ? 'uploading' : r.status === 'error' ? 'failed' : 'transcribing',
      mine,
      since: r.created_at,
    };
  });
}
