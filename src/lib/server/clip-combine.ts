import 'server-only';
import {
  candidateClipForTime,
  clipOverlaps,
  clipShortLabel,
  clipSourceKindOf,
  clipSourceLabel,
  combineRefusal,
  formatDuration,
  meetingSpanFromDurations,
  nextClipOrd,
  nominalOffsetMsBetween,
  recordingCountOf,
  validateAddClip,
  validateDeleteClip,
  validatePatchClip,
  MAX_CLIPS_PER_MEETING,
  type ClipCandidate,
  type ClipCandidatesResponse,
  type ClipEntry,
  type ClipMutationOk,
  type ClipWindow,
  type CombineRefusal,
} from '@/lib/clips';
import { compareClipsOnTimeline, type ClipTextPolicy } from '@/lib/recording-clips';
import { isBareRecording } from '@/lib/meeting-title';
import { occurrenceJoinsOf } from '@/lib/occurrence-join';
import {
  clippedMeetingsOnRecordingExcept,
  combineEnabled,
  deleteMeetingClip,
  listAddableRecordings,
  listMeetingClips,
  recordingDetailsFor,
  setClipMirror,
  upsertMeetingClip,
  restoreMeetingPayloadFromRecording,
  type ClipRecordingDetail,
  type MeetingClipRow,
} from '@/db-ops/clips';
import { getRecording } from '@/db-ops/recordings';
import { queueClipPrecut } from '@/lib/server/clip-precut';
import { identitiesForUsers } from '@/db-ops/transcript-activity';
import { logActivity } from '@/db-ops/transcript-activity';
import { getForUser } from '@/db-ops/transcripts';
import { materialiseMeeting, clipWindowsOf, policyOf } from '@/lib/server/clip-materialise';
import {
  mediaPartsByRecording,
  resolveMeetingMedia,
  type ResolvedMedia,
} from '@/lib/server/recordings';
import type { ResolvedAccess } from '@/db-ops/transcript-access';

/**
 * Combine — "several recordings, one meeting"
 * (docs/recordings-phase3b-combine-spec.md, behind `MW_COMBINE`).
 *
 * Two DIFFERENT captures of one meeting: the Teams video with a dead-audio
 * stretch plus the phone that caught it, a laptop recording plus the corridor,
 * a Meet recording that stopped and a tray recording that ran on. The
 * recordings stay what they are — own file, own transcription, own diarization
 * space (DEC-1) — and the MEETING lists more than one clip, each on a
 * different recording, placed on one timeline. No file is cut and nothing is
 * re-transcribed (DEC-2).
 *
 * PRIVACY, the rule this module exists to enforce (spec §Privacy):
 *
 *   A recording's bytes belong to its OWNER. Adding someone else's recording
 *   to a meeting is allowed only when that recording's owner is an editor of
 *   the meeting AND performs the add themselves — which, since the adder is
 *   always the caller, reduces to: **the caller must own the recording.**
 *   An editor may add their own recordings freely, the clip list names each
 *   recording's owner, and every candidate list is caller-scoped in SQL
 *   (`listAddableRecordings`).
 *
 * The add is also the CONSENT that lets the meeting's readers play those
 * bytes — see `scopeMediaToRow` in lib/server/recordings.ts, which is the
 * other half of the same rule.
 */

/**
 * Same shape as `clip-split.ts`'s, declared here rather than imported: the
 * split module imports THIS one (for `combineView`), and a runtime cycle
 * between the two is not worth one type alias.
 */
export type ClipOpResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; body: { error: string; code?: string } };

export interface CombineActor {
  userId: string;
  email: string;
  name?: string | null;
}

function refuse<T>(refusal: CombineRefusal, status = 409): ClipOpResult<T> {
  return { ok: false, status, body: { error: refusal.message, code: refusal.code } };
}

// ---------------------------------------------------------------------------
// Reading a meeting's clips, with their sources named
// ---------------------------------------------------------------------------

export interface CombineState {
  rows: MeetingClipRow[];
  clips: ClipWindow[];
  entries: ClipEntry[];
  details: Map<string, ClipRecordingDetail>;
  spanMs: number;
  /** The recording that provides the meeting's canonical file — the player's
   * default part, the one `local_audio_path` names. */
  primaryRecordingId: string | null;
}

