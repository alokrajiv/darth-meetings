import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { getMeetingCacheByMeetings } from '@/db-ops/gmeet-meeting-cache';
import {
  getCalendarAttachmentsFor,
  callerInvolvedInOccurrence,
} from '@/db-ops/calendar-event-cache';
import { getDriveFileMeta } from '@/lib/server/gmeet';
import { classifyCalendarAttachments } from '@/lib/meeting-evidence';
import { cachedMetaOf, probeMeetingEvidence } from '@/lib/server/meeting-discovery';
import type { EvidenceRequest, EvidenceResponse } from '@/lib/meeting-discovery-types';

export const runtime = 'nodejs';

const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * POST /api/meet/evidence — "what does Google hold for THIS occurrence?"
 *
 * The dialog's pick/enrich/"Check again" and the listing's "Check…" on a
 * No-recording row. One probe through the discovery service: record lookup
 * (the ONE ±6/+12h window), artifact inventory, calendar attachments folded
 * in, classified by the shared rules, written back to the artifact cache —
 * plus Drive metadata for the first recording file so the options step can
 * show name/size/duration. Caller's own server-minted token.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as EvidenceRequest | null;
  const meetingCode = typeof body?.meetingCode === 'string' ? body.meetingCode.trim().toLowerCase() : '';
  if (!MEET_CODE_RE.test(meetingCode)) {
    return NextResponse.json({ error: 'meetingCode (abc-defg-hij) is required' }, { status: 400 });
  }
  const startTime =
    typeof body?.startTime === 'string' && !Number.isNaN(Date.parse(body.startTime))
      ? body.startTime
      : null;
  const recordName =
    typeof body?.recordName === 'string' && /^conferenceRecords\/[A-Za-z0-9_-]+$/.test(body.recordName)
      ? body.recordName
      : null;

  const minted = await getServerAccessToken(user.userId);
  if (!minted) {
    const account = await getGoogleAccount(user.userId);
    return NextResponse.json(
      { connected: !!account, status: account?.status ?? null, error: 'Google account not connected' },
      { status: 404 }
    );
  }

  // Attachments: what the client saw on the event, else what the poller
  // cached from the caller's own calendar row (the listing's "Check…" has
  // no live event in hand; a Gemini-notes-only meeting is invisible to the
  // Meet API — its ONLY evidence is the attached Doc, D1).
  let attachments = classifyCalendarAttachments(
    Array.isArray(body?.attachments) ? body!.attachments : null
  );
  if (!attachments.videoFileId && !attachments.transcriptDocId) {
    const cached = await getCalendarAttachmentsFor(user.userId, {
      eventId: typeof body?.event?.id === 'string' ? body.event.id : null,
      meetingCode,
      startTime,
    }).catch(() => null);
    if (cached) attachments = cached;
  }
  // PRIVACY GATE (2026-08-24): the global cache row (another user's probe)
  // folds into the verdict AND the response meta — only feed it in when the
  // caller is involved in the occurrence. An uninvolved caller still gets a
  // pure own-token probe (Google's ACLs gate that), just never our cache.
  const involvedOk = await callerInvolvedInOccurrence(user, meetingCode, startTime).catch(
    () => false
  );
  // Without a start there is no way to pick THE occurrence's row — let the
  // service key by code alone rather than borrowing another occurrence's.
  const [existing] =
    involvedOk && startTime
      ? await getMeetingCacheByMeetings([{ code: meetingCode, startTime }]).catch(() => [null])
      : [null];
  const probe = await probeMeetingEvidence(minted.token, {
    userId: user.userId,
    meetingCode,
    eventStart: startTime,
    recordName,
    attachments,
    event: {
      recurringEventId: body?.event?.recurringEventId ?? null,
      iCalUID: body?.event?.iCalUID ?? null,
      organizerEmail: body?.event?.organizerEmail ?? null,
    },
    // Explicit null when uninvolved — undefined would make the service look
    // the cache row up itself, re-opening the leak this gate closes.
    existing: existing ?? null,
  });

  // Drive metadata for the first recording file — best-effort (the caller
  // may not see the file even though the record lists it).
  let video: EvidenceResponse['video'] = null;
  const fileId = probe.recording.fileIds[0] ?? null;
  if (fileId) {
    if (probe.row?.video_file_id === fileId && probe.row.video_size != null) {
      video = {
        fileId,
        name: 'Recording',
        size: probe.row.video_size,
        durationMs: probe.row.video_duration_ms,
      };
    }
    try {
      const meta = await getDriveFileMeta(minted.token, fileId);
      video = { fileId, name: meta.name, size: meta.size, durationMs: meta.durationMs };
    } catch {
      // keep the cached numbers (or null)
    }
  }

  // Row-derived fields only when involved, or when the caller's own token
  // resolved the record (Google itself vouching they were a participant) —
  // the write-back row can carry other users' cached captures either way.
  const rowOk = involvedOk || probe.recordName != null;
  const out: EvidenceResponse = {
    recordName: probe.recordName,
    confStart: rowOk ? (probe.row?.conf_start ?? null) : null,
    confEnd: rowOk ? (probe.row?.conf_end ?? null) : null,
    recording: probe.recording,
    transcript: probe.transcript,
    verdict: probe.verdict,
    attachments,
    checkFailed: probe.checkFailed,
    video,
    meta: rowOk ? cachedMetaOf(probe.row) : null,
    checkedAt: new Date().toISOString(),
  };
  return NextResponse.json(out);
});
