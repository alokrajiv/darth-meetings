import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  createImportedForUser,
  findVisibleByAssemblyaiId,
  findVisibleByDriveFileId,
} from '@/db-ops/transcripts';
import { addShare } from '@/db-ops/transcript-shares';
import {
  autoNameSpeakers,
  registerPeopleFromMeeting,
} from '@/lib/server/import-helpers';
import {
  GoogleApiError,
  captureMeetActuals,
  downloadDriveFileToTemp,
  exportTranscriptText,
  findConferenceRecordName,
  getDriveFileMeta,
  parseMeetTranscriptDoc,
  synthesizeTranscriptResponse,
  utterancesFromEntries,
  type ParsedMeetTranscript,
} from '@/lib/server/gmeet';
import { deleteAudioFile } from '@/lib/server/audio-storage';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import type { GmeetAttendee, GmeetContext, MeetActuals } from '@/lib/format';

export const runtime = 'nodejs';
// Pulling a multi-GB recording from Drive and re-uploading it to AssemblyAI
// takes a while (only enforced on serverless hosts; the VM ignores it).
export const maxDuration = 900;

interface ImportBody {
  accessToken: string;
  mode: 'video' | 'transcript' | 'both';
  videoFileId?: string;
  transcriptDocId?: string;
  languageCode?: string;
  force?: boolean;
  /** Meet API conference record resource name, when the client already found
   * it (orphan-link / recent-meets flows). Saves a lookup. */
  conferenceRecordName?: string;
  event?: {
    id?: string;
    title?: string;
    startTime?: string;
    endTime?: string;
    meetingCode?: string;
    attendees?: GmeetAttendee[];
  };
}

// Invitees on these domains get the imported transcript shared to them
// automatically ("throw them in"): everyone on the invite could have fetched
// the artifacts from Drive themselves, so gating access behind manual
// sharing only invites duplicate imports.
const AUTO_SHARE_DOMAINS = new Set(['trames.sg', 'trames-engineering.com']);

async function autoShareToInternalInvitees(
  transcriptId: number,
  ownerUserId: string,
  ownerEmail: string,
  candidates: Array<{ email: string; name?: string | null }>
): Promise<number> {
  const self = ownerEmail.trim().toLowerCase();
  let shared = 0;
  for (const a of candidates) {
    const email = a.email.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (email === self || !AUTO_SHARE_DOMAINS.has(domain)) continue;
    try {
      await addShare({
        transcriptId,
        ownerUserId,
        sharedByUserId: ownerUserId,
        sharedWithEmail: email,
        sharedWithName: a.name ?? null,
        sharedWithPplId: null,
        access: 'edit',
      });
      shared++;
    } catch (err) {
      console.warn('[gmeet/import] auto-share failed for', email, err);
    }
  }
  return shared;
}

function googleErrorResponse(err: GoogleApiError): NextResponse {
  if (err.status === 401) {
    return NextResponse.json(
      { error: 'Google session expired — reconnect Google and try again.' },
      { status: 401 }
    );
  }
  if (err.status === 403) {
    return NextResponse.json(
      {
        error:
          'Google denied access to this file. Either you only have viewer access with downloads disabled, or the file was not shared with you — ask the meeting organizer for access.',
      },
      { status: 403 }
    );
  }
  if (err.status === 404) {
    return NextResponse.json(
      { error: 'File not found on Drive — it may have been moved or deleted.' },
      { status: 404 }
    );
  }
  return NextResponse.json(
    { error: 'Google API error', detail: err.message },
    { status: 502 }
  );
}

