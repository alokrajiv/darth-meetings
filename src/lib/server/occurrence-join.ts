import 'server-only';
import {
  ALIGN_MIN_CONFIDENCE,
  MAX_CLIPS_PER_MEETING,
  type ClipMutationOk,
} from '@/lib/clips';
import {
  annotationRekey,
  isIdentityRekey,
  joinBlockedReason,
  joinedOffsetFromAlign,
  occurrenceJoinsOf,
  pickJoinCandidate,
  rekeyEdits,
  rekeySpeakerLabels,
  rekeySuggestions,
  sameOccurrence,
  hasOccurrenceKey,
  DEFAULT_LINK_MODE,
  type JoinAlignment,
  type JoinBlockCode,
  type JoinTextState,
  type LinkCandidatesResponse,
  type LinkMode,
  type OccurrenceJoinMarker,
  type OccurrenceKey,
  type OccurrenceMeetingCandidate,
} from '@/lib/occurrence-join';
import {
  findOccurrenceMeetings,
  listOccurrenceJoins,
  patchOccurrenceJoinMarker,
  putMeetingSpeakers,
  recordingLinkState,
  removeOccurrenceJoinMarker,
  setOccurrenceJoinMarker,
  type OccurrenceMeetingRow,
} from '@/db-ops/occurrence-join';
import {
  clipsEnabled,
  combineEnabled,
  listMeetingClips,
  listMeetingEdits,
  listMeetingSpeakers,
  putMeetingEdits,
  recordingDetailsFor,
} from '@/db-ops/clips';
import { getRecording, listRecordingTranscriptions } from '@/db-ops/recordings';
import { keepStandalone } from '@/db-ops/standalone-recordings';
import { resolveAccess, type ResolvedAccess } from '@/db-ops/transcript-access';
import { updateAccess } from '@/db-ops/transcript-shares';
import { getForUser, mergeGmeetContextForUser, softDeleteForUser } from '@/db-ops/transcripts';
import {
  identitiesForUsers,
  identityForUser,
  logActivity,
} from '@/db-ops/transcript-activity';
import { addClip, patchClip, type ClipOpResult } from '@/lib/server/clip-combine';
import { clipWindowsOf } from '@/lib/server/clip-materialise';
import { alignRecordings, type AlignResult } from '@/lib/server/align';
import { publishEvent } from '@/lib/server/event-bus';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import { occurrenceKeyOf } from '@/lib/occurrence-join';
import type { GmeetAttendee, TranscriptResponse } from '@/lib/format';

/**
 * "This occurrence already has a meeting — add my recording to it"
 * (owner's model, 2026-10-02): a meeting is a timeline of one or more
 * recording segments, from several people, possibly overlapping; the AI that
 * writes its notes sees all of them. When Ivan links his recording to Teams
 * occurrence X and Ka Wen has already linked hers, Ivan's lands in Ka Wen's
 * meeting as another clip — one meeting, not two.
 *
 * Three link paths reach this (each with `mode: 'join' | 'separate'`,
 * default `join`):
 *   - `POST /api/recordings/:id/link` with an event (lib/server/recording-actions.ts),
 *   - an upload opened with a `linkedEvent` (lib/server/upload-pipeline.ts —
 *     the tray's Link, the web stepper, the calendar row's Upload, darth-cli
 *     `upload --event`), which is then born a RECORDING and joined at open,
 *   - `POST /api/transcripts/:id/link-event` on a meeting that is nothing but
 *     one of the caller's own recordings (it is folded in and trashed).
 *
 * PRIVACY. A candidate is a meeting the CALLER can already open (owner or
 * share — `findOccurrenceMeetings`, caller-scoped in SQL). The recording that
 * joins is always the caller's own: adding it is the owner giving its bytes
 * to that meeting's readers, which is exactly Phase 3b's rule (`addClip`
 * refuses anything else). No share is written by a join — the meeting's own
 * shares already decide who sees it — except that a caller holding a READ
 * share who is on the meeting's invite becomes an editor (owner, 2026-10-02:
 * "they are an internal invitee anyway"). The recording APIs stay owner-only.
 *
 * `MW_COMBINE`. With the flag on, a join adds the clip and merges the text at
 * once (or when the recording's transcription lands). With it OFF, the join
 * still happens as far as the person can tell — no second meeting is made,
 * the response says `joined` — but it is a RESERVATION: the marker
 * `text: 'waiting-combine'` on the meeting, no clip, the meeting's text and
 * recording graph untouched, the recording's expiry cleared. The born-bare
 * sweep adds it when the flag comes on (`settleOccurrenceJoins(null)`).
 */

