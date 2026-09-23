import type { GmeetContext } from '@/lib/format';
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  deleteForUser,
  getForUser,
  mergeGmeetContextForUser,
  removeGmeetContextKeysForUser,
  setRecordedAtForUser,
  setScratchForUser,
  softDeleteForUser,
  touchLastAccessedForUser,
  updateMetaForUser,
} from '@/db-ops/transcripts';
import { removeLinkBornShares } from '@/db-ops/share-origin';
import { deleteForUser as deleteSpeakerMappingsForUser } from '@/db-ops/speaker-mappings';
import { resolveAccess } from '@/db-ops/transcript-access';
import { identityForUser, logActivity } from '@/db-ops/transcript-activity';
import { deleteTranscript as aaiDelete } from '@/lib/server/assemblyai';
import { aaiJobIdOf } from '@/lib/aai-job-state';
import { deleteAudioFile } from '@/lib/server/audio-storage';
import { dropAudioOnly } from '@/lib/server/audio-only';
import { refreshIfPending } from '@/lib/server/transcript-sync';
import { removeRecordingGraphForMeeting } from '@/lib/server/recording-sync';
import { deleteAnnotationsForMeeting } from '@/db-ops/transcriptions';
import { mayDeleteRecordingFiles } from '@/lib/clips';
import { redactForReader } from '@/lib/reader-redaction';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id
 * Fetch a single transcript row visible to the current user (owner or
 * shared). If the row is still pending, refresh from AAI before returning.
 * Also bumps last_accessed on the owner's row.
 */
/**
 * `gmeet_context.splitFrom` names the SOURCE meeting a split-off row came
 * from. That id is served only by GET …/clips, which checks the caller can
 * open the source; the detail payload goes to everyone the row is shared
 * with, so the source id is replaced by a bare flag here. The page never
 * reads it — every sibling name and link comes from the clips route.
 */
function withoutSplitSource<T extends { gmeet_context: GmeetContext | null }>(row: T): T {
  const ctx = row.gmeet_context;
  if (!ctx?.splitFrom) return row;
  const { meetingId: _omit, ...rest } = ctx.splitFrom;
  void _omit;
  return { ...row, gmeet_context: { ...ctx, splitFrom: { ...rest, meetingId: '' } } };
}

export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const refreshed = await refreshIfPending(access.ownerUserId, access.row);
  await touchLastAccessedForUser(access.ownerUserId, id);

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'view',
  });

  // Shared rows say who owns them ("Recorded on Atira's Mac" in the
  // Recording card) — same identity source as the listing.
  const owner = access.access === 'owner' ? null : await identityForUser(access.ownerUserId);

  return NextResponse.json({
    transcript: redactForReader({
      ...withoutSplitSource(refreshed),
      access: access.access,
      owner_email: owner?.email ?? null,
      owner_name: owner?.name ?? null,
    }),
  });
});

/**
 * The calendar event's own keys on `gmeet_context` — what an "unlink" takes
 * off (D5). Everything else on the row (the recording, its clips, the
 * transcript, the title, the date, the notes) is left exactly as it is:
 * unlinking says "this recording is not that meeting", not "throw it away".
 *
 * `actuals` / `meetTranscript` go too — both were fetched FROM the linked
 * conference and would otherwise keep claiming the row is that meeting.
 */
const EVENT_CONTEXT_KEYS = [
  'eventId',
  'eventTitle',
  'startTime',
  'endTime',
  'meetingCode',
  'recurringEventId',
  'iCalUID',
  'organizerEmail',
  'attendees',
  'provider',
  'teams',
  'actuals',
  'meetTranscript',
  'videoFileId',
  'transcriptDocId',
];

/**
 * PATCH /api/transcripts/:id
 * Update title and/or description, the meeting date (`recordedAt`), and the
 * temporary flag (`scratch: boolean`, migration 042 — "Keep" / "Move to
 * temporary"). Editors (owner + 'edit' shares) can update; read-only shares
 * cannot.
 *
 * Two calendar-link actions live here too
 * (docs/recorder-link-confirm-spec.md §3):
 *   - `{ unlinkEvent: true }` — D5. Detach the calendar event: its keys and
 *     attendees come off the row and the shares the link created are deleted
 *     (stamped `origin='event-link'` since migration 048; for older rows, the
 *     auto-share's own signature against the event's attendee list). The
 *     recording, the title and the meeting date stay as they are, and
 *     `gmeet_context.unlinkedBy` records who did it.
 *   - `{ dismissSuggestedEvent: true }` — D4's "Not this". Stamps
 *     `suggestedEvent.dismissedAt`; the strip stops offering it. The
 *     suggestion itself is kept, so the row can still say what was guessed.
 */