/**
 * POST /api/gmeet/import
 *
 * Import a Google Meet meeting picked from the user's calendar.
 *
 * Modes:
 *  - 'transcript': quick import — export + parse the Meet transcript Doc,
 *    store it as a completed imported row (real speaker names, no AAI cost,
 *    no audio). Synthetic id `gmeet-<docId>`.
 *  - 'video': download the recording from Drive and run it through the
 *    normal AAI pipeline (acoustic diarization — the fix for pooled-room
 *    meetings). Attendee names are added as recognition keyterms.
 *  - 'both': video mode, plus the parsed Meet transcript stored as a sidecar
 *    in gmeet_context.meetTranscript for cross-referencing.
 *
 * The Google access token arrives per-request from the browser and is used
 * in memory only. Dedupe: if a visible row already covers this recording's
 * Drive file, respond 409 with the existing row unless `force` is set.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: ImportBody;
  try {
    body = (await request.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { accessToken, mode, videoFileId, transcriptDocId, languageCode, force } = body;
  const event = body.event ?? {};
  // Garbage dates would blow up Date arithmetic / SQL later — drop them.
  if (event.startTime && Number.isNaN(Date.parse(event.startTime))) event.startTime = undefined;
  if (event.endTime && Number.isNaN(Date.parse(event.endTime))) event.endTime = undefined;
  if (typeof accessToken !== 'string' || accessToken.length < 20) {
    return NextResponse.json({ error: 'accessToken is required' }, { status: 400 });
  }
  if (mode !== 'video' && mode !== 'transcript' && mode !== 'both') {
    return NextResponse.json({ error: "mode must be 'video' | 'transcript' | 'both'" }, { status: 400 });
  }
  if ((mode === 'video' || mode === 'both') && !videoFileId) {
    return NextResponse.json({ error: 'videoFileId is required for this mode' }, { status: 400 });
  }
  // Transcript mode doesn't strictly need a Doc id up front — given a
  // conference record (or a meeting code to find one), the actuals capture
  // below discovers the transcript itself. This is what lets bulk import
  // fire without the client pre-resolving every row.
  if (
    (mode === 'transcript' || mode === 'both') &&
    !transcriptDocId &&
    !body.conferenceRecordName &&
    !event.meetingCode
  ) {
    return NextResponse.json(
      { error: 'transcriptDocId or a conference reference is required for this mode' },
      { status: 400 }
    );
  }
  const attendees: GmeetAttendee[] = Array.isArray(event.attendees)
    ? event.attendees
        .filter((a) => a && typeof a.email === 'string')
        .map((a) => ({ email: a.email, name: a.name, responseStatus: a.responseStatus }))
    : [];

  // ---- Meet API actuals: participants (emails via People API), recording
  // segment times, structured transcript entries. Best-effort — captured NOW
  // because entries expire 30 days after the meeting. -----------------------
  let actuals: MeetActuals | null = null;
  try {
    if (body.conferenceRecordName) {
      actuals = await captureMeetActuals(accessToken, body.conferenceRecordName);
      // Cross-check the CLIENT-supplied record against the event's own time
      // window. Without this, a stale/buggy/malicious client can attach one
      // meeting's content and participants to another meeting's title and
      // invitees — the wrong-share incident, resurrected.
      if (
        actuals?.conferenceStart &&
        event.startTime &&
        Math.abs(
          new Date(actuals.conferenceStart).getTime() - new Date(event.startTime).getTime()
        ) >
          12 * 3600_000
      ) {
        console.warn(
          '[gmeet/import] rejecting conferenceRecordName outside the event time window'
        );
        actuals = null;
      }
    }
    if (!actuals && event.meetingCode) {
      const found = await findConferenceRecordName(
        accessToken,
        event.meetingCode,
        event.startTime
      );
      if (found) actuals = await captureMeetActuals(accessToken, found);
    }
  } catch (err) {
    console.warn('[gmeet/import] actuals capture failed (continuing):', err);
  }

  // The Doc id the client sent, else whatever the actuals capture found.
  const effectiveDocId = transcriptDocId ?? actuals?.transcriptDocIds?.[0] ?? null;

  const baseContext: GmeetContext = {
    eventId: event.id,
    eventTitle: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    meetingCode: event.meetingCode,
    attendees,
    videoFileId: videoFileId ?? undefined,
    transcriptDocId: effectiveDocId ?? undefined,
    actuals,
  };

  // Orphan imports (pasted link / recents) have no calendar event — fall
  // back to a code+date title so the row isn't "Untitled transcript".
  const title =
    event.title ??
    (actuals?.conferenceStart
      ? `Meet ${event.meetingCode ?? ''} — ${actuals.conferenceStart.slice(0, 10)}`.replace('  ', ' ')
      : null);

  // Share to everyone who was invited OR actually joined (internal domains
  // only). Participants matter for orphan imports where there's no invite
  // list at all.
  const shareCandidates = new Map<string, { email: string; name?: string | null }>();
  for (const a of attendees) {
    shareCandidates.set(a.email.trim().toLowerCase(), { email: a.email, name: a.name });
  }
  for (const p of actuals?.participants ?? []) {
    const email = p.email?.trim().toLowerCase();
    if (email && !shareCandidates.has(email)) {
      shareCandidates.set(email, { email, name: p.displayName });
    }
  }
  const shareList = [...shareCandidates.values()];

  // ---- Meet transcript content when the mode wants it ---------------------
  // Preferred source: structured API entries (precise per-utterance times).
  // Fallback: export + parse the transcript Doc (5-minute block timing) —
  // the only option for meetings older than the API's 30-day entry window.
  let parsed: ParsedMeetTranscript | null = null;
  if (mode === 'transcript' || mode === 'both') {
    if (actuals?.transcriptEntries && actuals.transcriptEntries.length > 0) {
      parsed = {
        attendees: (actuals.participants ?? []).map((p) => p.displayName),
        utterances: utterancesFromEntries(actuals.transcriptEntries),
      };
    } else if (!effectiveDocId) {
      if (mode === 'transcript') {
        return NextResponse.json(
          {
            error:
              'No Meet transcript found for this meeting — it may not have had transcription/Gemini notes on, or the artifacts are older than the Meet API keeps them.',
          },
          { status: 422 }
        );
      }
    } else {
      try {
        const docText = await exportTranscriptText(accessToken, effectiveDocId);
        parsed = parseMeetTranscriptDoc(docText);
      } catch (err) {
        if (err instanceof GoogleApiError) {
          // In 'both' mode the transcript is a bonus — don't fail the video
          // import over it.
          if (mode === 'both') {
            console.warn('[gmeet/import] transcript doc fetch failed (continuing):', err.message);
          } else {
            return googleErrorResponse(err);
          }
        } else {
          throw err;
        }
      }
    }
    if (mode === 'transcript' && (!parsed || parsed.utterances.length === 0)) {
      return NextResponse.json(
        {
          error:
            'Could not parse any utterances out of the transcript Doc. It may be empty or in an unexpected format — try re-transcribing the video instead.',
        },
        { status: 422 }
      );
    }
  }

  // ---- Quick import: Meet transcript only, no AAI --------------------------
  if (mode === 'transcript') {
    // Stable per-meeting id. Prefer the CONFERENCE RECORD id: every import
    // path resolves the same record for the same meeting, whereas doc ids
    // diverge (classic transcript doc vs Gemini-notes doc vs API pick) and
    // would split dedupe into duplicate cross-shared rows.
    const recordId = actuals?.conferenceRecordName?.split('/').pop() ?? null;
    const idBase = recordId ?? effectiveDocId;
    if (!idBase) {
      return NextResponse.json(
        { error: 'Could not identify this meeting (no conference record or transcript doc).' },
        { status: 422 }
      );
    }
    const syntheticId = `gmeet-${idBase}`;

    // Same-Doc dedupe: the synthetic id is identical for every importer, so
    // anyone on the invite (auto-shared below) gets pointed at the existing
    // row instead of minting a duplicate.
    const dupe = await findVisibleByAssemblyaiId(user.userId, user.email, syntheticId);
    if (dupe && !force) {
      return NextResponse.json(
        {
          error: 'This meeting was already imported.',
          existing: {
            assemblyai_id: dupe.assemblyai_id,
            title: dupe.title,
            created_at: dupe.created_at,
            own: dupe.user_id === user.userId,
          },
        },
        { status: 409 }
      );
    }

    const startIso = event.startTime ?? actuals?.conferenceStart;
    const endIso = event.endTime ?? actuals?.conferenceEnd;
    const content = synthesizeTranscriptResponse(syntheticId, parsed!, {
      createdIso: startIso,
      completedIso: endIso,
    });
    const speakerCount = new Set(parsed!.utterances.map((u) => u.speaker)).size;

    const row = await createImportedForUser(user.userId, {
      assemblyaiId: syntheticId,
      originalFilename: null,
      status: 'completed',
      createdAt: startIso ? new Date(startIso) : null,
      completedAt: endIso ? new Date(endIso) : null,
      duration: content.audio_duration ?? null,
      speakerCount,
      languageCode: null,
      audioUrl: null,
      importedContent: content,
      title,
      gmeetContext: { ...baseContext, meetTranscript: parsed },
    });

    // Real names from Meet → name the speakers + register people up front.
    try {
      const speakerNames = [...new Set(parsed!.utterances.map((u) => u.speaker))];
      await autoNameSpeakers(
        user.userId,
        syntheticId,
        speakerNames,
        attendees,
        actuals?.participants
      );
    } catch (err) {
      console.warn('[gmeet/import] speaker auto-naming failed (continuing):', err);
    }

    // Post-completion hook (voiceprint matching is skipped automatically —
    // there's no audio on this row; notes are user-triggered now).
    onTranscriptCompleted(user.userId, syntheticId);

    const autoShared = await autoShareToInternalInvitees(
      row.id,
      user.userId,
      user.email,
      shareList
    );
    await registerPeopleFromMeeting(shareList, user.userId);

    return NextResponse.json({ transcript: row, mode, autoShared }, { status: 201 });
  }

  // ---- Video path: dedupe, capability check, download, AAI pipeline --------
  const existing = await findVisibleByDriveFileId(user.userId, user.email, videoFileId!);
  if (existing && !force) {
    return NextResponse.json(
      {
        error: 'This recording was already imported.',
        existing: {
          assemblyai_id: existing.assemblyai_id,
          title: existing.title,
          created_at: existing.created_at,
          own: existing.user_id === user.userId,
        },
      },
      { status: 409 }
    );
  }

  let meta;
  try {
    meta = await getDriveFileMeta(accessToken, videoFileId!);
  } catch (err) {
    if (err instanceof GoogleApiError) return googleErrorResponse(err);
    throw err;
  }
  if (!meta.canDownload) {
    return NextResponse.json(
      {
        error:
          'The owner has disabled downloads for viewers on this recording. Ask them for edit access or to lift the restriction (Share → gear icon).',
      },
      { status: 403 }
    );
  }

  let tempFilename: string;
  try {
    const dl = await downloadDriveFileToTemp(accessToken, videoFileId!);
    tempFilename = dl.tempFilename;
    if (dl.bytes === 0) {
      await deleteAudioFile(tempFilename);
      return NextResponse.json({ error: 'Drive returned an empty file' }, { status: 502 });
    }
  } catch (err) {
    if (err instanceof GoogleApiError) return googleErrorResponse(err);
    console.error('[gmeet/import] download failed:', err);
    return NextResponse.json(
      { error: 'Download from Drive failed', detail: String(err) },
      { status: 502 }
    );
  }

  // Names of the people who were invited or actually joined bias AAI's
  // recognition — exactly what it mis-hears otherwise.
  const keytermNames = new Set<string>();
  for (const a of attendees) {
    if (a.name && a.name.trim().length > 1) keytermNames.add(a.name.trim());
  }
  for (const p of actuals?.participants ?? []) {
    if (p.displayName && p.displayName !== 'Unknown') keytermNames.add(p.displayName);
  }

  try {
    const row = await ingestLocalAudio(user.userId, tempFilename, {
      originalFilename: meta.name,
      languageCode,
      title,
      extraKeyterms: [...keytermNames],
      driveFileId: videoFileId,
      gmeetContext: { ...baseContext, meetTranscript: parsed },
    });
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
      console.error(`[gmeet/import] ${error.stage} failed:`, error.causeErr);
      return NextResponse.json(
        { error: error.message, detail: String(error.causeErr) },
        { status: 502 }
      );
    }
    throw error;
  }
});