/** How long a recording runs, from its row or from what its clips heard. */
function durationOfRecording(details: Map<string, ClipRecordingDetail>) {
  return (recordingId: string): number | null => {
    const d = details.get(recordingId);
    return d?.duration_ms != null && d.duration_ms > 0 ? d.duration_ms : null;
  };
}

/**
 * INTERNAL — gate on the MEETING first (`resolveAccess`). Reads every clip of
 * the meeting and names the recording behind each one.
 *
 * The caller is needed only to say `mine` on each row: a clip list is served
 * to anyone who can open the meeting (reachability route (a)), and naming the
 * owner is the point — a reader must be able to see whose bytes they are
 * listening to.
 */
export async function combineState(
  access: ResolvedAccess,
  caller: { userId: string },
  /**
   * The meeting's playable files, when the caller has them. Given, every
   * entry gets its `?part=N` (`mediaPart` / `mediaParts`); omitted, those two
   * stay null / empty and the client is left to guess — which is why the two
   * readers a PLAYER is built from (`combineView` for the GET, `mutationBody`
   * for what a sheet edit hands back) both pass it, and the add/patch/delete
   * pre-state, the candidate list and the notes' Sources block — none of
   * which plays anything — do not pay for the load.
   */
  opts?: { media?: ResolvedMedia[] | null }
): Promise<CombineState> {
  const rows = await listMeetingClips(access.row.id);
  const clips = clipWindowsOf(rows);
  const recordingIds = [...new Set(clips.map((c) => c.recordingId))];
  const details = await recordingDetailsFor(recordingIds);
  const identities = await identitiesForUsers(
    [...details.values()].map((d) => d.owner_user_id)
  );

  // The row's own file decides which recording is primary. Falling back to
  // "first on the timeline" matters for the rows that have no path of their
  // own (the shared-AssemblyAI-job pair), where there is exactly one anyway.
  const primaryRecordingId = clips.length > 0 ? (clips[0]!.recordingId ?? null) : null;

  const spanMs = meetingSpanFromDurations(clips, durationOfRecording(details));
  // Recordings that joined from a link to the same occurrence carry whether
  // the correlation placed them (lib/occurrence-join.ts).
  const joins = occurrenceJoinsOf(access.row.gmeet_context);

  // `?part=N` per recording, canonical first — the numbering walks FILES
  // (`mediaForRecordings`), so this is the only place it is correct.
  const partsOf = opts?.media ? mediaPartsByRecording(opts.media) : null;

  const entries: ClipEntry[] = clips.map((clip) => {
    const detail = details.get(clip.recordingId) ?? null;
    const identity = detail ? (identities.get(detail.owner_user_id) ?? null) : null;
    const mine = detail?.owner_user_id === caller.userId;
    const durationMs =
      clip.toMs !== null
        ? Math.max(0, clip.toMs - clip.fromMs)
        : detail?.duration_ms != null
          ? Math.max(0, detail.duration_ms - clip.fromMs)
          : null;
    const facts = {
      sourceKind: detail?.source_kind ?? null,
      mine,
      ownerName: identity?.name ?? null,
      ownerEmail: identity?.email ?? null,
      originalFilename: detail?.original_filename ?? null,
    };
    const mediaParts = partsOf?.get(clip.recordingId) ?? [];
    return {
      ord: clip.ord,
      recordingId: clip.recordingId,
      fromMs: clip.fromMs,
      toMs: clip.toMs,
      offsetMs: clip.offsetMs,
      textPolicy: clip.textPolicy ?? 'include',
      transcribed: detail?.transcribed ?? false,
      durationMs,
      sourceLabel: clipSourceLabel(facts),
      sourceKind: clipSourceKindOf(facts.sourceKind),
      shortLabel: clipShortLabel(facts),
      ownerEmail: identity?.email ?? null,
      ownerName: identity?.name ?? null,
      mine,
      primary: clip.recordingId === primaryRecordingId,
      recordingDurationMs: detail?.duration_ms ?? null,
      recordingStartedAt: detail?.started_at ?? null,
      mediaPart: mediaParts[0] ?? null,
      mediaParts,
      ...(joins[clip.recordingId] ? { alignment: joins[clip.recordingId]!.alignment ?? null } : {}),
    };
  });

  return { rows, clips, entries, details, spanMs, primaryRecordingId };
}