export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const { title, description, recordedAt, scratch, unlinkEvent, dismissSuggestedEvent } = body as {
    title?: unknown;
    description?: unknown;
    recordedAt?: unknown;
    scratch?: unknown;
    unlinkEvent?: unknown;
    dismissSuggestedEvent?: unknown;
  };

  // D4 "Not this": the suggestion stays on the row, stamped as refused.
  if (dismissSuggestedEvent === true) {
    const suggested = access.row.gmeet_context?.suggestedEvent;
    if (!suggested) {
      return NextResponse.json({ error: 'No suggested event on this meeting' }, { status: 409 });
    }
    await mergeGmeetContextForUser(access.ownerUserId, id, {
      suggestedEvent: { ...suggested, dismissedAt: new Date().toISOString() },
    });
    void logActivity({
      transcriptId: access.row.id,
      userId: user.userId,
      email: user.email,
      action: 'edit_meta',
      details: { dismissedSuggestedEvent: suggested.title ?? suggested.key },
    });
    const after = await getForUser(access.ownerUserId, id);
    return NextResponse.json({
      transcript: after
        ? { ...withoutSplitSource(after), access: access.access, owner_email: null, owner_name: null }
        : null,
    });
  }

  // D5 "Unlink from event".
  if (unlinkEvent === true) {
    const ctx = access.row.gmeet_context;
    if (!ctx?.eventId && !ctx?.meetingCode && !ctx?.eventTitle) {
      return NextResponse.json(
        { error: 'This meeting is not linked to a calendar event' },
        { status: 409 }
      );
    }
    // Read the attendees BEFORE the keys go — they are how link-born shares
    // are recognised on a row linked before migration 048.
    const attendeeEmails = (ctx.attendees ?? [])
      .map((a) => (typeof a?.email === 'string' ? a.email : ''))
      .filter(Boolean);
    const sharesRemoved = await removeLinkBornShares(
      access.row.id,
      access.ownerUserId,
      attendeeEmails
    ).catch((err) => {
      console.warn('[unlink] share removal failed (continuing):', err);
      return [] as string[];
    });
    await removeGmeetContextKeysForUser(access.ownerUserId, id, EVENT_CONTEXT_KEYS, {
      unlinkedBy: {
        at: new Date().toISOString(),
        userId: user.userId,
        email: user.email,
        eventId: ctx.eventId ?? null,
        eventTitle: ctx.eventTitle ?? null,
        meetingCode: ctx.meetingCode ?? null,
        ...(sharesRemoved.length > 0 ? { sharesRemoved } : {}),
      },
    });
    void logActivity({
      transcriptId: access.row.id,
      userId: user.userId,
      email: user.email,
      action: 'edit_meta',
      details: {
        unlinkedEvent: ctx.eventTitle ?? ctx.eventId ?? true,
        sharesRemoved: sharesRemoved.length,
      },
    });
    const after = await getForUser(access.ownerUserId, id);
    return NextResponse.json({
      transcript: after
        ? { ...withoutSplitSource(after), access: access.access, owner_email: null, owner_name: null }
        : null,
      sharesRemoved,
    });
  }

  if (scratch !== undefined && typeof scratch !== 'boolean') {
    return NextResponse.json({ error: 'scratch must be a boolean' }, { status: 400 });
  }
  if (typeof scratch === 'boolean') {
    await setScratchForUser(access.ownerUserId, id, scratch);
  }

  // Meeting date: ISO string sets it, explicit null clears it.
  if (recordedAt === null) {
    await setRecordedAtForUser(access.ownerUserId, id, null);
  } else if (typeof recordedAt === 'string') {
    const d = new Date(recordedAt);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: 'recordedAt must be an ISO date' }, { status: 400 });
    }
    await setRecordedAtForUser(access.ownerUserId, id, d);
  }

  const updated = await updateMetaForUser(access.ownerUserId, id, {
    title: typeof title === 'string' ? title : undefined,
    description: typeof description === 'string' ? description : undefined,
  });

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'edit_meta',
    details: {
      changedTitle: typeof title === 'string',
      changedDescription: typeof description === 'string',
      ...(typeof scratch === 'boolean' ? { scratch } : {}),
    },
  });

  return NextResponse.json({
    transcript: updated ? { ...withoutSplitSource(updated), access: access.access, owner_email: null, owner_name: null } : null,
  });
});

