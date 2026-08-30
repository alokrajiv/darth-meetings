import 'server-only';
import { repointMeeting } from '@/db-ops/meetings';
import { randomUUID } from 'node:crypto';
import {
  createDeferredPlaceholder,
  deleteForUser,
  findVisibleByAssemblyaiId,
  findWaitingTeamsDeferred,
  mergeGmeetContextForUser,
  setRecordedAtForUser,
} from '@/db-ops/transcripts';
import { findImportedByTeamsCallId } from '@/db-ops/teams-import';
import { parseTeamsJoinLink, isOwnTenant, pickOccurrenceArtifacts } from '@/lib/teams-link';
import { teamsDeferredTerminalError } from '@/lib/teams-deferred-terminal';
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
import { teamsSourceId, teamsCacheCode } from '@/lib/server/teams-ids';
import { callerInvolvedInOccurrence } from '@/db-ops/calendar-event-cache';
import { ingestParsedUtterances } from '@/lib/server/ingest-parsed';
import { saveAudioStreamToTemp, deleteAudioFile } from '@/lib/server/audio-storage';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { autoShareToInternalInvitees } from '@/lib/server/auto-share';
import { registerPeopleFromMeeting } from '@/lib/server/import-helpers';
import type { ImportOutcome, ImportUser } from '@/lib/server/gmeet-import-core';
import type { GmeetAttendee, GmeetContext } from '@/lib/format';
import type { ParsedMeetTranscript } from '@/lib/server/gmeet';

/**
 * The Microsoft Teams import, extracted from the /api/teams/import route so
 * the deferred-import poller can replay a queued import server-side (Graph is
 * app-only — unlike Meet, no user token is needed at all). The route stays a
 * thin auth + JSON wrapper; outcomes are `{ status, body }` pairs.
 */

export interface TeamsImportBody {
  /** Teams meetup-join link from the calendar event — raw is fine,
   * canonicalization happens here. */
  url?: string;
  mode: 'video' | 'transcript' | 'both';
  languageCode?: string;
  force?: boolean;
  /** Client opt-in: when Microsoft hasn't produced the mode's needed
   * artifact yet (recordings/transcripts appear minutes after the call
   * ends), queue the import (202 + a `defer-…` placeholder row) instead of
   * failing — the deferred-import poller runs it once the artifact lands. */
  defer?: boolean;
  /** Client opt-in: even when the recording IS ready, don't stream it from
   * Graph inline — queue the same `defer-…` placeholder and let the poller
   * run the heavy download/AAI submit (app-only, no user token needed). The
   * request returns in seconds and closing the tab no longer kills the
   * import. Only affects video/'both' modes; transcript stays inline. */
  background?: boolean;
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
  /** Extra gmeet_context to stamp on the created row (series auto-import
   * marker + report pref). Also lands on defer placeholders and survives
   * promotion via the frozen request. */
  contextExtra?: {
    autoImport?: GmeetContext['autoImport'];
    uploadPrefs?: GmeetContext['uploadPrefs'];
  };
}

export interface TeamsExecuteOptions {
  /** Set by the deferred-import poller: the `defer-…` placeholder row being
   * fulfilled. Video modes promote it in place (shares survive); transcript
   * mode deletes it once the real `teams-…` row exists. */
  placeholderAssemblyaiId?: string;
}

const out = (status: number, body: Record<string, unknown>): ImportOutcome => ({ status, body });

/** Spec §4.6 failure taxonomy → outcomes the dialog can render. */
function graphErrorOutcome(err: GraphApiError): ImportOutcome {
  if (err.code === 'GraphAccessToTranscriptsDisabled') {
    return out(503, {
      error:
        'Microsoft tenant configuration regressed: Graph transcript access is switched off. An admin needs to re-run Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true.',
    });
  }
  if (err.status === 403) {
    return out(502, {
      error:
        'Microsoft Graph denied access — the application access policy may not cover this organizer. This is a configuration problem, not something you did.',
    });
  }
  if (err.status === 404) {
    return out(404, { error: 'The meeting artifacts are no longer available on Microsoft 365.' });
  }
  return out(502, { error: 'Microsoft Graph error', detail: err.message });
}