/**
 * The 3b half of `GET /api/transcripts/:id/clips` — the clip list with its
 * sources, and whether "Add a recording…" may be offered.
 *
 * Served whenever CLIPS are enabled, with or without `MW_COMBINE`: a
 * one-recording meeting is a one-entry list and that is what the recording
 * card renders either way. Only the ADD is behind the flag.
 */
export async function combineView(
  access: ResolvedAccess,
  caller: { userId: string; email: string }
): Promise<{
  entries: ClipEntry[];
  recordingCount: number;
  combineEnabled: boolean;
  canAddRecording: boolean;
  addBlockedReason: string | null;
}> {
  // The player asks which `?part=N` plays each clip, so this reader — and
  // only this reader — pays for the meeting's media list (spec §UI, "parts =
  // clips"). Resolved from the same graph `resolveMeetingContent` walks, so
  // the number served here is the number `/audio?part=N` answers to.
  const media = await resolveMeetingMedia(access.row);
  const state = await combineState(access, caller, { media });
  const on = await combineEnabled();
  const blocked = addPrecondition(access, state, on);
  return {
    entries: state.entries,
    recordingCount: recordingCountOf(state.clips),
    combineEnabled: on,
    canAddRecording: on && !blocked,
    addBlockedReason: blocked?.message ?? null,
  };
}

/** Everything that stops an add before any recording is even named. */
function addPrecondition(
  access: ResolvedAccess,
  state: CombineState,
  enabled: boolean
): CombineRefusal | null {
  if (!enabled) return combineRefusal('disabled');
  if (access.access === 'read') return combineRefusal('read-only');
  if (access.row.deleted_at) {
    return combineRefusal('disabled', 'This meeting is in the trash.');
  }
  if (state.clips.length === 0) return combineRefusal('no-clip');
  if (state.clips.length >= MAX_CLIPS_PER_MEETING) return combineRefusal('too-many-clips');
  return null;
}

// ---------------------------------------------------------------------------
// The candidate list
// ---------------------------------------------------------------------------

/**
 * `GET /api/transcripts/:id/clips/candidates` — the recordings THIS caller may
 * be offered.
 *
 * Caller-scoped in SQL (`listAddableRecordings`), then filtered here to drop
 * the recordings this meeting already holds. A row the caller can see but not
 * add (someone else's bytes, reached through a meeting they can edit) is
 * listed with `addable: false` and the sentence that says why — that is not a
 * leak, because the caller can already open the meeting it belongs to; what
 * would be a leak is inventing an ADD they are not allowed to make.
 */
export async function clipCandidates(
  access: ResolvedAccess,
  caller: { userId: string; email: string }
): Promise<ClipCandidatesResponse> {
  const on = await combineEnabled();
  const state = await combineState(access, caller);
  const blocked = addPrecondition(access, state, on);
  if (blocked) {
    return {
      enabled: on && state.clips.length > 0,
      canEdit: access.access !== 'read',
      candidates: [],
      slotsLeft: Math.max(0, MAX_CLIPS_PER_MEETING - state.clips.length),
    };
  }

  const already = new Set(state.clips.map((c) => c.recordingId));
  const rows = await listAddableRecordings(caller);
  const identities = await identitiesForUsers(rows.map((r) => r.owner_user_id));
  const primary = state.primaryRecordingId
    ? (state.details.get(state.primaryRecordingId) ?? null)
    : null;

  const candidates: ClipCandidate[] = [];
  for (const r of rows) {
    if (already.has(r.id)) continue;
    const identity = identities.get(r.owner_user_id) ?? null;
    const mine = r.owner_user_id === caller.userId;
    // "Not linked to a meeting yet" is the Recordings tab's own test, applied
    // to the meeting that holds this recording: no meeting at all, or a BARE
    // one (no calendar event, no human title — lib/meeting-title).
    const unlinked =
      r.meeting_id === null ||
      isBareRecording({
        title: r.meeting_title,
        original_filename: r.meeting_original_filename,
        has_event: r.meeting_has_event ?? false,
        scratch: r.meeting_scratch ?? false,
        deleted_at: null,
        recorded_at: r.meeting_recorded_at,
        created_at: r.meeting_created_at ?? new Date(0).toISOString(),
      });
    candidates.push({
      recordingId: r.id,
      sourceLabel: clipSourceLabel({
        sourceKind: r.source_kind,
        mine,
        ownerName: identity?.name ?? null,
        ownerEmail: identity?.email ?? null,
        originalFilename: r.original_filename,
      }),
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      transcribed: r.transcribed,
      mine,
      ownerEmail: identity?.email ?? null,
      ownerName: identity?.name ?? null,
      // A bare meeting is a recording, not a meeting — naming it would put a
      // filename on screen as a title, which the vocabulary forbids.
      meeting:
        r.meeting_id && !unlinked
          ? { id: r.meeting_id, url: `/transcript/${r.meeting_id}`, title: r.meeting_title }
          : null,
      unlinked,
      addable: mine,
      blockedReason: mine ? null : combineRefusal('not-owned').message,
      nominalOffsetMs: nominalOffsetMsBetween(primary?.started_at ?? null, r.started_at),
    });
  }

  return {
    enabled: true,
    canEdit: true,
    candidates,
    slotsLeft: Math.max(0, MAX_CLIPS_PER_MEETING - state.clips.length),
  };
}

