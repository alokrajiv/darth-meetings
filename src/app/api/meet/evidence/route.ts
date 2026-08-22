import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { getMeetingCacheByMeetings } from '@/db-ops/gmeet-meeting-cache';
import { getCalendarAttachmentsFor } from '@/db-ops/calendar-event-cache';
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
  // Without a start there is no way to pick THE occurrence's row — let the
  // service key by code alone rather than borrowing another occurrence's.
  const [existing] = startTime
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
    existing: existing ?? undefined,
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

  const out: EvidenceResponse = {
    recordName: probe.recordName,
    confStart: probe.row?.conf_start ?? null,
    confEnd: probe.row?.conf_end ?? null,
    recording: probe.recording,
    transcript: probe.transcript,
    verdict: probe.verdict,
    attachments,
    checkFailed: probe.checkFailed,
    video,
    meta: cachedMetaOf(probe.row),
    checkedAt: new Date().toISOString(),
  };
  return NextResponse.json(out);
});