export async function executeTeamsImport(
  user: ImportUser,
  body: TeamsImportBody,
  opts?: TeamsExecuteOptions
): Promise<ImportOutcome> {
  const { mode, languageCode, force } = body;
  const event = body.event ?? {};
  if (event.startTime && Number.isNaN(Date.parse(event.startTime))) event.startTime = undefined;
  if (event.endTime && Number.isNaN(Date.parse(event.endTime))) event.endTime = undefined;

  if (mode !== 'video' && mode !== 'transcript' && mode !== 'both') {
    return out(400, { error: "mode must be 'video' | 'transcript' | 'both'" });
  }
  const info = typeof body.url === 'string' ? parseTeamsJoinLink(body.url) : null;
  if (!info) {
    return out(400, { error: 'url must be a Teams meeting link' });
  }
  if (!isOwnTenant(info)) {
    // The dialog renders this as the guided manual-import panel (spec §10.1).
    return out(422, {
      error:
        'This meeting was organized outside Trames — their tenant owns the recording and transcript, so we cannot pull them automatically. Download the recording (or transcript) from Teams and upload it here instead.',
      external: true,
      tenantId: info.tenantId,
    });
  }
  if (!isGraphConfigured()) {
    return out(503, { error: 'Microsoft Graph is not configured on this server.' });
  }

  // PRIVACY GATE (2026-08-24): artifacts come app-only (tenant-wide) from
  // Graph — nothing downstream verifies per-user access, so the involvement
  // check happens HERE or never. Without it any authenticated user with a
  // join URL pulls the full transcript/recording of any own-tenant meeting.
  // Calendar evidence only — body.event is client-supplied and untrusted.
  const cacheCode = teamsCacheCode(info.joinWebUrl);
  const involved = await callerInvolvedInOccurrence(user, cacheCode, event.startTime ?? null);
  if (!involved) {
    return out(403, {
      error:
        "This meeting isn't on your calendar. Imports are limited to meetings you organize or are invited to — if you were invited, Sync your calendar and try again.",
    });
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
      return out(404, {
        error: 'Microsoft 365 has no record of this meeting — it may have been deleted.',
      });
    }
    [transcripts, recordings] = await Promise.all([
      listTranscripts(info.organizerOid, meeting.id),
      listRecordings(info.organizerOid, meeting.id),
    ]);
  } catch (err) {
    if (err instanceof GraphApiError) return graphErrorOutcome(err);
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

  // ---- Needed artifact missing: queue (defer) or fail --------------------
  // 'transcript' needs the transcript, 'video'/'both' the recording ('both'
  // treats a missing transcript as a bonus that didn't materialize — Teams
  // transcripts land before recordings, so waiting on the recording is the
  // stricter gate anyway).
  const missing: 'transcript' | 'recording' | null =
    mode === 'transcript' && !transcript
      ? 'transcript'
      : (mode === 'video' || mode === 'both') && !recording
        ? 'recording'
        : null;
  if (missing) {
    // Nothing listed for an occurrence that ended >24h ago = the call was
    // not recorded — never queue a deferred import for it (the poller would
    // only heartbeat for a day and give up), and tell the deferred poller
    // the same via `neverRecorded` so an already-queued row goes terminal.
    const neverRecorded = teamsDeferredTerminalError({
      startTime: windowStart ?? null,
      endTime: windowEnd ?? null,
      transcriptListed: !!transcript,
      recordingListed: !!recording,
    });
    if (neverRecorded) {
      return out(422, {
        error: neverRecorded,
        notReady: missing,
        neverRecorded: true,
        listed: { transcript: !!transcript, recording: !!recording },
      });
    }
    if (body.defer && !opts?.placeholderAssemblyaiId) {
      const waitingFor: 'transcript' | 'video' | 'both' =
        mode === 'both' ? 'both' : mode === 'video' ? 'video' : 'transcript';
      // Second click on an occurrence that's already queued → hand back the
      // existing placeholder instead of minting a twin.
      const already = await findWaitingTeamsDeferred(
        user.userId,
        info.joinWebUrl,
        event.startTime ?? null
      );
      if (already) {
        return out(202, { deferred: true, waitingFor, transcript: already, mode, autoShared: 0 });
      }
      const placeholderId = `defer-${randomUUID()}`;
      const placeholder = await createDeferredPlaceholder(user.userId, {
        placeholderId,
        title: event.title ?? meeting.subject ?? null,
        recordedAt: event.startTime ?? meeting.startDateTime ?? null,
        gmeetContext: {
          provider: 'teams',
          teams: {
            joinWebUrl: info.joinWebUrl,
            tenantId: info.tenantId,
            organizerOid: info.organizerOid,
            graphMeetingId: meeting.id,
          },
          eventId: event.id,
          recurringEventId: event.recurringEventId,
          iCalUID: event.iCalUID,
          organizerEmail: event.organizerEmail,
          eventTitle: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
          attendees,
          ...(body.contextExtra ?? {}),
          deferredImport: {
            mode,
            ownerEmail: user.email,
            request: {
              url: info.joinWebUrl,
              languageCode,
              force,
              event,
              contextExtra: body.contextExtra,
            },
            since: new Date().toISOString(),
            status: 'waiting',
          },
        },
      });
      // Same visibility rule as live uploads: invitees see the queued row
      // immediately, not only once the import lands.
      const shareList = attendees.map((a) => ({ email: a.email, name: a.name }));
      const autoShared = await autoShareToInternalInvitees(
        placeholder.id,
        user.userId,
        user.email,
        shareList
      );
      await registerPeopleFromMeeting(shareList, user.userId);
      console.log(
        `[teams/import] deferred ${mode} import queued as ${placeholderId} (waiting for ${waitingFor})`
      );
      return out(202, { deferred: true, waitingFor, transcript: placeholder, mode, autoShared });
    }
    return out(422, {
      error:
        missing === 'transcript'
          ? 'No Teams transcript found for this occurrence — transcription may not have been on, or Microsoft is still processing it (artifacts appear a few minutes after the call ends).'
          : 'No Teams recording found for this occurrence — it may not have been recorded, or Microsoft is still processing it (recordings appear a few minutes after the call ends).',
      // Machine-readable "not there yet" flag the deferred poller keys off.
      notReady: missing,
      listed: { transcript: !!transcript, recording: !!recording },
    });
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
    return out(409, {
      error: 'This meeting was already imported.',
      existing: {
        assemblyai_id: dupe.assemblyai_id,
        title: dupe.title,
        created_at: dupe.created_at,
        own: dupe.user_id === user.userId,
        accessible: true,
      },
    });
  }
  if (!dupe && !force && callId) {
    try {
      const other = await findImportedByTeamsCallId(callId, {
        userId: user.userId,
        email: user.email,
      });
      if (other) {
        return out(409, {
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
        });
      }
    } catch (err) {
      // Dedupe is best-effort — never block an import on a failed check.
      console.warn('[teams/import] cross-user dedupe check failed:', err);
    }
  }

  // ---- Background import: the recording is READY, but streaming it from
  // Graph and re-uploading it to AssemblyAI takes minutes — queue the same
  // placeholder the not-ready path uses and let the deferred-import poller
  // (kicked immediately by the route) replay it app-only. Dedupe already
  // passed above, so conflicts stayed interactive; only the heavy pull moves
  // to the background. The placeholder's teams context deliberately omits
  // callId (same as the not-ready path) so cross-user dedupe on the replay
  // can never match the placeholder itself.
  if (body.background && mode !== 'transcript' && !opts?.placeholderAssemblyaiId) {
    const waitingFor: 'video' | 'both' = mode === 'both' ? 'both' : 'video';
    // Second click while queued → hand back the existing placeholder.
    const already = await findWaitingTeamsDeferred(
      user.userId,
      info.joinWebUrl,
      event.startTime ?? null
    );
    if (already) {
      return out(202, {
        deferred: true,
        background: true,
        waitingFor,
        transcript: already,
        mode,
        autoShared: 0,
      });
    }
    const placeholderId = `defer-${randomUUID()}`;
    const placeholder = await createDeferredPlaceholder(user.userId, {
      placeholderId,
      title: event.title ?? meeting.subject ?? null,
      recordedAt: event.startTime ?? meeting.startDateTime ?? null,
      gmeetContext: {
        provider: 'teams',
        teams: {
          joinWebUrl: info.joinWebUrl,
          tenantId: info.tenantId,
          organizerOid: info.organizerOid,
          graphMeetingId: meeting.id,
        },
        eventId: event.id,
        recurringEventId: event.recurringEventId,
        iCalUID: event.iCalUID,
        organizerEmail: event.organizerEmail,
        eventTitle: event.title,
        startTime: event.startTime,
        endTime: event.endTime,
        attendees,
        ...(body.contextExtra ?? {}),
        deferredImport: {
          mode,
          ownerEmail: user.email,
          background: true,
          request: {
            url: info.joinWebUrl,
            languageCode,
            force,
            event,
            contextExtra: body.contextExtra,
          },
          since: new Date().toISOString(),
          status: 'waiting',
        },
      },
    });
    const bgShareList = attendees.map((a) => ({ email: a.email, name: a.name }));
    const autoShared = await autoShareToInternalInvitees(
      placeholder.id,
      user.userId,
      user.email,
      bgShareList
    );
    await registerPeopleFromMeeting(bgShareList, user.userId);
    console.log(
      `[teams/import] background ${mode} import queued as ${placeholderId} (recording ready)`
    );
    return out(202, {
      deferred: true,
      background: true,
      waitingFor,
      transcript: placeholder,
      mode,
      autoShared,
    });
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
    ...(body.contextExtra ?? {}),
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
          return graphErrorOutcome(err);
        }
      } else {
        throw err;
      }
    }
    if (mode === 'transcript' && (!parsed || parsed.utterances.length === 0)) {
      return out(422, {
        error: 'The Teams transcript is empty — try importing the recording instead.',
      });
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
    // Deferred execution: the real row exists now — retire the placeholder
    // (its shares are re-established on the new row by the auto-share above).
    // Repoint the meeting FIRST so the placeholder's /m/ uuid (handed out at
    // click time) survives onto the real row instead of being orphan-cleaned.
    if (opts?.placeholderAssemblyaiId) {
      await repointMeeting(opts.placeholderAssemblyaiId, row.assemblyai_id).catch((err) =>
        console.error('[meetings] repoint failed', opts.placeholderAssemblyaiId, err)
      );
      await deleteForUser(user.userId, opts.placeholderAssemblyaiId);
    }
    return out(201, { transcript: row, mode, autoShared });
  }

  // ---- Video path: stream MP4 from Graph, AAI pipeline --------------------
  let tempFilename: string;
  try {
    const res = await getRecordingStream(info.organizerOid, meeting.id, recording!.id);
    if (!res.body) {
      return out(502, { error: 'Graph returned an empty recording body' });
    }
    const dl = await saveAudioStreamToTemp(res.body as ReadableStream<Uint8Array>);
    tempFilename = dl.tempFilename;
    if (dl.bytes === 0) {
      await deleteAudioFile(tempFilename);
      return out(502, { error: 'Graph returned an empty recording' });
    }
  } catch (err) {
    if (err instanceof GraphApiError) return graphErrorOutcome(err);
    console.error('[teams/import] recording download failed:', err);
    return out(502, { error: 'Recording download from Microsoft failed', detail: String(err) });
  }

  // Invitee + speaker names bias AAI's recognition, same as the Meet path.
  const keytermNames = new Set<string>();
  for (const a of attendees) {
    if (a.name && a.name.trim().length > 1) keytermNames.add(a.name.trim());
  }
  for (const s of parsed?.attendees ?? []) keytermNames.add(s);

  try {
    const finalContext: GmeetContext = { ...context, meetTranscript: parsed };
    const row = await ingestLocalAudio(user.userId, tempFilename, {
      originalFilename: `${title ?? 'teams-meeting'}.mp4`,
      languageCode,
      title,
      extraKeyterms: [...keytermNames],
      gmeetContext: finalContext,
      placeholderAssemblyaiId: opts?.placeholderAssemblyaiId ?? null,
    });
    // A promoted deferred placeholder keeps its queue-time gmeet_context —
    // overwrite it with the execution-time one (artifact ids + sidecar).
    // Shallow jsonb merge: absent keys (like the deferredImport marker)
    // survive for the poller to resolve.
    if (opts?.placeholderAssemblyaiId && row.assemblyai_id !== opts.placeholderAssemblyaiId) {
      await mergeGmeetContextForUser(user.userId, row.assemblyai_id, finalContext, {
        quiet: true,
      });
      row.gmeet_context = { ...row.gmeet_context, ...finalContext };
    }
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
    return out(201, { transcript: row, mode, autoShared });
  } catch (error) {
    if (error instanceof IngestError) {
      console.error(`[teams/import] ${error.stage} failed:`, error.causeErr);
      return out(502, { error: 'Transcription pipeline failed', detail: error.message });
    }
    throw error;
  }
}