/**
 * DELETE /api/transcripts/:id
 * Owner-only. Default is a SOFT delete (trash): the row is stamped
 * deleted_at and disappears from listings/search/series/dedupe/background
 * jobs, but the AAI transcript, audio, shares, and notes survive —
 * restorable via POST :id/restore. Permanent delete (row + speaker mappings
 * + shares via FK cascade + AAI transcript + audio files) happens when the
 * row is already in the trash, when it's a placeholder (`up-…`/`defer-…` —
 * nothing worth keeping), or on ?permanent=1.
 *
 * Soft delete leaves the recording graph alone on purpose: a trashed meeting
 * still holds its clip, which is what makes restore work and what stops a
 * recording being reaped while one of its meetings sits in the trash.
 * Permanent delete takes the clips, and any recording that has no clip left
 * goes with them. The FILE walk below is unchanged in Phase 1 — it still
 * reads the row's own `local_audio_path` / `videoParts`.
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can delete' }, { status: 403 });
  }

  const isPlaceholder = access.row.status === 'uploading' || access.row.status === 'waiting';
  const permanent =
    isPlaceholder ||
    !!access.row.deleted_at ||
    new URL(request.url).searchParams.get('permanent') === '1';
  if (!permanent) {
    await softDeleteForUser(access.ownerUserId, id);
    return NextResponse.json({ ok: true, trashed: true });
  }

  // The AssemblyAI JOB, not the meeting: since Phase 1b an upload's meeting
  // id is one we minted and AAI has never heard of it. Nothing to delete for
  // a row that never went there.
  // Phase 3a: a meeting SPLIT OFF another one carries the source's job id (so
  // its own minted uuid is never mistaken for one). That job is not its to
  // delete — the meeting it came from still reads the same transcription.
  const jobId = access.row.gmeet_context?.splitFrom ? null : aaiJobIdOf(access.row);
  if (jobId) await aaiDelete(jobId);
  await deleteSpeakerMappingsForUser(access.ownerUserId, id);
  // Before the row goes: `meeting_clips.transcript_id` has no FK (it is the
  // int family), so an orphan clip would survive the row forever. Same for
  // the annotations parked against this meeting's other transcription
  // versions (Phase 2, migration 046) — a no-op when 046 is not applied.
  await deleteAnnotationsForMeeting(access.row.id).catch((err) =>
    console.warn('[DELETE /api/transcripts] parked annotations cleanup failed:', err)
  );
  const cleanup = await removeRecordingGraphForMeeting(access.row.id, 'permanent-delete');
  await deleteForUser(access.ownerUserId, id);
  // Again, after the row is gone: a fire-and-forget graph sync that was in
  // flight can re-create the clip between the purge above and the delete. A
  // sync that starts from here on finds no row and does nothing, so this
  // second pass is the last word. Idempotent.
  const after = await removeRecordingGraphForMeeting(access.row.id, 'permanent-delete/after');

  // Phase 3a: the bytes are SHARED. A meeting split off this one (or this one
  // split off another) plays the same canonical file under its own
  // `local_audio_path`, so the old "walk the row and unlink" would delete a
  // recording out from under a meeting that is still there — trashed ones
  // included, because restoring must find its audio. The files go only when
  // the RECORDING went with the clips (lib/clips.ts `mayDeleteRecordingFiles`).
  // Design P7: a meeting made FROM a standalone recording (Link / Make a
  // meeting) plays that recording's canonical file under its own
  // `local_audio_path`. The bytes are the recording owner's and go back to
  // their Recordings — never out with the meeting, whatever the graph said
  // (a server with MW_RECORDINGS_WRITE off would otherwise walk the row).
  const mayDeleteFiles =
    !access.row.gmeet_context?.fromRecording &&
    mayDeleteRecordingFiles({
      graphApplied: cleanup.applied && after.applied,
      recordingsKept: [...cleanup.recordingsKept, ...after.recordingsKept],
    });
  if (mayDeleteFiles) {
    // Each stored recording may have an audio-only derivative (offline pins);
    // drop it with the source so nothing outlives the row.
    if (access.row.local_audio_path) {
      await deleteAudioFile(access.row.local_audio_path);
      await dropAudioOnly(access.row.local_audio_path);
    }
    // Extra recording segments (multi-video meetings) live in sidecar files.
    for (const part of access.row.gmeet_context?.videoParts ?? []) {
      if (part.filename) {
        await deleteAudioFile(part.filename);
        await dropAudioOnly(part.filename);
      }
    }
  } else {
    console.log(
      `[DELETE /api/transcripts] ${id}: files kept — another meeting still clips ` +
        `${[...new Set([...cleanup.recordingsKept, ...after.recordingsKept])].join(', ')}`
    );
  }

  return NextResponse.json({ ok: true, filesRemoved: mayDeleteFiles });
});