// ---------------------------------------------------------------------------
// Add / patch / delete
// ---------------------------------------------------------------------------

export interface AddClipInput {
  access: ResolvedAccess;
  by: CombineActor;
  recordingId: string;
  fromMs: number;
  toMs: number | null;
  offsetMs: number;
  textPolicy: ClipTextPolicy;
}

export async function addClip(input: AddClipInput): Promise<ClipOpResult<ClipMutationOk>> {
  const { access, by } = input;
  const on = await combineEnabled();
  const state = await combineState(access, by);
  const blocked = addPrecondition(access, state, on);
  if (blocked) return refuse(blocked, blocked.code === 'read-only' ? 403 : 409);

  // Reachability first, ownership second — and a recording the caller can
  // neither own nor reach is 404, never 403, so this route is not an oracle
  // for "does recording <uuid> exist".
  const recording = await getRecording(input.recordingId);
  if (!recording || recording.deleted_at) {
    return refuse(combineRefusal('recording-not-found'), 404);
  }
  if (recording.owner_user_id !== by.userId) {
    const reachable = await listAddableRecordings(by, { recordingId: input.recordingId });
    if (reachable.length === 0) return refuse(combineRefusal('recording-not-found'), 404);
    return refuse(combineRefusal('not-owned'), 403);
  }

  const detail = (await recordingDetailsFor([input.recordingId])).get(input.recordingId) ?? null;
  const bad = validateAddClip({
    clips: state.clips,
    recordingId: input.recordingId,
    ownedByCaller: true,
    transcribed: detail?.transcribed ?? false,
    fromMs: input.fromMs,
    toMs: input.toMs,
    offsetMs: input.offsetMs,
    textPolicy: input.textPolicy,
  });
  if (bad) return refuse(bad);

  const ord = nextClipOrd(state.clips);
  await upsertMeetingClip({
    transcriptId: access.row.id,
    ord,
    recordingId: input.recordingId,
    fromMs: input.fromMs,
    toMs: input.toMs,
    offsetMs: input.offsetMs,
    textPolicy: input.textPolicy,
    createdBy: `combine:${by.email}`,
  });

  const written = await writeMirrorAndMaterialise(access, by, state, 'add');
  if (!written.ok) return written as ClipOpResult<ClipMutationOk>;

  void logActivity({
    transcriptId: access.row.id,
    userId: by.userId,
    email: by.email,
    action: 'clip_add',
    details: {
      ord,
      recordingId: input.recordingId,
      offsetMs: input.offsetMs,
      textPolicy: input.textPolicy,
    },
  });

  return mutationBody(access, by, written.materialised);
}

export interface PatchClipInput {
  access: ResolvedAccess;
  by: CombineActor;
  ord: number;
  fromMs?: number;
  toMs?: number | null;
  offsetMs?: number;
  textPolicy?: ClipTextPolicy;
}

