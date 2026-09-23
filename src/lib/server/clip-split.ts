import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  countEdits,
  holesOf,
  meetingSpanMs,
  mergeEditMaps,
  mergeOrder,
  planSplit,
  planUnsplit,
  recordingAnchorIso,
  rekeyEditMap,
  selectWindow,
  splitPrecondition,
  splitRefusal,
  windowBoundsFor,
  type ClipSibling,
  type ClipWindow,
  type ClipsResponse,
  type SplitOk,
  type SplitRefusal,
  type SplitProvenance,
  type UnsplitOk,
} from '@/lib/clips';
import { compareClipsOnTimeline } from '@/lib/recording-clips';
import { aaiJobIdOf } from '@/lib/aai-job-state';
import {
  clipsEnabled,
  copySpeakerMappings,
  listMeetingClips,
  listMeetingEdits,
  listMeetingSpeakers,
  purgeMeetingAnnotations,
  putMeetingEdits,
  recordingFactsFor,
  restoreMeetingPayloadFromRecording,
  setClipMirror,
  type MeetingClipRow,
} from '@/db-ops/clips';
import { applyMeetingClips, listSiblingMeetingsForRecordings } from '@/db-ops/recordings';
import { meetingCopyCount } from '@/db-ops/transcriptions';
import {
  createForUser,
  deleteForUser,
  getForUser,
  mergeGmeetContextForUser,
  setLocalAudioPathForUser,
  setSpeakerIdForUser,
  updateStatusForUser,
} from '@/db-ops/transcripts';
import { deleteAnnotationsForMeeting } from '@/db-ops/transcriptions';
import { logActivity } from '@/db-ops/transcript-activity';
import { resolveAccess, type ResolvedAccess } from '@/db-ops/transcript-access';
import { materialiseMeeting } from '@/lib/server/clip-materialise';
import { combineView } from '@/lib/server/clip-combine';
import { pendingAttachFor } from '@/lib/server/clip-attach';
import { removeRecordingGraphForMeeting } from '@/lib/server/recording-sync';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import { registerPeopleFromMeeting } from '@/lib/server/import-helpers';
import { autoAttachSeries } from '@/lib/server/series-attach';
import type { GmeetAttendee, GmeetContext, StoredTranscript } from '@/lib/format';

/**
 * Split and un-split — "from when Paola joined until she left is its own
 * meeting" (docs/recordings-phase3-clips-spec.md).
 *
 * No file is cut and nothing is re-transcribed (DEC-2): a split only chooses
 * a WINDOW of a recording that both meetings already read. The arithmetic is
 * pure and lives in `lib/clips.ts`; this module is the sequence of writes.
 *
 * How a split survives the recording graph
 * ----------------------------------------
 * `applyRecordingGraph` derives the DESIRED graph from the meeting ROW, so a
 * split that lived only in `meeting_clips` would be healed back to one
 * whole-recording clip by the next dual-write. Both halves therefore carry
 * their windows on the row, in `gmeet_context.clips`:
 *
 *  - the SOURCE keeps owning its recording. `desiredClipsFor` reads the
 *    mirror, `deriveRecordingGraph` sets `wholeRecording: false` (so the
 *    row's materialised payload is never copied back onto the transcription,
 *    and its shrunken duration never onto the recording), and the stale-ord
 *    delete in `applyRecordingGraph` removes a window the row no longer
 *    declares.
 *  - the SPLIT-OFF meeting points its clip at the SOURCE's recording id, so
 *    `borrowsRecording` is true and `syncRecordingGraphForMeeting` writes its
 *    clips and nothing else — no second recording over the same bytes.
 *
 * `scripts/recordings-verify.ts` compares against the same mirror, so the
 * verifier and the writer cannot disagree.
 */

export interface SplitActor {
  userId: string;
  email: string;
  name?: string | null;
}

export interface SplitInput {
  access: ResolvedAccess;
  by: SplitActor;
  fromMs: number;
  toMs: number;
  title?: string | null;
  eventRef?: string | null;
  keepInBoth?: boolean;
}

export type ClipOpResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; body: { error: string; code?: string } };

function refuse<T>(refusal: SplitRefusal, status = 409): ClipOpResult<T> {
  return { ok: false, status, body: { error: refusal.message, code: refusal.code } };
}