export interface JoinCaller {
  userId: string;
  email: string;
  name?: string | null;
}

/** Seams the tests replace — the clip writer is the whole Phase 3b machinery
 * (materialise, mirror, roll-back) and the aligner calls the sidecar. */
export interface JoinDeps {
  addClip: typeof addClip;
  patchClip: typeof patchClip;
  align: (input: Parameters<typeof alignRecordings>[0]) => Promise<AlignResult>;
  /** false = never start the correlation (tests, and nothing else). */
  runAlign: boolean;
}

const DEFAULT_DEPS: JoinDeps = {
  addClip,
  patchClip,
  align: alignRecordings,
  runAlign: true,
};

let depsOverride: JoinDeps | null = null;

/** TESTS ONLY — swap the seams for every caller (the link routes and the
 * upload pipeline call in without a deps argument). `null` restores them. */
export function __setJoinDepsForTests(d: Partial<JoinDeps> | null): void {
  depsOverride = d ? { ...DEFAULT_DEPS, ...d } : null;
}

function currentDeps(): JoinDeps {
  return depsOverride ?? DEFAULT_DEPS;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** What the caller wants to bring into another meeting. */
export interface JoinSource {
  /** The caller's recording that would become the new clip. */
  recordingId: string;
  /** link-event only: the caller's meeting that would be folded in. */
  fromMeeting?: ResolvedAccess | null;
}

/**
 * Why `fromMeeting` (the caller's own single-recording meeting being linked
 * through `…/link-event`) may not be folded into another meeting — or null
 * when it may. Only a meeting that IS one of the caller's recordings, with
 * nothing of its own on top (notes, a second recording), moves; anything else
 * stays separate, because folding it would throw that work in the trash.
 */
export async function fromMeetingBlock(
  caller: JoinCaller,
  from: ResolvedAccess
): Promise<{ code: JoinBlockCode | null; recordingId: string | null }> {
  if (from.access !== 'owner' || from.row.deleted_at) return { code: 'not-movable', recordingId: null };
  if (from.row.auto_notes || from.row.auto_report) return { code: 'has-notes', recordingId: null };
  const clips = await listMeetingClips(from.row.id);
  if (clips.length !== 1) return { code: 'not-movable', recordingId: null };
  const rec = await getRecording(clips[0]!.recording_id);
  if (!rec || rec.deleted_at) return { code: 'not-movable', recordingId: null };
  if (rec.owner_user_id !== caller.userId) {
    return { code: 'not-owner-of-recording', recordingId: rec.id };
  }
  return { code: null, recordingId: rec.id };
}

function blockFor(
  row: OccurrenceMeetingRow,
  source: { recordingId: string | null; sourceBlock: JoinBlockCode | null }
): JoinBlockCode | null {
  if (source.sourceBlock) return source.sourceBlock;
  if (row.clip_count === 0) return 'no-recording';
  if (source.recordingId && (row.recording_ids ?? []).includes(source.recordingId)) return 'already-in';
  if (row.clip_count >= MAX_CLIPS_PER_MEETING) return 'full';
  if (row.access === 'read' && !row.caller_invited) return 'read-only';
  return null;
}

/**
 * CALLER-SCOPED — the meetings of this occurrence the caller can open, each
 * with whether this recording may join it, ranked: the caller's own first,
 * then the earliest. `candidate` is the one a default link joins.
 */
export async function occurrenceCandidates(
  caller: JoinCaller,
  key: OccurrenceKey,
  source: { recordingId: string | null; excludeTranscriptIds?: number[]; sourceBlock?: JoinBlockCode | null }
): Promise<LinkCandidatesResponse> {
  const empty: LinkCandidatesResponse = { candidate: null, candidates: [], defaultMode: DEFAULT_LINK_MODE };
  if (!hasOccurrenceKey(key)) return empty;
  // No clips on this server (or the tables are not there): there is nothing
  // a recording could be added AS, so every link stays a meeting of its own.
  if (!(await clipsEnabled().catch(() => false))) return empty;

  const rows = (
    await findOccurrenceMeetings(caller, key, { excludeTranscriptIds: source.excludeTranscriptIds })
  ).filter((r) => sameOccurrence(r, key));
  if (rows.length === 0) return empty;

  const identities = await identitiesForUsers(rows.map((r) => r.user_id));
  const candidates: OccurrenceMeetingCandidate[] = rows.map((r) => {
    const code = blockFor(r, { recordingId: source.recordingId, sourceBlock: source.sourceBlock ?? null });
    const who = identities.get(r.user_id) ?? null;
    const mine = r.user_id === caller.userId;
    return {
      meetingId: r.assemblyai_id,
      url: `/transcript/${r.assemblyai_id}`,
      title: r.title,
      ownerName: mine ? (caller.name ?? who?.name ?? null) : (who?.name ?? null),
      ownerEmail: mine ? caller.email : (who?.email ?? null),
      mine,
      access: r.access,
      recordingCount: (r.recording_ids ?? []).length,
      joinable: code === null,
      blockedCode: code,
      blockedReason: code ? joinBlockedReason(code) : null,
    };
  });
  return { candidate: pickJoinCandidate(candidates), candidates, defaultMode: DEFAULT_LINK_MODE };
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

export interface JoinedBody {
  joined: true;
  meetingId: string;
  meeting: { id: string; title: string | null };
  recordingId: string;
  /** Where the recording's text is right now. */
  text: JoinTextState;
  alignment: JoinAlignment;
  /** A join writes no share. */
  shares: 0;
  /** The caller held a read share on the invite and now edits. */
  upgradedToEditor: boolean;
}

export type JoinResult =
  | { ok: true; body: JoinedBody }
  | { ok: false; status: number; error: string; code?: string };

type Utterance = NonNullable<TranscriptResponse['utterances']>[number];

function failure(out: ClipOpResult<ClipMutationOk>): JoinResult {
  const body = (out as { body: { error?: string; code?: string } }).body;
  return {
    ok: false,
    status: (out as { status: number }).status ?? 409,
    error: body.error ?? 'Could not add the recording to that meeting',
    code: body.code,
  };
}

/**
 * Add the caller's recording to meeting `meetingId` (a candidate the caller
 * can open) as another clip: the whole recording, at offset 0 for now. Its
 * text is merged at once when it is transcribed (else when it lands), the
 * notes are marked stale, the page is nudged, and — when both sides have
 * media — the cross-correlation places it and the clip moves (`alignment`).
 */
export async function joinOccurrenceMeeting(
  input: {
    caller: JoinCaller;
    recordingId: string;
    meetingId: string;
    how: OccurrenceJoinMarker['how'];
  },
  deps: JoinDeps = currentDeps()
): Promise<JoinResult> {
  const { caller, recordingId } = input;
  let access = await resolveAccess(caller.userId, caller.email, input.meetingId);
  if (!access || access.row.deleted_at) {
    return { ok: false, status: 404, error: 'That meeting is not available to you.' };
  }

  // The recording is the caller's to give, always (404, never 403: no oracle).
  const rec = await getRecording(recordingId);
  if (!rec || rec.deleted_at || rec.owner_user_id !== caller.userId) {
    return { ok: false, status: 404, error: 'Not found' };
  }

  // A reader who is on the invite becomes an editor — they are a person the
  // meeting belongs to. A reader who is NOT is refused: someone chose read.
  // The upgrade is written only once every other check has passed, and taken
  // back if the add itself is refused.
  const needsUpgrade = access.access === 'read';
  if (needsUpgrade) {
    const invited = (access.row.gmeet_context?.attendees ?? []).some(
      (a: GmeetAttendee) => a?.email?.trim().toLowerCase() === caller.email.trim().toLowerCase()
    );
    if (!invited) {
      return { ok: false, status: 403, error: joinBlockedReason('read-only'), code: 'read-only' };
    }
  }
  let upgradedToEditor = false;
  const upgrade = async (): Promise<ResolvedAccess | null> => {
    if (!needsUpgrade) return access;
    await updateAccess(access!.row.id, caller.email, 'edit');
    upgradedToEditor = true;
    return resolveAccess(caller.userId, caller.email, input.meetingId);
  };

  const now = new Date().toISOString();
  const title = access.row.title ?? null;

  // MW_COMBINE off: reserve, change nothing about the meeting.
  if (!(await combineEnabled())) {
    if (!(await clipsEnabled())) {
      return { ok: false, status: 409, error: joinBlockedReason('disabled'), code: 'disabled' };
    }
    const clips = await listMeetingClips(access.row.id);
    if (clips.length === 0) return { ok: false, status: 409, error: joinBlockedReason('no-recording'), code: 'no-clip' };
    if (clips.some((c) => c.recording_id === recordingId)) {
      return { ok: false, status: 409, error: joinBlockedReason('already-in'), code: 'already-clipped' };
    }
    if (!(await upgrade())) return { ok: false, status: 404, error: 'That meeting is not available to you.' };
    await setOccurrenceJoinMarker(access.row.id, access.row.assemblyai_id, recordingId, {
      at: now,
      byUserId: caller.userId,
      by: caller.email,
      how: input.how,
      text: 'waiting-combine',
      alignment: 'unaligned',
    });
    await keepStandalone(caller.userId, recordingId, { keep: true }).catch(() => false);
    console.log(
      `[occurrence-join] ${recordingId} reserved for ${access.row.assemblyai_id} (MW_COMBINE off — added when it is on)`
    );
    return {
      ok: true,
      body: {
        joined: true,
        meetingId: access.row.assemblyai_id,
        meeting: { id: access.row.assemblyai_id, title },
        recordingId,
        text: 'waiting-combine',
        alignment: 'unaligned',
        shares: 0,
        upgradedToEditor,
      },
    };
  }

  const detail = (await recordingDetailsFor([recordingId])).get(recordingId) ?? null;
  const transcribed = detail?.transcribed ?? false;
  // Still on its way is fine (audio only, text when it lands); a transcription
  // that FAILED has nothing to land — the same refusal a link gets.
  if (!transcribed && rec.active_transcription_id) {
    const active = (await listRecordingTranscriptions([recordingId])).find(
      (t) => t.id === rec.active_transcription_id
    );
    if (active?.status === 'error') {
      return {
        ok: false,
        status: 409,
        code: 'not-ready',
        error: 'This recording\u2019s transcription failed — retry it first, then link it.',
      };
    }
  }
  const upgraded = await upgrade();
  if (!upgraded) return { ok: false, status: 404, error: 'That meeting is not available to you.' };
  access = upgraded;
  const before = utterancesOf(access.row.imported_content);

  // "Playable now, text later" (Phase 3b): a recording still uploading or
  // transcribing joins as audio only and its text is merged when it lands.
  const out = await deps.addClip({
    access,
    by: { userId: caller.userId, email: caller.email, name: caller.name ?? null },
    recordingId,
    fromMs: 0,
    toMs: null,
    offsetMs: 0,
    textPolicy: transcribed ? 'include' : 'exclude',
  });
  if (!out.ok) {
    if (upgradedToEditor) await updateAccess(access.row.id, caller.email, 'read').catch(() => null);
    return failure(out);
  }

  const alignment: JoinAlignment = transcribed && deps.runAlign ? 'aligning' : 'unaligned';
  const text: JoinTextState = transcribed ? 'merged' : 'pending';
  await setOccurrenceJoinMarker(access.row.id, access.row.assemblyai_id, recordingId, {
    at: now,
    byUserId: caller.userId,
    by: caller.email,
    how: input.how,
    text,
    alignment,
  });
  // In a meeting now: never temporary (I6).
  await keepStandalone(caller.userId, recordingId, { keep: true }).catch(() => false);

  await carryAnnotations(access, before);
  if (transcribed) await markNotesStale(access, caller, now);

  void logActivity({
    transcriptId: access.row.id,
    userId: caller.userId,
    email: caller.email,
    action: 'occurrence_join',
    details: { recordingId, how: input.how, text, ...(upgradedToEditor ? { upgradedToEditor } : {}) },
  });
  publishEvent({ kind: 'status', assemblyaiId: access.row.assemblyai_id });
  console.log(
    `[occurrence-join] ${input.how}: recording ${recordingId} (${caller.userId}) joined ${access.row.assemblyai_id} — text ${text}`
  );

  if (alignment === 'aligning') {
    void alignJoinedClip(access.row.assemblyai_id, recordingId, caller, deps).catch((err) =>
      console.warn(`[occurrence-join] aligning ${recordingId} in ${access!.row.assemblyai_id} failed:`, err)
    );
  }

  return {
    ok: true,
    body: {
      joined: true,
      meetingId: access.row.assemblyai_id,
      meeting: { id: access.row.assemblyai_id, title },
      recordingId,
      text,
      alignment,
      shares: 0,
      upgradedToEditor,
    },
  };
}

function utterancesOf(content: TranscriptResponse | null | undefined): Utterance[] {
  return Array.isArray(content?.utterances) ? (content!.utterances as Utterance[]) : [];
}

/**
 * Every user's edits and speaker names, moved onto the re-materialised text.
 *
 * A second recording starts the `<recordingId>:<label>` namespace and
 * interleaves new utterances, so without this Ka Wen's named speakers and
 * corrected sentences would silently fall off her meeting the moment Ivan's
 * recording joined it (`annotationRekey`).
 */
async function carryAnnotations(access: ResolvedAccess, before: Utterance[]): Promise<void> {
  if (before.length === 0) return;
  const fresh = await getForUser(access.ownerUserId, access.row.assemblyai_id);
  const after = utterancesOf(fresh?.imported_content);
  const rekey = annotationRekey(before, after);
  if (isIdentityRekey(rekey)) return;
  const id = access.row.assemblyai_id;
  for (const e of await listMeetingEdits(id)) {
    if (!e.edits || Object.keys(e.edits).length === 0) continue;
    await putMeetingEdits(e.user_id, id, rekeyEdits(e.edits, rekey));
  }
  if (rekey.labels.size === 0) return;
  for (const s of await listMeetingSpeakers(id)) {
    await putMeetingSpeakers(
      s.user_id,
      id,
      rekeySpeakerLabels(s.speaker_labels, rekey),
      rekeySuggestions(s.suggestions, rekey)
    );
  }
}

/** "A recording by Ivan was added on 2 Oct" — the notes were written without it. */
async function markNotesStale(access: ResolvedAccess, by: JoinCaller, at: string): Promise<void> {
  const fresh = (await getForUser(access.ownerUserId, access.row.assemblyai_id)) ?? access.row;
  if (!fresh.auto_notes && !fresh.auto_report) return;
  const who =
    by.name?.trim() || (await identityForUser(by.userId).catch(() => null))?.name?.trim() || by.email;
  const day = new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' });
  await mergeGmeetContextForUser(access.ownerUserId, access.row.assemblyai_id, {
    notesStale: {
      since: at,
      fromTranscriptionId: '',
      reason: `${who}’s recording of this call was added on ${day} — regenerate to include it`,
    },
  });
}

/**
 * Place the joined clip by the envelope cross-correlation against the
 * meeting's primary recording. Applied only when the match is confident
 * (≥ `ALIGN_MIN_CONFIDENCE`) and lands at or after the meeting's zero;
 * otherwise the clip stays at 0 and the marker says `unaligned`, which the
 * sheet shows as "line them up".
 *
 * The correlation runs as the recording's OWNER, who can reach both
 * recordings (their own, and the meeting's through their edit access) —
 * `alignRecordings` checks exactly that.
 */
export async function alignJoinedClip(
  meetingId: string,
  recordingId: string,
  by: JoinCaller,
  deps: JoinDeps = currentDeps()
): Promise<JoinAlignment> {
  const access = await resolveAccess(by.userId, by.email, meetingId);
  if (!access || access.row.deleted_at) return 'unaligned';
  const clips = clipWindowsOf(await listMeetingClips(access.row.id));
  const mine = clips.find((c) => c.recordingId === recordingId);
  const primary = clips.find((c) => c.recordingId !== recordingId);
  const settle = async (alignment: JoinAlignment, extra: Partial<OccurrenceJoinMarker> = {}) => {
    await patchOccurrenceJoinMarker(access.row.id, recordingId, { alignment, ...extra });
    publishEvent({ kind: 'meta', assemblyaiId: access.row.assemblyai_id });
    return alignment;
  };
  if (!mine || !primary) return settle('unaligned');

  const res = await deps.align({
    caller: { userId: by.userId, email: by.email },
    recordingId,
    againstRecordingId: primary.recordingId,
  });
  if (!res.ok) {
    console.log(`[occurrence-join] ${recordingId} not aligned in ${meetingId}: ${res.body.error}`);
    return settle('unaligned');
  }
  const { offsetMs, confidence } = res.body;
  const placed = joinedOffsetFromAlign(primary, offsetMs);
  if (confidence < ALIGN_MIN_CONFIDENCE || placed === null) {
    return settle('unaligned', { confidence, measuredOffsetMs: offsetMs });
  }
  if (placed !== mine.offsetMs) {
    const before = utterancesOf(access.row.imported_content);
    const out = await deps.patchClip({
      access,
      by: { userId: by.userId, email: by.email, name: by.name ?? null },
      ord: mine.ord,
      offsetMs: placed,
    });
    if (!out.ok) return settle('unaligned', { confidence, measuredOffsetMs: offsetMs });
    await carryAnnotations(access, before);
  }
  console.log(
    `[occurrence-join] ${recordingId} placed at ${placed} ms in ${meetingId} (confidence ${confidence.toFixed(2)})`
  );
  return settle('aligned', { confidence, measuredOffsetMs: offsetMs });
}

// ---------------------------------------------------------------------------
// link-event: folding the caller's own recording-meeting into the occurrence's
// ---------------------------------------------------------------------------

export interface FoldedBody extends JoinedBody {
  /** The caller's meeting that was folded in — now in their trash. */
  foldedMeetingId: string;
}

/**
 * `POST /api/transcripts/:id/link-event` on a meeting that is nothing but one
 * of the caller's own recordings (`fromMeetingBlock`): when a meeting of that
 * occurrence already exists that the caller can open, the recording is added
 * to IT (`joinOccurrenceMeeting`) and this meeting goes to the owner's trash
 * with a `joinedInto` pointer — one meeting for the call, and nothing lost
 * (Restore brings it back; its recording is untouched, now in both).
 *
 * null = do the ordinary link: `separate`, nothing to join, or (default mode
 * only) a join that could not happen. Under an EXPLICIT `join` a refusal is
 * the answer.
 */
export async function foldIntoOccurrenceMeeting(
  caller: JoinCaller,
  from: ResolvedAccess,
  key: OccurrenceKey,
  mode: LinkMode | null,
  deps: JoinDeps = currentDeps()
): Promise<{ ok: true; body: FoldedBody } | { ok: false; status: number; error: string; code?: string } | null> {
  if (mode === 'separate') return null;
  // Without MW_COMBINE a join is only a reservation; folding a meeting into
  // one that cannot show its recording yet would hide it in the trash for
  // nothing. The ordinary link it is, until the flag is on.
  if (!(await combineEnabled().catch(() => false))) return null;
  const source = await fromMeetingBlock(caller, from);
  const { candidate, candidates } = await occurrenceCandidates(caller, key, {
    recordingId: source.recordingId,
    excludeTranscriptIds: [from.row.id],
    sourceBlock: source.code,
  });
  if (!candidate || !source.recordingId) {
    if (mode === 'join' && candidates.length > 0) {
      return {
        ok: false,
        status: 409,
        error: candidates[0]!.blockedReason ?? joinBlockedReason('not-movable'),
        code: candidates[0]!.blockedCode ?? 'not-movable',
      };
    }
    return null;
  }
  const out = await joinOccurrenceMeeting(
    { caller, recordingId: source.recordingId, meetingId: candidate.meetingId, how: 'link-event' },
    deps
  );
  if (!out.ok) {
    if (mode === 'join') return out;
    console.warn(
      `[occurrence-join] folding ${from.row.assemblyai_id} into ${candidate.meetingId} refused (${out.error}) — linking it on its own`
    );
    return null;
  }
  const at = new Date().toISOString();
  await mergeGmeetContextForUser(from.ownerUserId, from.row.assemblyai_id, {
    joinedInto: { meetingId: out.body.meetingId, at },
  });
  await softDeleteForUser(from.ownerUserId, from.row.assemblyai_id);
  void logActivity({
    transcriptId: from.row.id,
    userId: caller.userId,
    email: caller.email,
    action: 'joined_into',
    details: { meetingId: out.body.meetingId, recordingId: source.recordingId },
  });
  console.log(
    `[occurrence-join] meeting ${from.row.assemblyai_id} folded into ${out.body.meetingId} (now in its owner's trash)`
  );
  return { ok: true, body: { ...out.body, foldedMeetingId: from.row.assemblyai_id } };
}

// ---------------------------------------------------------------------------
// Completion — the recording's text lands
// ---------------------------------------------------------------------------

async function callerOf(marker: OccurrenceJoinMarker): Promise<JoinCaller | null> {
  const email = marker.by ?? (await identityForUser(marker.byUserId).catch(() => null))?.email ?? null;
  return email ? { userId: marker.byUserId, email } : null;
}

/**
 * The recording behind a join settled: merge its text into every meeting it
 * joined while it was still on its way (`pending` → `merged`), and finish
 * every reservation made while `MW_COMBINE` was off once it is on. With no id
 * it is the sweep's backstop over every marker still open. Idempotent: the
 * merge is CLAIMED on the marker (`merging`) before anything is written.
 *
 * Called from `settleMeetingsMadeEarly` (lib/server/recording-settle.ts),
 * which every observer of a recording's completion already calls.
 */
export async function settleOccurrenceJoins(
  recordingId: string | null,
  outcome: { status: 'completed' } | { status: 'error'; reason: string } = { status: 'completed' },
  deps: JoinDeps = currentDeps()
): Promise<number> {
  // A failure is about ONE recording; the backstop never fails anything.
  if (outcome.status === 'error' && !recordingId) return 0;
  const rows = await listOccurrenceJoins(recordingId);
  if (rows.length === 0) return 0;
  const combineOn = await combineEnabled().catch(() => false);
  let settled = 0;
  for (const row of rows) {
    for (const [rid, marker] of Object.entries(occurrenceJoinsOf({ occurrenceJoins: row.joins }))) {
      if (recordingId && rid !== recordingId) continue;
      try {
        if (outcome.status === 'error') {
          if (marker.text === 'pending') {
            await patchOccurrenceJoinMarker(row.id, rid, { text: 'failed' }, ['pending']);
            publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
          }
          continue;
        }
        if (marker.text === 'waiting-combine') {
          if (!combineOn) continue;
          if (await finishReservation(row, rid, marker, deps)) settled++;
          continue;
        }
        if (marker.text === 'pending' || marker.text === 'failed') {
          if (!combineOn) continue;
          if (await mergeJoinedText(row, rid, marker, deps)) settled++;
        }
      } catch (err) {
        console.warn(`[occurrence-join] settling ${rid} in ${row.assemblyai_id} failed:`, err);
      }
    }
  }
  return settled;
}

/** `pending` → `merged`: the clip becomes `include`, the text is rebuilt. */
async function mergeJoinedText(
  row: { id: number; user_id: string; assemblyai_id: string },
  rid: string,
  marker: OccurrenceJoinMarker,
  deps: JoinDeps
): Promise<boolean> {
  const detail = (await recordingDetailsFor([rid])).get(rid) ?? null;
  if (!detail?.transcribed) return false;
  const by = await callerOf(marker);
  if (!by) return false;
  if (!(await patchOccurrenceJoinMarker(row.id, rid, { text: 'merging' }, ['pending', 'failed']))) return false;

  const access = await resolveAccess(by.userId, by.email, row.assemblyai_id);
  const clip = access ? (await listMeetingClips(access.row.id)).find((c) => c.recording_id === rid) : null;
  if (!access || !clip) {
    // Unshared, or the clip was removed by hand meanwhile: nothing to merge.
    await removeOccurrenceJoinMarker(row.id, rid);
    return false;
  }
  const before = utterancesOf(access.row.imported_content);
  const out = await deps.patchClip({
    access,
    by: { userId: by.userId, email: by.email, name: null },
    ord: clip.ord,
    textPolicy: 'include',
  });
  if (!out.ok) {
    await patchOccurrenceJoinMarker(row.id, rid, { text: 'pending' }, ['merging']);
    const refused = failure(out);
    console.warn(
      `[occurrence-join] merging ${rid} into ${row.assemblyai_id} refused: ${refused.ok ? '' : refused.error}`
    );
    return false;
  }
  await carryAnnotations(access, before);
  const now = new Date().toISOString();
  await markNotesStale(access, by, now);
  const alignment: JoinAlignment = deps.runAlign ? 'aligning' : 'unaligned';
  await patchOccurrenceJoinMarker(row.id, rid, { text: 'merged', alignment }, ['merging']);
  publishEvent({ kind: 'status', assemblyaiId: row.assemblyai_id });
  console.log(`[occurrence-join] ${rid}: text merged into ${row.assemblyai_id}`);
  if (alignment === 'aligning') {
    void alignJoinedClip(row.assemblyai_id, rid, by, deps).catch((err) =>
      console.warn(`[occurrence-join] aligning ${rid} in ${row.assemblyai_id} failed:`, err)
    );
  }
  return true;
}

/** `waiting-combine` → a real join, now that `MW_COMBINE` is on. */
async function finishReservation(
  row: { id: number; assemblyai_id: string },
  rid: string,
  marker: OccurrenceJoinMarker,
  deps: JoinDeps
): Promise<boolean> {
  const by = await callerOf(marker);
  if (!by) return false;
  // The reservation is consumed either way: a join that is refused now (the
  // share was withdrawn, the meeting filled up) hands the recording back to
  // its owner's Recordings, where it can be linked again.
  await removeOccurrenceJoinMarker(row.id, rid);
  const state = await recordingLinkState(rid);
  if (state.liveMeetings > 0) return false;
  const out = await joinOccurrenceMeeting(
    { caller: by, recordingId: rid, meetingId: row.assemblyai_id, how: marker.how },
    deps
  );
  if (!out.ok) {
    console.warn(`[occurrence-join] reservation of ${rid} in ${row.assemblyai_id} dropped: ${out.error}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The question the dialog asks before it links
// ---------------------------------------------------------------------------

/**
 * The occurrence a `…/link-candidates` query names: `event=<key | meeting
 * code>` (resolved from the CALLER's own calendar cache, the same resolver a
 * headless link uses), or the picked event's own facts as the web dialog has
 * them (`eventId`, `startTime`, `meetingCode`, `iCalUID`, `joinWebUrl`).
 */
export async function occurrenceKeyFromQuery(
  userId: string,
  q: URLSearchParams
): Promise<{ ok: true; key: OccurrenceKey } | { ok: false; status: number; error: string }> {
  const ref = q.get('event')?.trim();
  if (ref) {
    const resolved = await resolveLinkedEventRef(userId, ref);
    if (!resolved.ok) return resolved;
    return { ok: true, key: occurrenceKeyOf(resolved.event) };
  }
  const key = occurrenceKeyOf({
    eventId: q.get('eventId'),
    startTime: q.get('startTime'),
    meetingCode: q.get('meetingCode'),
    iCalUID: q.get('iCalUID'),
    joinWebUrl: q.get('joinWebUrl'),
  });
  if (!hasOccurrenceKey(key)) {
    return { ok: false, status: 400, error: 'Name the event: event=<key or meeting code>, or eventId (+ startTime)' };
  }
  return { ok: true, key };
}

/** Re-exported for the routes that answer "is this recording free to link?". */
export { recordingLinkState };