export async function patchClip(input: PatchClipInput): Promise<ClipOpResult<ClipMutationOk>> {
  const { access, by } = input;
  const on = await combineEnabled();
  if (!on) return refuse(combineRefusal('disabled'));
  if (access.access === 'read') return refuse(combineRefusal('read-only'), 403);

  const state = await combineState(access, by);
  const current = state.clips.find((c) => c.ord === input.ord);
  if (!current) return refuse(combineRefusal('clip-not-found'), 404);

  const next = {
    fromMs: input.fromMs ?? current.fromMs,
    toMs: input.toMs === undefined ? current.toMs : input.toMs,
    offsetMs: input.offsetMs ?? current.offsetMs,
    textPolicy: input.textPolicy ?? current.textPolicy ?? 'include',
  };
  const detail = state.details.get(current.recordingId) ?? null;
  const bad = validatePatchClip({
    clips: state.clips,
    ord: input.ord,
    transcribed: detail?.transcribed ?? false,
    ...next,
  });
  if (bad) return refuse(bad);

  await upsertMeetingClip({
    transcriptId: access.row.id,
    ord: input.ord,
    recordingId: current.recordingId,
    ...next,
  });

  const written = await writeMirrorAndMaterialise(access, by, state, 'edit');
  if (!written.ok) return written as ClipOpResult<ClipMutationOk>;

  void logActivity({
    transcriptId: access.row.id,
    userId: by.userId,
    email: by.email,
    action: 'clip_edit',
    details: { ord: input.ord, recordingId: current.recordingId, ...next },
  });

  return mutationBody(access, by, written.materialised);
}

/**
 * Un-combine — `DELETE …/clips/:ord`. Never the last clip.
 *
 * The RECORDING keeps existing (its own meeting, or the Recordings tab): a
 * clip is a pointer and deleting one deletes no bytes. The permanent-delete
 * rule from 3a (`mayDeleteRecordingFiles`) is what protects a recording another
 * meeting still clips, and it needs nothing new here.
 */
export async function deleteClip(
  access: ResolvedAccess,
  by: CombineActor,
  ord: number
): Promise<ClipOpResult<ClipMutationOk>> {
  const on = await combineEnabled();
  if (!on) return refuse(combineRefusal('disabled'));
  if (access.access === 'read') return refuse(combineRefusal('read-only'), 403);

  const state = await combineState(access, by);
  const bad = validateDeleteClip(state.clips, ord);
  if (bad) return refuse(bad, bad.code === 'clip-not-found' ? 404 : 409);

  const recordingId = await deleteMeetingClip(access.row.id, ord);
  const written = await writeMirrorAndMaterialise(access, by, state, 'remove');
  if (!written.ok) return written as ClipOpResult<ClipMutationOk>;

  void logActivity({
    transcriptId: access.row.id,
    userId: by.userId,
    email: by.email,
    action: 'clip_remove',
    details: { ord, recordingId },
  });

  return mutationBody(access, by, written.materialised);
}

// ---------------------------------------------------------------------------
// The write that every mutation shares
// ---------------------------------------------------------------------------

interface MaterialisedFacts {
  utterances: number;
  durationSec: number | null;
  speakerCount: number | null;
}

/**
 * Mirror the new clip set onto the row, rebuild the meeting's text, and — if
 * that would have emptied a meeting that had text — put everything back.
 *
 * The MIRROR is not optional (spec §Model, and Phase 3a's landmine): the
 * desired recording graph is derived FROM THE ROW, so a second clip that lived
 * only in `meeting_clips` would be healed away by the very next dual-write.
 * It carries `textPolicy` as well as the window, or a `gap_fill` clip would be
 * healed back to `include` and double up every word both mics caught.
 *
 * The ROLLBACK is the safety net that makes this survivable: materialising
 * reads the RECORDINGS' transcriptions, so a meeting whose graph was never
 * synced (flag turned on five minutes ago) would otherwise have its text
 * replaced with nothing. `prior` is the state before the write.
 */
async function writeMirrorAndMaterialise(
  access: ResolvedAccess,
  by: CombineActor,
  prior: CombineState,
  what: 'add' | 'edit' | 'remove'
): Promise<
  | { ok: true; materialised: MaterialisedFacts }
  | { ok: false; status: number; body: { error: string; code?: string } }