// ---------------------------------------------------------------------------
// Reading a meeting's clips
// ---------------------------------------------------------------------------

/** `meeting_clips` rows as the pure layer wants them, in timeline order. */
export function windowsOf(rows: MeetingClipRow[]): ClipWindow[] {
  return rows
    .map((c) => ({
      ord: c.ord,
      recordingId: c.recording_id,
      fromMs: c.from_ms,
      toMs: c.to_ms,
      offsetMs: c.offset_ms,
    }))
    .sort(compareClipsOnTimeline);
}

/**
 * Is this the clip set of a meeting that was never split — one clip, the
 * whole recording, in place?
 *
 * The mirror on the row exists only to say "this meeting is NOT that", so a
 * meeting whose clips come back to this shape must lose it again (or
 * `deriveRecordingGraph` would go on refusing to copy its payload onto the
 * transcription for ever). That is what an un-split turns on.
 */
export function isDefaultClipSet(clips: ClipWindow[]): boolean {
  if (clips.length !== 1) return false;
  const c = clips[0]!;
  return c.ord === 0 && c.fromMs === 0 && c.toMs === null && c.offsetMs === 0;
}

/** How long the recording runs, from the graph or — failing that — the row. */
function recordingSpanMs(
  facts: { duration_ms: number | null } | null,
  row: Pick<StoredTranscript, 'duration' | 'imported_content'>
): number | null {
  if (facts?.duration_ms != null && facts.duration_ms > 0) return facts.duration_ms;
  if (row.duration != null && row.duration > 0) return Math.round(row.duration * 1000);
  const utterances = row.imported_content?.utterances ?? [];
  if (utterances.length === 0) return null;
  return Math.max(...utterances.map((u) => u.end));
}

/** Utterance start times on the MEETING timeline — what a window selects by. */
function utteranceStarts(row: Pick<StoredTranscript, 'imported_content'>): number[] {
  return (row.imported_content?.utterances ?? []).map((u) => u.start);
}

export interface MeetingClipState {
  clips: ClipWindow[];
  rows: MeetingClipRow[];
  recordingId: string | null;
  recordingDurationMs: number | null;
  recordingStartedAt: string | null;
  spanMs: number;
}

/** INTERNAL (gate on the meeting first) — the clip facts every verb needs. */
export async function meetingClipState(row: StoredTranscript): Promise<MeetingClipState> {
  const rows = await listMeetingClips(row.id);
  const clips = windowsOf(rows);
  const recordingId = clips[0]?.recordingId ?? null;
  const facts = recordingId ? await recordingFactsFor(recordingId) : null;
  const recordingDurationMs = recordingSpanMs(facts, row);
  return {
    clips,
    rows,
    recordingId,
    recordingDurationMs,
    recordingStartedAt: facts?.started_at ? new Date(facts.started_at).toISOString() : null,
    spanMs: meetingSpanMs(clips, recordingDurationMs),
  };
}

/**
 * "Could this meeting be split right now?" — asked of the DATABASE, answered
 * by the pure `splitPrecondition`.
 *
 * Both callers go through here: the GET, to say whether the menu item may be
 * offered and why not, and the POST, to refuse. One function, therefore one
 * answer — the menu cannot offer what the route would turn down.
 */
async function splitPreconditionFor(
  row: StoredTranscript,
  state: MeetingClipState
): Promise<SplitRefusal | null> {
  return splitPrecondition({
    enabled: true,
    trashed: !!row.deleted_at,
    status: row.status,
    retranscribing: !!row.gmeet_context?.retranscribing,
    // The one legacy pair of meetings that share an AssemblyAI job: two rows,
    // one set of bytes, and a split would rewrite `imported_content` on one of
    // them while the other kept showing the old text under the same id.
    sharedJob: (await meetingCopyCount(row.assemblyai_id)) > 1,
    // A stop/restart Meet meeting has several playable files and only the
    // first was transcribed; a window of "the meeting" has no single file to
    // clamp.
    videoParts: row.gmeet_context?.videoParts?.length ?? 0,
    hasClip: !!state.recordingId && state.clips.length > 0,
    spanMs: state.spanMs,
  });
}

/**
 * `GET /api/transcripts/:id/clips`.
 *
 * PRIVACY: siblings and `splitFrom` are resolved through the CALLER's own
 * access. A recording has no ACL — the only thing that may decide whether
 * another meeting on it is mentioned is whether this caller could open it
 * (feedback_privacy_caller_scoping_gate). A person shared only the split-off
 * half never learns the longer meeting exists: no id, no title, no window,
 * not even a count.
 */
