import 'server-only';
import {
  getMeetingCacheByKeys,
  getTeamsResolutionByKeys,
  upsertMeetingCache,
  type GmeetMeetingCacheRow,
  type TeamsResolutionCache,
} from '@/db-ops/gmeet-meeting-cache';
import { pickOccurrenceArtifacts, type TeamsJoinInfo } from '@/lib/teams-link';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import { listRecordings, listTranscripts, resolveMeetingByJoinUrl } from '@/lib/server/ms-graph';

/**
 * THE Teams "what does Microsoft hold for this occurrence" probe — the Teams
 * twin of `probeMeetingEvidence` in meeting-discovery. One code path for the
 * 30-minute poller sweep AND the listing's / dialog's on-demand "Check…":
 *
 *   resolve the onlineMeeting (app-only Graph, one $filter per occurrence
 *   ever — the resolution is stashed in the cache row's raw.teamsResolution)
 *   → list transcripts + recordings → pick THIS occurrence's artifacts by
 *   time window / callId → write the classified evidence back to
 *   gmeet_meeting_cache exactly the way the poller always did.
 *
 * Throws GraphApiError on a Graph failure — callers decide (poller: warn and
 * move on; route: `checkFailed`). Never swallows to "nothing found" (D5).
 */

export interface TeamsProbeInput {
  info: TeamsJoinInfo;
  /** The occurrence's calendar start/end (ISO). `eventEnd` falls back to the
   * start — artifacts are matched by window around it. */
  eventStart: string | null;
  eventEnd?: string | null;
  /** Display metadata for the cache row. */
  event?: {
    recurringEventId?: string | null;
    iCalUID?: string | null;
    organizerEmail?: string | null;
  } | null;
  capturedBy?: string | null;
  /** Pre-fetched cache state (the poller batches these per sweep); the probe
   * reads them itself when omitted. */
  existing?: GmeetMeetingCacheRow | null;
  resolution?: TeamsResolutionCache | null;
}

export interface TeamsProbeResult {
  /** `teams-<hash>` cache code (canonical join URL). */
  code: string;
  eventKey: string;
  /** False = Graph knows no onlineMeeting for the URL (deleted / never
   * materialized) — nothing was written, retry later. */
  resolved: boolean;
  hasTranscript: boolean;
  hasRecording: boolean;
  /** True when Graph was actually consulted this call (false = both
   * artifacts were already cached, nothing to ask). */
  probed: boolean;
}

export function teamsEventKey(code: string, eventStart: string | null): string {
  return `${code}|${eventStart ?? ''}`;
}

export async function probeTeamsEvidence(input: TeamsProbeInput): Promise<TeamsProbeResult> {
  const { info } = input;
  const code = teamsCacheCode(info.joinWebUrl);
  const key = teamsEventKey(code, input.eventStart);

  let existing = input.existing;
  let resolution = input.resolution;
  if (existing === undefined || resolution === undefined) {
    const [rows, res] = await Promise.all([
      existing === undefined ? getMeetingCacheByKeys([key]) : null,
      resolution === undefined ? getTeamsResolutionByKeys([key]) : null,
    ]);
    if (rows) existing = rows.get(key) ?? null;
    if (res) resolution = res.get(key) ?? null;
  }

  let hasTranscript = existing?.transcript_parseable === true;
  let hasRecording = (existing?.ready_recording_count ?? 0) > 0;
  // Artifacts are immutable once present — only hit Graph while one is
  // still missing (recordings routinely land minutes after transcripts).
  if (hasTranscript && hasRecording) {
    return { code, eventKey: key, resolved: true, hasTranscript, hasRecording, probed: false };
  }

  let resolved = resolution ?? null;
  if (!resolved) {
    const meeting = await resolveMeetingByJoinUrl(info.organizerOid, info.joinWebUrl);
    if (!meeting) {
      return { code, eventKey: key, resolved: false, hasTranscript, hasRecording, probed: true };
    }
    resolved = {
      joinWebUrl: info.joinWebUrl,
      organizerOid: info.organizerOid,
      graphMeetingId: meeting.id,
      meetingCode: meeting.meetingCode,
    };
  }
  const [transcripts, recordings] = await Promise.all([
    listTranscripts(resolved.organizerOid, resolved.graphMeetingId),
    listRecordings(resolved.organizerOid, resolved.graphMeetingId),
  ]);
  const startIso = input.eventStart;
  const endIso = input.eventEnd ?? startIso;
  const picked =
    startIso && endIso
      ? pickOccurrenceArtifacts(transcripts, recordings, startIso, endIso)
      : { transcript: undefined, recording: undefined };
  hasTranscript = !!picked.transcript;
  hasRecording = !!picked.recording;

  if (!hasTranscript && !hasRecording) {
    // Recap artifacts lag the call end by minutes. Record "asked Microsoft,
    // nothing yet" (states are the floor — a later probe only advances them)
    // and the resolution so the retry skips the $filter call.
    await upsertMeetingCache({
      eventKey: key,
      meetingCode: code,
      eventStart: startIso,
      conferenceRecord: null,
      recordingState: 'none',
      transcriptState: 'none',
      recurringEventId: input.event?.recurringEventId ?? null,
      iCalUID: input.event?.iCalUID ?? null,
      organizerEmail: input.event?.organizerEmail ?? null,
      raw: { teamsResolution: resolved, teamsProbedAt: new Date().toISOString() },
      capturedBy: input.capturedBy ?? null,
    });
    return { code, eventKey: key, resolved: true, hasTranscript, hasRecording, probed: true };
  }

  await upsertMeetingCache({
    eventKey: key,
    meetingCode: code,
    eventStart: startIso,
    conferenceRecord: null,
    confStart: picked.transcript?.createdDateTime ?? picked.recording?.createdDateTime ?? null,
    confEnd: picked.transcript?.endDateTime ?? picked.recording?.endDateTime ?? null,
    recordingCount: picked.recording ? 1 : 0,
    recordingsListed: picked.recording ? 1 : 0,
    readyRecordingCount: picked.recording ? 1 : 0,
    transcriptsListed: picked.transcript ? 1 : 0,
    recordingState: picked.recording ? 'ready' : 'none',
    transcriptState: picked.transcript ? 'ready' : 'none',
    transcriptSource: picked.transcript ? 'teams' : null,
    transcriptParseable: hasTranscript ? true : null,
    recurringEventId: input.event?.recurringEventId ?? null,
    iCalUID: input.event?.iCalUID ?? null,
    organizerEmail: input.event?.organizerEmail ?? null,
    raw: {
      teamsResolution: resolved,
      teamsProbedAt: new Date().toISOString(),
      teamsArtifacts: {
        transcript: picked.transcript ?? null,
        recording: picked.recording ?? null,
      },
    },
    capturedBy: input.capturedBy ?? null,
  });
  return { code, eventKey: key, resolved: true, hasTranscript, hasRecording, probed: true };
}