> {
  const rows = await listMeetingClips(access.row.id);
  const clips = clipWindowsOf(rows);
  const isDefault =
    clips.length === 1 &&
    clips[0]!.ord === 0 &&
    clips[0]!.fromMs === 0 &&
    clips[0]!.toMs === null &&
    clips[0]!.offsetMs === 0 &&
    (clips[0]!.textPolicy ?? 'include') === 'include';

  await setClipMirror(access.ownerUserId, access.row.assemblyai_id, {
    clips: isDefault ? null : clips,
  });
  // A window or hole this write created is served cut: start it now. The
  // pre-cut reads the row when it runs (after a short settle), so a rollback
  // below is what it sees — and queues the same meeting again anyway.
  queueClipPrecut(access.row.assemblyai_id, `combine-${what}`);

  // Back to exactly one whole recording: the row gets that recording's own
  // payload back VERBATIM, copied inside Postgres — the same bytes it carried
  // before anything was combined, not the resolver's rebuild of them. This is
  // the un-split's last step and un-combining needs it for the same reason.
  if (isDefault) {
    const restored = await restoreMeetingPayloadFromRecording(access.row.id);
    if (restored.restored) {
      const fresh = await getForUser(access.ownerUserId, access.row.assemblyai_id);
      return {
        ok: true,
        materialised: {
          utterances: restored.utterances,
          durationSec: fresh?.duration ?? null,
          speakerCount: fresh?.speaker_count ?? null,
        },
      };
    }
  }

  const out = await materialiseMeeting(access.row.id, { force: true });
  const hadText = (access.row.imported_content?.utterances ?? []).length > 0;
  if (hadText && out.written && out.utterances === 0) {
    // The meeting had text and now has none — the recordings' transcriptions
    // are not where this expects them. Undo and say so rather than leave a
    // meeting blank.
    console.error(
      `[combine] ${access.row.assemblyai_id}: ${what} emptied the meeting's text — rolling back`
    );
    await restorePriorClips(access, by, prior);
    return {
      ok: false,
      status: 409,
      body: {
        error:
          'This meeting’s recordings are not fully set up on the server yet, so its text could not be rebuilt. Nothing was changed.',
        code: 'no-clip',
      },
    };
  }

  return {
    ok: true,
    materialised: {
      utterances: out.utterances,
      durationSec: out.durationSec,
      speakerCount: out.speakerCount,
    },
  };
}

/** Put the clip rows, the mirror and the text back exactly as they were. */
async function restorePriorClips(
  access: ResolvedAccess,
  by: CombineActor,
  prior: CombineState
): Promise<void> {
  const keep = new Set(prior.clips.map((c) => c.ord));
  const now = await listMeetingClips(access.row.id);
  for (const row of now) {
    if (!keep.has(row.ord)) await deleteMeetingClip(access.row.id, row.ord);
  }
  for (const clip of prior.clips) {
    await upsertMeetingClip({
      transcriptId: access.row.id,
      ord: clip.ord,
      recordingId: clip.recordingId,
      fromMs: clip.fromMs,
      toMs: clip.toMs,
      offsetMs: clip.offsetMs,
      textPolicy: clip.textPolicy ?? 'include',
      createdBy: `combine-rollback:${by.email}`,
    });
  }
  const priorMirror = access.row.gmeet_context?.clips ?? null;
  await setClipMirror(access.ownerUserId, access.row.assemblyai_id, {
    clips: Array.isArray(priorMirror) ? (priorMirror as unknown[]) : null,
  });
  queueClipPrecut(access.row.assemblyai_id, 'combine-rollback');
  await materialiseMeeting(access.row.id, { force: true }).catch(() => {});
}

/** The answer every mutation gives: the whole clip list, again. */
async function mutationBody(
  access: ResolvedAccess,
  by: CombineActor,
  materialised: MaterialisedFacts
): Promise<ClipOpResult<ClipMutationOk>> {
  // Re-read the row: `spanMs` and the entries have to describe what is there
  // NOW, not the row the request arrived with.
  const fresh = await getForUser(access.ownerUserId, access.row.assemblyai_id);
  const row = fresh ?? access.row;
  // The sheet re-renders its part chips off this body, so the part numbers
  // have to be the post-write ones (an add can have created media rows).
  const media = await resolveMeetingMedia(row);
  const state = await combineState({ ...access, row }, by, { media });
  return {
    ok: true,
    body: {
      ok: true,
      clips: state.entries,
      spanMs: state.spanMs,
      recordingCount: recordingCountOf(state.clips),
      materialised,
    },
  };
}

// ---------------------------------------------------------------------------
// "Playable now, text later"
// ---------------------------------------------------------------------------