export async function clipsView(
  access: ResolvedAccess,
  caller: { userId: string; email: string }
): Promise<ClipsResponse> {
  const empty: ClipsResponse = {
    enabled: false,
    canEdit: access.access !== 'read',
    recording: null,
    clips: [],
    spanMs: 0,
    window: null,
    holes: [],
    siblings: [],
    splitFrom: null,
    canUnsplit: false,
    unsplitBlockedReason: null,
    splittable: false,
    splitBlockedReason: null,
  };
  if (!(await clipsEnabled())) return empty;

  const state = await meetingClipState(access.row);
  if (!state.recordingId) return empty;

  // Phase 3b: the clip list with each recording's source named, and whether
  // "Add a recording…" may be offered. Served whenever clips are on — a
  // one-recording meeting is a one-entry list — with only the ADD behind
  // `MW_COMBINE` (docs/recordings-phase3b-combine-spec.md).
  const combine = await combineView(access, caller);
  // Phase 3b source (c): uploads that named THIS meeting and have not landed
  // yet — "A recording is being added: Upload · transcribing…". Caller-scoped
  // in SQL and filename-free (lib/server/clip-attach.ts).
  const pendingAttach = await pendingAttachFor(access, caller);

  const bounds = windowBoundsFor(state.clips, state.recordingId);
  const siblingRows = await listSiblingMeetingsForRecordings(
    [...new Set(state.clips.map((c) => c.recordingId))],
    access.row.id,
    { userId: caller.userId, email: caller.email }
  );
  const provenance = access.row.gmeet_context?.splitFrom ?? null;

  const siblings: ClipSibling[] = siblingRows.map((s) => ({
    id: s.assemblyai_id,
    url: `/transcript/${s.assemblyai_id}`,
    title: s.title,
    fromMs: s.from_ms,
    toMs: s.to_ms,
    durationMs: s.duration != null ? Math.round(s.duration * 1000) : null,
    isSource: provenance?.meetingId === s.assemblyai_id,
    isSplitOff: s.split_from === access.row.assemblyai_id,
    trashed: s.trashed,
  }));

  // The source is named only when the caller can open it, which is exactly
  // "it came back from the caller-scoped sibling query".
  const sourceSibling = provenance ? (siblings.find((s) => s.isSource) ?? null) : null;
  const unsplit = await unsplitVerdict(access, state, sourceSibling);
  const splitBlocked = await splitPreconditionFor(access.row, state);

  return {
    enabled: true,
    canEdit: access.access !== 'read',
    recording: {
      id: state.recordingId,
      durationMs: state.recordingDurationMs,
      // The recording's own clock when it has one, else the meeting's — the
      // dialog's calendar pre-filter needs a day to ask about, and an
      // approximate anchor beats none (`recordingAnchorIso`).
      startedAt: recordingAnchorIso(
        state.recordingStartedAt,
        access.row.recorded_at,
        access.row.created_at
      ),
    },
    clips: state.clips,
    spanMs: state.spanMs,
    window: bounds.fromMs === null && bounds.toMs === null ? null : { fromMs: bounds.fromMs ?? 0, toMs: bounds.toMs },
    holes: holesOf(state.clips, state.spanMs),
    siblings,
    splitFrom:
      provenance && sourceSibling
        ? { ...provenance, title: sourceSibling.title, url: sourceSibling.url }
        : null,
    canUnsplit: unsplit.can,
    unsplitBlockedReason: unsplit.reason,
    splittable: !splitBlocked,
    splitBlockedReason: splitBlocked?.message ?? null,
    entries: combine.entries,
    recordingCount: combine.recordingCount,
    combineEnabled: combine.combineEnabled,
    canAddRecording: combine.canAddRecording,
    addBlockedReason: combine.addBlockedReason,
    pendingAttach,
  };
}

/** Whether "put it back" may be offered, in words that never name a meeting
 * the caller cannot open. */
