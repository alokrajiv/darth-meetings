import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { findVisibleByAssemblyaiId, setRecordedAtForUser } from '@/db-ops/transcripts';
import { findImportedByTeamsCallId } from '@/db-ops/teams-import';
import { parseTeamsJoinLink, isOwnTenant, pickOccurrenceArtifacts } from '@/lib/teams-link';
import {
  GraphApiError,
  fetchTranscriptVtt,
  getRecordingStream,
  isGraphConfigured,
  listRecordings,
  listTranscripts,
  resolveMeetingByJoinUrl,
} from '@/lib/server/ms-graph';
import { parseTeamsVtt } from '@/lib/server/teams-vtt';
import { teamsSourceId } from '@/lib/server/teams-ids';
import { ingestParsedUtterances } from '@/lib/server/ingest-parsed';
import { saveAudioStreamToTemp, deleteAudioFile } from '@/lib/server/audio-storage';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { autoShareToInternalInvitees } from '@/lib/server/auto-share';
import { registerPeopleFromMeeting } from '@/lib/server/import-helpers';
import type { GmeetAttendee, GmeetContext } from '@/lib/format';
import type { ParsedMeetTranscript } from '@/lib/server/gmeet';

export const runtime = 'nodejs';
// Teams MP4s are hundreds of MB — pulling from Graph and re-uploading to
// AssemblyAI takes a while (only enforced on serverless hosts).
export const maxDuration = 900;

interface TeamsImportBody {
  /** Teams meetup-join link from the calendar event — raw is fine,
   * canonicalization happens here. */
  url?: string;
  mode: 'video' | 'transcript' | 'both';
  languageCode?: string;
  force?: boolean;
  event?: {
    id?: string;
    title?: string;
    startTime?: string;
    endTime?: string;
    recurringEventId?: string;
    iCalUID?: string;
    organizerEmail?: string;
    attendees?: GmeetAttendee[];
  };
}

/** Spec §4.6 failure taxonomy → HTTP responses the dialog can render. */
function graphErrorResponse(err: GraphApiError): NextResponse {
  if (err.code === 'GraphAccessToTranscriptsDisabled') {
    return NextResponse.json(
      {
        error:
          'Microsoft tenant configuration regressed: Graph transcript access is switched off. An admin needs to re-run Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true.',
      },
      { status: 503 }
    );
  }
  if (err.status === 403) {
    return NextResponse.json(
      {
        error:
          'Microsoft Graph denied access — the application access policy may not cover this organizer. This is a configuration problem, not something you did.',
      },
      { status: 502 }
    );
  }
  if (err.status === 404) {
    return NextResponse.json(
      { error: 'The meeting artifacts are no longer available on Microsoft 365.' },
      { status: 404 }
    );
  }
  return NextResponse.json(
    { error: 'Microsoft Graph error', detail: err.message },
    { status: 502 }
  );
}