/**
 * A recording's transcription has just landed — rebuild the text of every
 * OTHER meeting that holds a clip on it (spec §API: a recording added with
 * `exclude` while still processing is "playable now, text later", and
 * materialised again on completion).
 *
 * Called from the completion hook, exactly as Phase 2's version swap calls
 * `rematerialiseMeetingsOnRecording`. The meeting the recording belongs to is
 * excluded because the completing write has just dealt with it.
 */
export async function rematerialiseCombinedMeetings(
  recordingId: string,
  ownTranscriptId: number
): Promise<number> {
  const ids = await clippedMeetingsOnRecordingExcept(recordingId, ownTranscriptId);
  let written = 0;
  for (const id of ids) {
    try {
      const out = await materialiseMeeting(id);
      if (out.written) written += 1;
    } catch (err) {
      console.warn(`[combine] re-materialise of meeting ${id} failed:`, err);
    }
  }
  if (written > 0) {
    console.log(`[combine] ${recordingId}: re-materialised ${written} combined meeting(s)`);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Shared with the readers
// ---------------------------------------------------------------------------

/**
 * The "Sources" block for the AI prompts — one line per clip, in timeline
 * order, saying what each recording is and where it sits (spec §"Reader and
 * writer changes"; it replaces `buildUploadedPartsContext` for a combined
 * meeting).
 *
 * Returns '' for a one-recording meeting: there is nothing to explain and the
 * stitched-parts block still covers the concatenated-upload case.
 */
export function buildSourcesBlock(entries: ClipEntry[]): string {
  if (entries.length < 2) return '';
  const recordings = new Set(entries.map((e) => e.recordingId));
  if (recordings.size < 2) return '';
  const ordered = [...entries].sort(compareClipsOnTimeline);
  const lines = ordered.map((e) => {
    const at = formatDuration(e.offsetMs);
    const span = e.durationMs != null ? `, ${formatDuration(e.durationMs)} long` : '';
    const policy =
      e.textPolicy === 'gap_fill'
        ? ' — used ONLY where the other recordings caught no speech'
        : e.textPolicy === 'exclude'
          ? ' — audio only, its words are NOT in the transcript below'
          : '';
    const who = e.mine ? '' : e.ownerName || e.ownerEmail ? ` (${e.ownerName ?? e.ownerEmail})` : '';
    const heard = e.transcribed ? '' : ' — not transcribed yet';
    // The speaker namespace is the fact the model most needs: "A" of one
    // recording is NOT "A" of another (DEC-1, one job = one diarization space).
    return `- ${e.sourceLabel}${who}, starting at ${at} of the meeting${span}${policy}${heard}. Its speakers appear below as "${e.recordingId.slice(0, 8)}…:<letter>".`;
  });
  // Two people recorded the same stretch (two trays on one call): both texts
  // are kept, so the model is told exactly where the same minutes appear
  // twice, under which two namespaces, and that they are one stretch.
  const byRecording = new Map(ordered.map((e) => [e.recordingId, e]));
  const overlaps = clipOverlaps(ordered).map((o) => {
    const a = byRecording.get(o.a.recordingId);
    const b = byRecording.get(o.b.recordingId);
    const name = (e: ClipEntry | undefined, rid: string) =>
      `${e?.sourceLabel ?? 'a recording'} ("${rid.slice(0, 8)}…:<letter>")`;
    return `- OVERLAP ${formatDuration(o.fromMs)}–${formatDuration(o.toMs)} of the meeting: ${name(a, o.a.recordingId)} and ${name(b, o.b.recordingId)} both cover it. The same minutes appear TWICE below, once under each recording's speaker prefix, with different letters for the same people and slightly different wording — reconcile them into one account; never count anything said there twice.`;
  });
  return (
    `SOURCES: this meeting was captured ${recordings.size} times, by different devices, and the transcript below is those recordings placed on ONE timeline (no file was cut and nothing was re-transcribed):\n` +
    lines.join('\n') +
    (overlaps.length > 0 ? `\n${overlaps.join('\n')}` : '') +
    `\nEach recording was diarized on its own, so the same person may appear under a different letter in each — treat two labels from DIFFERENT recordings as possibly the same human, and never as two people just because the letters differ. Where two recordings overlap you may see the same moment described twice; that is one moment, not two.\n\n`
  );
}

/** Which clip a `t:<ms>` chip should play — re-exported so the transcript page
 * and darth-cli use the same answer the server does. */
export { candidateClipForTime, policyOf };