async function unsplitVerdict(
  access: ResolvedAccess,
  state: MeetingClipState,
  source: ClipSibling | null
): Promise<{ can: boolean; reason: string | null }> {
  const provenance = access.row.gmeet_context?.splitFrom ?? null;
  if (!provenance) return { can: false, reason: null };
  if (access.access === 'read') return { can: false, reason: 'You have read-only access here.' };
  if (state.clips.length !== 1) {
    return { can: false, reason: 'This meeting has been re-clipped since it was split off.' };
  }
  if (access.row.auto_notes || access.row.auto_report) {
    return {
      can: false,
      reason: 'This meeting has notes of its own — putting it back would lose them.',
    };
  }
  if (!source) {
    return { can: false, reason: 'The meeting it came from is not available to you.' };
  }
  if (source.trashed) {
    return { can: false, reason: 'The meeting it came from is in the trash.' };
  }
  return { can: true, reason: null };
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

/**
 * The new meeting's public id.
 *
 * A bare uuid for an ordinary upload — Phase 1b's rule, and what keeps the
 * ~27 "no known prefix ⇒ an ordinary transcribed meeting" call sites right.
 * A Meet/Teams/text meeting keeps its family's prefix, because `providerOf`
 * and `sourceKindOf` read it and the split-off half has the same provenance.
 */
export function mintSplitMeetingId(sourceId: string): string {
  const prefix = /^(gmeet-|teams-|ext-)/.exec(sourceId)?.[1] ?? '';
  return `${prefix}${randomUUID()}`;
}

/** The instant the new meeting starts: the recording's zero plus the window. */
function anchorFor(
  recordingStartedAt: string | null,
  row: StoredTranscript,
  recordingFromMs: number
): Date | null {
  const base = recordingStartedAt ?? row.recorded_at ?? null;
  if (!base) return null;
  const t = Date.parse(typeof base === 'string' ? base : new Date(base).toISOString());
  if (Number.isNaN(t)) return null;
  return new Date(t + recordingFromMs);
}

export async function splitMeeting(input: SplitInput): Promise<ClipOpResult<SplitOk>> {
  const { access, by } = input;
  const row = access.row;

  if (!(await clipsEnabled())) return refuse(splitRefusal('disabled'));

  // Every refusal about the MEETING comes from the one function the GET
  // answers `splittable` with, so a menu item that was offered is an item
  // this route accepts (`splitPrecondition`).
  const state = await meetingClipState(row);
  const blocked = await splitPreconditionFor(row, state);
  if (blocked) return refuse(blocked);

  const plan = planSplit({
    clips: state.clips,
    fromMs: input.fromMs,
    toMs: input.toMs,
    spanMs: state.spanMs,
    keepInBoth: input.keepInBoth,
  });
  if ('code' in plan) return refuse(plan);

  // The calendar event first: `createForUser` mints the new meeting's /m link
  // from the context it is given, and D-C says a half linked to an occurrence
  // adopts that occurrence's pre-minted uuid. Resolving afterwards would mint
  // the wrong one.
  let event: Awaited<ReturnType<typeof resolveLinkedEventRef>> | null = null;
  if (input.eventRef) {
    event = await resolveLinkedEventRef(by.userId, input.eventRef);
    if (!event.ok) return { ok: false, status: event.status, body: { error: event.error } };
  }
  const linked = event?.ok ? event.event : null;
  const attendees: GmeetAttendee[] = (linked?.attendees ?? []).map((a) => ({
    email: a.email,
    name: a.name,
    responseStatus: a.responseStatus,
  }));

  const newId = mintSplitMeetingId(row.assemblyai_id);
  const provenance: SplitProvenance = {
    meetingId: row.assemblyai_id,
    fromMs: plan.recordingFromMs,
    toMs: plan.recordingToMs,
    at: new Date().toISOString(),
    by: { email: by.email ?? null, name: by.name ?? null },
  };
  const context: GmeetContext = {
    ...(linked
      ? {
          eventId: linked.id,
          eventTitle: linked.title,
          startTime: linked.startTime,
          endTime: linked.endTime,
          meetingCode: linked.meetingCode,
          attendees,
          ...(linked.recurringEventId ? { recurringEventId: linked.recurringEventId } : {}),
          ...(linked.iCalUID ? { iCalUID: linked.iCalUID } : {}),
          ...(linked.organizerEmail ? { organizerEmail: linked.organizerEmail } : {}),
        }
      : {}),
    clips: plan.created,
    splitFrom: provenance,
  };

  const title = input.title?.trim() || linked?.title || null;
  // D-A: a split is not a promotion — the half inherits `scratch`. Linking it
  // to an event is what makes it permanent, exactly as it would for an upload.
  const scratch = !!row.scratch && !linked;

  const created = await createForUser(access.ownerUserId, {
    assemblyaiId: newId,
    // The job that produced the text this meeting shows. Without it the bare
    // uuid would read as an AssemblyAI job id everywhere (`aaiJobIdOf`) and
    // retention would one day ask AssemblyAI to delete a meeting id it has
    // never heard of.
    aaiJobId: aaiJobIdOf(row),
    originalFilename: row.original_filename,
    // Born `completed`, never `processing`: a row in processing WITH a job id
    // is what the listing poller and the stuck-at-AssemblyAI sweeper pick up,
    // and they would ask AssemblyAI about a job that was finished (and, under
    // DEC-4, deleted) long ago.
    status: 'completed',
    languageCode: row.language_code,
    title,
    gmeetContext: context,
    speechModel: row.speech_model,
    scratch,
  });

  // The bytes: the SAME canonical file. Nothing is cut (DEC-2) — the player
  // clamps to `windowFromMs`/`windowToMs`, which the resolver reads off the
  // clip. `scopeMediaToRow` still requires the row to carry a path of its own,
  // so this is also what makes the new meeting playable at all.
  if (row.local_audio_path) {
    await setLocalAudioPathForUser(access.ownerUserId, newId, row.local_audio_path);
  }
  await applyMeetingClips(
    created.id,
    plan.created.map((c) => ({
      transcriptId: created.id,
      ord: c.ord,
      recordingId: c.recordingId,
      transcriptionId: null,
      fromMs: c.fromMs,
      toMs: c.toMs,
      offsetMs: c.offsetMs,
      textPolicy: 'include' as const,
    })),
    `split:${by.email}`
  );
  await materialiseMeeting(created.id, {
    recordedAt: anchorFor(state.recordingStartedAt, row, plan.recordingFromMs),
  });
  await updateStatusForUser(access.ownerUserId, newId, {
    completedAt: row.completed_at ? new Date(row.completed_at) : new Date(),
  });

  // Speaker names and suggestions: the same recording, therefore the same
  // diarization space (DEC-1), therefore the same labels mean the same people.
  const speakerRows = await listMeetingSpeakers(row.assemblyai_id);
  await copySpeakerMappings(row.assemblyai_id, newId);
  const speakerNames = speakerRows.reduce(
    (n, r) => n + (r.speaker_labels ?? []).filter((l) => l.customName?.trim()).length,
    0
  );
  // The ID pass does not have to run again: same recording, same diarization
  // space, and its answers have just been copied. Saying so is also what keeps
  // `listSpeakerIdBacklog` (which sweeps completed meetings that have neither
  // notes nor a pass) from spending a model call on it.
  const idStatus =
    row.speaker_id_status ?? (speakerRows.length > 0 ? 'completed' : null);
  if (idStatus) await setSpeakerIdForUser(access.ownerUserId, newId, { status: idStatus });

  // Edits, every user's, re-keyed both ways (landmine #2).
  const starts = utteranceStarts(row);
  const picked = selectWindow(starts, input.fromMs, input.toMs);
  const editRows = await listMeetingEdits(row.assemblyai_id);
  let movedEdits = 0;
  for (const e of editRows) {
    const inside = rekeyEditMap(e.edits ?? null, picked.inside);
    movedEdits += countEdits(inside);
    await putMeetingEdits(e.user_id, newId, inside);
  }

  // The source. With `keepInBoth` nothing about it changes at all.
  let notesStale = false;
  if (!input.keepInBoth) {
    await setClipMirror(access.ownerUserId, row.assemblyai_id, {
      clips: isDefaultClipSet(plan.source) ? null : plan.source,
    });
    await applyMeetingClips(
      row.id,
      plan.source.map((c) => ({
        transcriptId: row.id,
        ord: c.ord,
        recordingId: c.recordingId,
        transcriptionId: null,
        fromMs: c.fromMs,
        toMs: c.toMs,
        offsetMs: c.offsetMs,
        textPolicy: 'include' as const,
      })),
      `split:${by.email}`
    );
    for (const e of editRows) {
      await putMeetingEdits(e.user_id, row.assemblyai_id, rekeyEditMap(e.edits ?? null, picked.outside));
    }
    await materialiseMeeting(row.id, { force: true });

    // The notes on the source were written about a meeting that included the
    // part now living elsewhere. Say so; never regenerate on our own.
    if (row.auto_notes || row.auto_report) {
      notesStale = true;
      await mergeGmeetContextForUser(access.ownerUserId, row.assemblyai_id, {
        notesStale: {
          since: provenance.at,
          fromTranscriptionId: '',
          reason: `Part of this meeting was split off on ${stampDay(provenance.at)}`,
        },
      });
    }
  }

  // Shares are NOT copied (spec), and the calendar link brings nobody in
  // either (design P4, owner 2026-09-23): linking never shares. The new
  // meeting is its owner's alone; the event's invitees are in its context,
  // so the share dialog suggests them.
  if (linked && attendees.length > 0) {
    await registerPeopleFromMeeting(
      attendees.map((a) => ({ email: a.email, name: a.name })),
      by.userId
    );
  }
  if (linked) {
    await autoAttachSeries({
      id: created.id,
      assemblyai_id: newId,
      gmeet_context: context,
      title,
      user_id: access.ownerUserId,
      scratch,
    });
  }

  void logActivity({
    transcriptId: created.id,
    userId: by.userId,
    email: by.email,
    action: 'split_from',
    details: { sourceId: row.assemblyai_id, fromMs: plan.recordingFromMs, toMs: plan.recordingToMs },
  });
  void logActivity({
    transcriptId: row.id,
    userId: by.userId,
    email: by.email,
    action: 'split_off',
    details: { newId, fromMs: plan.recordingFromMs, toMs: plan.recordingToMs, keepInBoth: !!input.keepInBoth },
  });

  const fresh = await getForUser(access.ownerUserId, newId);
  return {
    ok: true,
    body: {
      ok: true,
      meeting: {
        id: newId,
        url: `/transcript/${newId}`,
        title: fresh?.title ?? title,
        fromMs: plan.recordingFromMs,
        toMs: plan.recordingToMs,
        durationMs: plan.recordingToMs - plan.recordingFromMs,
      },
      moved: { edits: movedEdits, speakerNames },
      source: { clips: plan.source, notesStale },
      ...(linked
        ? {
            linkedEvent: {
              title: linked.title ?? null,
              startTime: linked.startTime ?? null,
              attendees: attendees.length,
            },
          }
        : {}),
    },
  };
}

/**
 * "22 Sep" — the day a split happened, for the source's stale-notes line.
 *
 * In SINGAPORE time, like every other date this app shows a person. UTC would
 * be off by a day for anything after 08:00 SGT, which is most of the working
 * day.
 */
function stampDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an earlier date';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Singapore',
  }).format(d);
}