/**
 * POST /api/teams/import
 *
 * Import a Microsoft Teams meeting picked from the user's Google calendar.
 * Artifacts come app-only from Graph under the organizer's AAD id (embedded
 * in the join link) — the user needs no Microsoft login, and unlike Meet
 * there is no per-user artifact access to verify.
 *
 * Modes mirror /api/gmeet/import:
 *  - 'transcript': fetch + parse the speaker-attributed VTT, store as a
 *    completed imported row. Synthetic id `teams-<meetingHash>-<callId8>`.
 *  - 'video': download the MP4 and run the normal AAI pipeline.
 *  - 'both': video mode plus the parsed VTT as the meetTranscript sidecar
 *    (real names for cross-referencing/speaker-ID, like Meet's both).
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: TeamsImportBody;
  try {
    body = (await request.json()) as TeamsImportBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { mode, languageCode, force } = body;
  const event = body.event ?? {};
  if (event.startTime && Number.isNaN(Date.parse(event.startTime))) event.startTime = undefined;
  if (event.endTime && Number.isNaN(Date.parse(event.endTime))) event.endTime = undefined;

  if (mode !== 'video' && mode !== 'transcript' && mode !== 'both') {
    return NextResponse.json(
      { error: "mode must be 'video' | 'transcript' | 'both'" },
      { status: 400 }
    );
  }
  const info = typeof body.url === 'string' ? parseTeamsJoinLink(body.url) : null;
  if (!info) {
    return NextResponse.json({ error: 'url must be a Teams meeting link' }, { status: 400 });
  }
  if (!isOwnTenant(info)) {
    // The dialog renders this as the guided manual-import panel (spec §10.1).
    return NextResponse.json(
      {
        error:
          'This meeting was organized outside Trames — their tenant owns the recording and transcript, so we cannot pull them automatically. Download the recording (or transcript) from Teams and upload it here instead.',
        external: true,
        tenantId: info.tenantId,
      },
      { status: 422 }
    );
  }
  if (!isGraphConfigured()) {
    return NextResponse.json(
      { error: 'Microsoft Graph is not configured on this server.' },
      { status: 503 }
    );
  }

  const attendees: GmeetAttendee[] = Array.isArray(event.attendees)
    ? event.attendees
        .filter((a) => a && typeof a.email === 'string')
        .map((a) => ({ email: a.email, name: a.name, responseStatus: a.responseStatus }))
    : [];

  // ---- Resolve meeting + pick this occurrence's artifacts -----------------
  let meeting;
  let transcripts;
  let recordings;
  try {
    meeting = await resolveMeetingByJoinUrl(info.organizerOid, info.joinWebUrl);
    if (!meeting) {
      return NextResponse.json(
        { error: 'Microsoft 365 has no record of this meeting — it may have been deleted.' },
        { status: 404 }
      );
    }
    [transcripts, recordings] = await Promise.all([
      listTranscripts(info.organizerOid, meeting.id),
      listRecordings(info.organizerOid, meeting.id),
    ]);
  } catch (err) {
    if (err instanceof GraphApiError) return graphErrorResponse(err);
    throw err;
  }

  // Occurrence pick needs a window; a one-off meeting without calendar times
  // falls back to the artifacts' own era via the meeting's scheduled times.
  const windowStart = event.startTime ?? meeting.startDateTime;
  const windowEnd = event.endTime ?? meeting.endDateTime ?? windowStart;
  const picked =
    windowStart && windowEnd
      ? pickOccurrenceArtifacts(transcripts, recordings, windowStart, windowEnd)
      : {
          transcript: transcripts[transcripts.length - 1],
          recording: recordings[recordings.length - 1],
        };
  const { transcript, recording } = picked;

  if (mode === 'transcript' && !transcript) {
    return NextResponse.json(
      {
        error:
          'No Teams transcript found for this occurrence — transcription may not have been on, or Microsoft is still processing it (artifacts appear a few minutes after the call ends).',
      },
      { status: 422 }
    );
  }
  if ((mode === 'video' || mode === 'both') && !recording) {
    return NextResponse.json(
      {
        error:
          'No Teams recording found for this occurrence — it may not have been recorded, or Microsoft is still processing it (recordings appear a few minutes after the call ends).',
      },
      { status: 422 }
    );
  }

  // The occurrence key: transcript and recording of one occurrence share it.
  const callId = transcript?.callId ?? recording?.callId;
  const sourceId = teamsSourceId(
    meeting.id,
    callId ?? (transcript?.createdDateTime ?? recording?.createdDateTime ?? 'unknown').slice(0, 8)
  );

  // ---- Dedupe (same-id, then cross-user by callId); force bypasses --------
  const dupe = await findVisibleByAssemblyaiId(user.userId, user.email, sourceId);
  if (dupe && !force) {
    return NextResponse.json(
      {
        error: 'This meeting was already imported.',
        existing: {
          assemblyai_id: dupe.assemblyai_id,
          title: dupe.title,
          created_at: dupe.created_at,
          own: dupe.user_id === user.userId,
          accessible: true,
        },
      },
      { status: 409 }
    );
  }
  if (!dupe && !force && callId) {
    try {
      const other = await findImportedByTeamsCallId(callId, {
        userId: user.userId,
        email: user.email,
      });
      if (other) {
        return NextResponse.json(
          {
            error: other.accessible
              ? 'This meeting was already imported.'
              : `This meeting was already imported by ${other.owner_email ?? 'a colleague'} (not shared with you).`,
            existing: {
              assemblyai_id: other.accessible ? other.assemblyai_id : null,
              title: other.accessible ? other.title : null,
              created_at: null,
              own: other.mine,
              ownerEmail: other.owner_email,
              accessible: other.accessible,
            },
          },
          { status: 409 }
        );
      }
    } catch (err) {
      // Dedupe is best-effort — never block an import on a failed check.
      console.warn('[teams/import] cross-user dedupe check failed:', err);
    }
  }

  const context: GmeetContext = {
    provider: 'teams',
    teams: {
      joinWebUrl: info.joinWebUrl,
      tenantId: info.tenantId,
      organizerOid: info.organizerOid,
      graphMeetingId: meeting.id,
      callId,
      transcriptId: transcript?.id,
      recordingId: recording?.id,
    },
    eventId: event.id,
    recurringEventId: event.recurringEventId,
    iCalUID: event.iCalUID,
    organizerEmail: event.organizerEmail,
    eventTitle: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    attendees,
  };
  const title = event.title ?? meeting.subject ?? null;
  const shareList = attendees.map((a) => ({ email: a.email, name: a.name }));

  // ---- Parse the VTT when the mode wants it -------------------------------
  let parsed: ParsedMeetTranscript | null = null;
  if ((mode === 'transcript' || mode === 'both') && transcript) {
    try {
      const vtt = await fetchTranscriptVtt(info.organizerOid, meeting.id, transcript.id);
      parsed = parseTeamsVtt(vtt);
    } catch (err) {
      if (err instanceof GraphApiError) {
        // In 'both' mode the transcript is a bonus — don't fail the video
        // import over it.
        if (mode === 'both') {
          console.warn('[teams/import] transcript fetch failed (continuing):', err.message);
        } else {
          return graphErrorResponse(err);
        }
      } else {
        throw err;
      }
    }
    if (mode === 'transcript' && (!parsed || parsed.utterances.length === 0)) {
      return NextResponse.json(
        { error: 'The Teams transcript is empty — try importing the recording instead.' },
        { status: 422 }
      );
    }
  }

  // ---- Quick import: transcript only, no AAI ------------------------------
  if (mode === 'transcript') {
    // recorded_at from when transcription actually started, fallback event.
    const startIso = transcript!.createdDateTime ?? event.startTime ?? null;
    const endIso = transcript!.endDateTime ?? event.endTime ?? null;
    const { row, autoShared } = await ingestParsedUtterances(
      { userId: user.userId, email: user.email },
      {
        sourceId,
        title,
        parsed: parsed!,
        recordedAtIso: startIso,
        completedAtIso: endIso,
        gmeetContext: { ...context, meetTranscript: parsed },
        attendees,
        shareList,
        logTag: '[teams/import]',
      }
    );
    return NextResponse.json({ transcript: row, mode, autoShared }, { status: 201 });
  }

  // ---- Video path: stream MP4 from Graph, AAI pipeline --------------------
  let tempFilename: string;
  try {
    const res = await getRecordingStream(info.organizerOid, meeting.id, recording!.id);
    if (!res.body) {
      return NextResponse.json({ error: 'Graph returned an empty recording body' }, { status: 502 });
    }
    const dl = await saveAudioStreamToTemp(res.body as ReadableStream<Uint8Array>);
    tempFilename = dl.tempFilename;
    if (dl.bytes === 0) {
      await deleteAudioFile(tempFilename);
      return NextResponse.json({ error: 'Graph returned an empty recording' }, { status: 502 });
    }
  } catch (err) {
    if (err instanceof GraphApiError) return graphErrorResponse(err);
    console.error('[teams/import] recording download failed:', err);
    return NextResponse.json(
      { error: 'Recording download from Microsoft failed', detail: String(err) },
      { status: 502 }
    );
  }

  // Invitee + speaker names bias AAI's recognition, same as the Meet path.
  const keytermNames = new Set<string>();
  for (const a of attendees) {
    if (a.name && a.name.trim().length > 1) keytermNames.add(a.name.trim());
  }
  for (const s of parsed?.attendees ?? []) keytermNames.add(s);

  try {
    const row = await ingestLocalAudio(user.userId, tempFilename, {
      originalFilename: `${title ?? 'teams-meeting'}.mp4`,
      languageCode,
      title,
      extraKeyterms: [...keytermNames],
      gmeetContext: { ...context, meetTranscript: parsed },
    });
    const meetingStart = recording!.createdDateTime ?? event.startTime;
    if (meetingStart && !Number.isNaN(Date.parse(meetingStart))) {
      await setRecordedAtForUser(user.userId, row.assemblyai_id, new Date(meetingStart)).catch(
        () => {}
      );
    }
    const autoShared = await autoShareToInternalInvitees(
      row.id,
      user.userId,
      user.email,
      shareList
    );
    await registerPeopleFromMeeting(shareList, user.userId);
    return NextResponse.json({ transcript: row, mode, autoShared }, { status: 201 });
  } catch (error) {
    if (error instanceof IngestError) {
      console.error(`[teams/import] ${error.stage} failed:`, error.causeErr);
      return NextResponse.json(
        { error: 'Transcription pipeline failed', detail: error.message },
        { status: 502 }
      );
    }
    throw error;
  }
});