// ---------------------------------------------------------------------------
// Un-split
// ---------------------------------------------------------------------------

/**
 * "Put it back", from the SPLIT-OFF meeting.
 *
 * The source's two clips merge back into one, both halves' edits go back on
 * one map in time order, and the split-off row is destroyed — its bytes were
 * never its own, so no file is touched.
 *
 * The caller must be able to EDIT BOTH meetings. A person shared only the
 * split-off half cannot put it back into a meeting they cannot open, and the
 * refusal never says which meeting that is.
 */
export async function unsplitMeeting(
  access: ResolvedAccess,
  by: SplitActor
): Promise<ClipOpResult<UnsplitOk>> {
  const row = access.row;
  if (!(await clipsEnabled())) return refuse(splitRefusal('disabled'));

  const provenance = row.gmeet_context?.splitFrom ?? null;
  if (!provenance) {
    return { ok: false, status: 409, body: { error: 'This meeting was not split off another one.' } };
  }
  if (row.auto_notes || row.auto_report) {
    return {
      ok: false,
      status: 409,
      body: { error: 'This meeting has notes of its own — putting it back would lose them.' },
    };
  }

  const sourceAccess = await resolveAccess(by.userId, by.email, provenance.meetingId);
  const blocked = { ok: false as const, status: 409, body: { error: 'This meeting cannot be put back.' } };
  if (!sourceAccess || sourceAccess.access === 'read' || sourceAccess.row.deleted_at) return blocked;

  const mine = await meetingClipState(row);
  const source = await meetingClipState(sourceAccess.row);
  if (mine.clips.length !== 1) return blocked;
  const merged = planUnsplit({ sourceClips: source.clips, clip: mine.clips[0]! });
  if (!merged) {
    return {
      ok: false,
      status: 409,
      body: { error: 'The meeting it came from has changed shape — it cannot be put back.' },
    };
  }

  // Where this meeting's utterances land on the SOURCE's timeline once the
  // merged clip is in place: recording ms, then the merged clip's placement.
  const clip = mine.clips[0]!;
  const target = merged.find((c) => c.recordingId === clip.recordingId) ?? merged[0]!;
  const toSourceMs = (ms: number) => ms + clip.fromMs - target.fromMs + target.offsetMs;
  const clipStarts = utteranceStarts(row).map(toSourceMs);
  const sourceStarts = utteranceStarts(sourceAccess.row);
  const slots = mergeOrder(sourceStarts, clipStarts);

  await setClipMirror(sourceAccess.ownerUserId, sourceAccess.row.assemblyai_id, {
    clips: isDefaultClipSet(merged) ? null : merged,
  });
  await applyMeetingClips(
    sourceAccess.row.id,
    merged.map((c) => ({
      transcriptId: sourceAccess.row.id,
      ord: c.ord,
      recordingId: c.recordingId,
      transcriptionId: null,
      fromMs: c.fromMs,
      toMs: c.toMs,
      offsetMs: c.offsetMs,
      textPolicy: 'include' as const,
    })),
    `unsplit:${by.email}`
  );

  // A source that is whole again gets its recording's payload back VERBATIM
  // (copied inside Postgres): it is the same bytes it carried before the
  // split, not the resolver's rebuild of them.
  if (isDefaultClipSet(merged)) {
    await restoreMeetingPayloadFromRecording(sourceAccess.row.id);
  } else {
    await materialiseMeeting(sourceAccess.row.id, { force: true });
  }

  // Both halves' edits back on one map. Every user's, and only when the merge
  // order really describes the meeting that came out — a mismatch means the
  // text moved under us, and dropping the edits beats mis-pointing them.
  const fresh = await getForUser(sourceAccess.ownerUserId, sourceAccess.row.assemblyai_id);
  const restoredCount = (fresh?.imported_content?.utterances ?? []).length;
  let restored = 0;
  if (restoredCount === slots.length) {
    const sourceEdits = new Map(
      (await listMeetingEdits(sourceAccess.row.assemblyai_id)).map((e) => [e.user_id, e.edits ?? null])
    );
    const clipEdits = new Map(
      (await listMeetingEdits(row.assemblyai_id)).map((e) => [e.user_id, e.edits ?? null])
    );
    for (const userId of new Set([...sourceEdits.keys(), ...clipEdits.keys()])) {
      const map = mergeEditMaps(sourceEdits.get(userId) ?? null, clipEdits.get(userId) ?? null, slots);
      restored += countEdits(clipEdits.get(userId) ?? null);
      await putMeetingEdits(userId, sourceAccess.row.assemblyai_id, map);
    }
  } else {
    console.warn(
      `[clips] unsplit ${row.assemblyai_id}: merged into ${restoredCount} utterances but the merge ` +
        `order has ${slots.length} — edits were not carried back`
    );
  }

  // The split-off row goes. Its clips first (no FK on `transcript_id`), then
  // the row. NO FILE IS TOUCHED: the bytes belong to the recording, which the
  // source still clips (lib/clips.ts `mayDeleteRecordingFiles` says the same
  // thing for the delete route).
  await purgeMeetingAnnotations(row.assemblyai_id);
  await deleteAnnotationsForMeeting(row.id).catch(() => {});
  await removeRecordingGraphForMeeting(row.id, 'unsplit');
  await deleteForUser(access.ownerUserId, row.assemblyai_id);
  await removeRecordingGraphForMeeting(row.id, 'unsplit/after');

  void logActivity({
    transcriptId: sourceAccess.row.id,
    userId: by.userId,
    email: by.email,
    action: 'edit_meta',
    details: { unsplit: row.assemblyai_id },
  });

  return {
    ok: true,
    body: {
      ok: true,
      meeting: {
        id: sourceAccess.row.assemblyai_id,
        url: `/transcript/${sourceAccess.row.assemblyai_id}`,
        title: sourceAccess.row.title,
      },
      restored: { edits: restored },
    },
  };
}
