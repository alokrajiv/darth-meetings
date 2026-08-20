import 'server-only';
import {
  getGoogleAccount,
  listPollableGoogleAccounts,
  markGoogleAccountPolled,
  type GoogleAccountRow,
} from '@/db-ops/google-accounts';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { getSyncState, findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import {
  upsertReminder,
  listOpenRemindersRaw,
  resolveReminderByKey,
} from '@/db-ops/gmeet-reminders';
import {
  findConferenceRecordName,
  getDriveFileMeta,
  GoogleApiError,
  listRecordArtifacts,
  parseTranscriptDocs,
} from '@/lib/server/gmeet';
import {
  getMeetingCacheByKeys,
  getTeamsResolutionByKeys,
  upsertMeetingCache,
  type GmeetMeetingCacheRow,
} from '@/db-ops/gmeet-meeting-cache';
import { findImportedByTeamsMeetings } from '@/db-ops/teams-import';
import { sweepAutoImportSeries } from '@/lib/server/series-auto-import';
import {
  upsertCalendarEvents,
  type CalendarEventUpsert,
} from '@/db-ops/calendar-event-cache';
import {
  findTeamsJoinUrl,
  isOwnTenant,
  parseTeamsJoinLink,
  pickOccurrenceArtifacts,
  type TeamsJoinInfo,
} from '@/lib/teams-link';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import {
  GraphApiError,
  isGraphConfigured,
  listRecordings,
  listTranscripts,
  resolveMeetingByJoinUrl,
} from '@/lib/server/ms-graph';

/**
 * Background sync-and-remind poller. Every POLL_MS, for each user with a
 * connected Google account, sweep their calendar:
 *
 *  - PAST Meet events (last LOOKBACK_DAYS) that nobody imported and that DO
 *    have a recording/transcript at Google → open an 'unimported' reminder.
 *    Importing stays a human act — the poller never imports anything.
 *  - PAST own-tenant TEAMS events (same window): resolve app-only via Graph,
 *    check artifacts, cache metadata, same 'unimported' reminders. The
 *    reminder's meeting_code carries the `teams-…` cache code — that prefix
 *    is the provider marker for the UI. External-tenant Teams events are
 *    skipped here (nothing to check without their tenant's consent); the
 *    dialog labels them straight from the join URL.
 *  - UPCOMING events (next LOOKAHEAD_H) the user ORGANIZES whose
 *    auto-recording/transcription/notes are ALL off → 'autorec_off' reminder
 *    (artifactConfig is only visible to the organizer, so this is exactly
 *    the set of meetings the user can actually fix).
 *
 * Also reconciles previously-open reminders (imported / muted / event passed
 * / config fixed → resolved). Serial across users; each user's sweep uses
 * only their own token; Teams artifact checks use the app-only Graph
 * credential (display/reminder metadata only — imports re-resolve fresh).
 */

const POLL_MS = Number(process.env.GMEET_POLL_MINUTES || 30) * 60 * 1000;
const LOOKBACK_DAYS = 7;
const LOOKAHEAD_H = 24;
const MEET_API = 'https://meet.googleapis.com/v2';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

interface CalEvent {
  id: string;
  summary?: string;
  recurringEventId?: string;
  iCalUID?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    resource?: boolean;
  }>;
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: { key?: { type?: string } };
    entryPoints?: Array<{ uri?: string }>;
  };
}

async function apiJson<T>(token: string, url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.debug('[gmeet-poller] api miss', res.status, url.split('?')[0]);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.debug('[gmeet-poller] api error', url.split('?')[0], err);
    return null;
  }
}

async function listCalendarEvents(token: string): Promise<CalEvent[]> {
  const timeMin = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const timeMax = new Date(Date.now() + LOOKAHEAD_H * 3_600_000).toISOString();
  const events: CalEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const json = await apiJson<{ items?: CalEvent[]; nextPageToken?: string }>(
      token,
      `${CAL_API}/calendars/primary/events?${params}`
    );
    if (!json) break;
    events.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return events;
}

function isMeetEvent(e: CalEvent): boolean {
  return (
    e.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet' &&
    MEET_CODE_RE.test(e.conferenceData?.conferenceId ?? '')
  );
}

/** Teams meetings scheduled from Google Calendar (GSuite add-on) carry the
 * meetup-join link in location / description / conference entry points. */
function teamsInfoOf(e: CalEvent): TeamsJoinInfo | null {
  const hay = [
    e.location,
    e.description,
    ...(e.conferenceData?.entryPoints ?? []).map((p) => p.uri),
  ]
    .filter(Boolean)
    .join('\n');
  const url = findTeamsJoinUrl(hay);
  return url ? parseTeamsJoinLink(url) : null;
}

function eventStartIso(e: CalEvent): string | null {
  return e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
}

function eventKeyOf(code: string, startIso: string | null): string {
  return `${code}|${startIso ?? ''}`;
}

/** All-day events carry only start.date — the calendar cache keeps timed
 * events only (an all-day block is never a "meeting that wasn't recorded"). */
function isCacheableEvent(e: CalEvent): boolean {
  return !!e.id && !!e.start?.dateTime;
}

function toCalendarUpsert(e: CalEvent): CalendarEventUpsert {
  // Rooms/resources aren't people — drop them where trivially identifiable.
  const people = (e.attendees ?? []).filter((a) => a.email && !a.resource);
  // Teams events get their `teams-…` cache code so the norec view knows the
  // event HAS a meeting link (Teams glyph, importable) and can migrate the
  // row to the unimported view once the Teams sweep records artifacts under
  // the same code. External-tenant links count too — the import dialog's
  // guided manual panel is still the right click-through for those.
  const teamsInfo = isMeetEvent(e) ? null : teamsInfoOf(e);
  return {
    eventKey: `${e.id}|${e.start!.dateTime}`,
    eventId: e.id,
    recurringEventId: e.recurringEventId ?? null,
    iCalUID: e.iCalUID ?? null,
    title: e.summary ?? null,
    eventStart: e.start!.dateTime!,
    eventEnd: e.end?.dateTime ?? null,
    meetingCode: isMeetEvent(e)
      ? e.conferenceData!.conferenceId!
      : teamsInfo
        ? teamsCacheCode(teamsInfo.joinWebUrl)
        : null,
    organizerEmail: e.organizer?.email ?? null,
    organizerSelf: e.organizer?.self ?? null,
    attendeeCount: people.length,
    attendees: people.slice(0, 50).map((a) => ({
      email: a.email!,
      ...(a.displayName ? { displayName: a.displayName } : {}),
      ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
    })),
  };
}

/**
 * One-time metadata capture for the meeting cache. Meeting artifacts are
 * immutable once Meet finishes processing them, so each field is fetched at
 * most once ever (across all users — the cache is global); later sweeps
 * only fill gaps, e.g. a recording that finished processing late.
 *
 * The Doc parse doubles as validation: parseable=false is the "quick import
 * would fail" signal the dialog uses to warn BEFORE the user hits Import.
 * An export failure (403/404) leaves parseable null so the next sweep — or
 * a colleague whose token can read the Doc — retries.
 */
async function captureMeetingMeta(
  token: string,
  input: {
    userId: string;
    eventKey: string;
    meetingCode: string;
    eventStart: string | null;
    event: CalEvent;
    recordName: string;
    artifacts: Awaited<ReturnType<typeof listRecordArtifacts>>;
    existing: GmeetMeetingCacheRow | undefined;
  }
): Promise<void> {
  const { eventKey, meetingCode, eventStart, event, recordName, artifacts, existing } = input;
  const firstFileId = artifacts.recordings.find((r) => r.fileId)?.fileId ?? null;
  const needConf = !existing?.conf_start;
  const needVideo = !!firstFileId && existing?.video_size == null;
  const needParse = artifacts.transcriptDocIds.length > 0 && existing?.transcript_parseable == null;
  const needInventory =
    !existing ||
    artifacts.recordings.length > existing.recording_count ||
    (!!firstFileId && !existing.video_file_id) ||
    (artifacts.transcriptDocIds.length > 0 && !existing.transcript_doc_ids?.length);
  if (!needConf && !needVideo && !needParse && !needInventory) return;

  // Everything structured the APIs hand back goes into `raw` verbatim —
  // fields we don't shape today are still on disk when we want them later.
  const raw: Record<string, unknown> = {};
  if (artifacts.raw.recordings) raw.recordings = artifacts.raw.recordings;
  if (artifacts.raw.transcripts) raw.transcripts = artifacts.raw.transcripts;

  let confStart: string | null = null;
  let confEnd: string | null = null;
  if (needConf) {
    const rec = await apiJson<{ startTime?: string; endTime?: string }>(
      token,
      `${MEET_API}/${recordName}`
    );
    confStart = rec?.startTime ?? null;
    confEnd = rec?.endTime ?? null;
    if (rec) raw.conferenceRecord = rec;
  }

  let videoSize: number | null = null;
  let videoDurationMs: number | null = null;
  if (needVideo) {
    try {
      const meta = await getDriveFileMeta(token, firstFileId!);
      videoSize = meta.size;
      videoDurationMs = meta.durationMs;
    } catch (err) {
      // This user may not see the file even though the record lists it —
      // leave nulls; a sweep under the organizer's token will fill them.
      console.debug('[gmeet-poller] drive meta miss', firstFileId, err);
    }
  }

  let parseable: boolean | null = null;
  let utteranceCount: number | null = null;
  let wordCount: number | null = null;
  let speakers: string[] | null = null;
  if (needParse) {
    try {
      const parsed = await parseTranscriptDocs(token, artifacts.transcriptDocIds);
      parseable = parsed.utterances.length > 0;
      utteranceCount = parsed.utterances.length;
      wordCount = parsed.utterances.reduce(
        (s, u) => s + (u.text ? u.text.split(/\s+/).length : 0),
        0
      );
      speakers = [...new Set(parsed.utterances.map((u) => u.speaker))];
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err;
      // Doc unreadable with THIS token — null means "not checked yet".
      console.debug('[gmeet-poller] transcript doc miss', eventKey, err.status);
    }
  }

  await upsertMeetingCache({
    eventKey,
    meetingCode,
    eventStart,
    conferenceRecord: recordName,
    confStart,
    confEnd,
    recordingCount: artifacts.recordings.length,
    videoFileId: firstFileId,
    videoSize,
    videoDurationMs,
    transcriptDocIds:
      artifacts.transcriptDocIds.length > 0 ? artifacts.transcriptDocIds : null,
    transcriptParseable: parseable,
    utteranceCount,
    wordCount,
    speakers,
    recurringEventId: event.recurringEventId ?? null,
    iCalUID: event.iCalUID ?? null,
    organizerEmail: event.organizer?.email ?? null,
    raw: Object.keys(raw).length > 0 ? raw : null,
    capturedBy: input.userId,
  });
}

type ArtifactSetting = 'ON' | 'OFF' | undefined;

/** artifactConfig for a space — organizer-only; non-organizers get config
 * silently omitted (returns null → "unknown", never remind on unknown). */
async function getArtifactConfig(
  token: string,
  meetingCode: string
): Promise<{ rec: ArtifactSetting; trans: ArtifactSetting; notes: ArtifactSetting } | null> {
  const space = await apiJson<{
    config?: {
      artifactConfig?: {
        recordingConfig?: { autoRecordingGeneration?: string };
        transcriptionConfig?: { autoTranscriptionGeneration?: string };
        smartNotesConfig?: { autoSmartNotesGeneration?: string };
      };
    };
  }>(token, `${MEET_API}/spaces/${meetingCode}`);
  const a = space?.config?.artifactConfig;
  if (!a) return null;
  return {
    rec: a.recordingConfig?.autoRecordingGeneration as ArtifactSetting,
    trans: a.transcriptionConfig?.autoTranscriptionGeneration as ArtifactSetting,
    notes: a.smartNotesConfig?.autoSmartNotesGeneration as ArtifactSetting,
  };
}

/**
 * Teams half of a user's sweep: past own-tenant Teams meetings that nobody
 * imported and that DO have artifacts at Microsoft → 'unimported' reminders,
 * plus the metadata cache row the check route serves. App-only Graph; one
 * resolution per occurrence ever (cached in raw.teamsResolution), and once
 * both artifacts are known no Graph call is made at all.
 */
async function sweepUserTeams(
  caller: { userId: string; email: string },
  events: CalEvent[],
  mutedKeys: Set<string>,
  now: number
): Promise<void> {
  if (!isGraphConfigured()) return;
  const past: Array<{ e: CalEvent; info: TeamsJoinInfo }> = [];
  for (const e of events) {
    const end = e.end?.dateTime ?? e.end?.date;
    if (!end || Date.parse(end) >= now - 15 * 60_000) continue;
    const info = teamsInfoOf(e);
    // External-tenant meetings are unreachable app-only — the dialog labels
    // them straight from the join URL; nothing to poll for.
    if (!info || !isOwnTenant(info)) continue;
    past.push({ e, info });
  }
  if (past.length === 0) return;

  const imported = await findImportedByTeamsMeetings(
    past.map(({ e, info }) => ({ joinWebUrl: info.joinWebUrl, startTime: eventStartIso(e) })),
    caller
  );
  const keys = past.map(({ e, info }) =>
    eventKeyOf(teamsCacheCode(info.joinWebUrl), eventStartIso(e))
  );
  const [cacheRows, resolutions] = await Promise.all([
    getMeetingCacheByKeys(keys),
    getTeamsResolutionByKeys(keys),
  ]);

  for (let i = 0; i < past.length; i++) {
    const { e, info } = past[i]!;
    const startIso = eventStartIso(e);
    const code = teamsCacheCode(info.joinWebUrl);
    const key = keys[i]!;
    if (imported[i]) {
      await resolveReminderByKey(caller.userId, 'unimported', key, 'imported');
      continue;
    }
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) {
      await resolveReminderByKey(caller.userId, 'unimported', key, 'muted');
      continue;
    }

    const existing = cacheRows.get(key);
    let hasTranscript = existing?.transcript_parseable === true;
    let hasRecording = (existing?.recording_count ?? 0) > 0;
    // Artifacts are immutable once present — only hit Graph while one is
    // still missing (recordings routinely land minutes after transcripts).
    if (!hasTranscript || !hasRecording) {
      try {
        let resolution = resolutions.get(key) ?? null;
        if (!resolution) {
          const meeting = await resolveMeetingByJoinUrl(info.organizerOid, info.joinWebUrl);
          if (!meeting) continue; // deleted or never materialized — retry next sweep
          resolution = {
            joinWebUrl: info.joinWebUrl,
            organizerOid: info.organizerOid,
            graphMeetingId: meeting.id,
            meetingCode: meeting.meetingCode,
          };
        }
        const [transcripts, recordings] = await Promise.all([
          listTranscripts(resolution.organizerOid, resolution.graphMeetingId),
          listRecordings(resolution.organizerOid, resolution.graphMeetingId),
        ]);
        const endIso = e.end?.dateTime ?? e.end?.date ?? startIso;
        const picked =
          startIso && endIso
            ? pickOccurrenceArtifacts(transcripts, recordings, startIso, endIso)
            : { transcript: undefined, recording: undefined };
        hasTranscript = !!picked.transcript;
        hasRecording = !!picked.recording;
        if (!hasTranscript && !hasRecording) {
          // Recap artifacts lag the call end by minutes — cache the
          // resolution so the retry next sweep skips the $filter call.
          if (!resolutions.get(key)) {
            await upsertMeetingCache({
              eventKey: key,
              meetingCode: code,
              eventStart: startIso,
              conferenceRecord: null,
              raw: { teamsResolution: resolution },
              capturedBy: caller.userId,
            });
          }
          continue;
        }
        await upsertMeetingCache({
          eventKey: key,
          meetingCode: code,
          eventStart: startIso,
          conferenceRecord: null,
          confStart:
            picked.transcript?.createdDateTime ?? picked.recording?.createdDateTime ?? null,
          confEnd: picked.transcript?.endDateTime ?? picked.recording?.endDateTime ?? null,
          recordingCount: picked.recording ? 1 : 0,
          transcriptParseable: hasTranscript ? true : null,
          recurringEventId: e.recurringEventId ?? null,
          iCalUID: e.iCalUID ?? null,
          organizerEmail: e.organizer?.email ?? null,
          raw: {
            teamsResolution: resolution,
            teamsArtifacts: {
              transcript: picked.transcript ?? null,
              recording: picked.recording ?? null,
            },
          },
          capturedBy: caller.userId,
        });
      } catch (err) {
        if (err instanceof GraphApiError) {
          console.warn(
            '[gmeet-poller] teams artifact check failed for',
            key,
            err.status,
            err.code ?? ''
          );
          continue;
        }
        throw err;
      }
    }
    await upsertReminder({
      userId: caller.userId,
      kind: 'unimported',
      eventKey: key,
      meetingCode: code,
      title: e.summary ?? null,
      eventStart: startIso,
      organizerSelf: e.organizer?.self ?? false,
      hasRecording,
      hasTranscript,
    });
  }
}

async function sweepUser(account: GoogleAccountRow): Promise<void> {
  const minted = await getServerAccessToken(account.user_id);
  if (!minted) return; // revoked / transient failure — status already recorded
  const token = minted.token;
  const userId = account.user_id;
  const caller = { userId, email: account.user_email };

  const [allEvents, { skips }, openReminders] = await Promise.all([
    listCalendarEvents(token),
    getSyncState(userId),
    listOpenRemindersRaw(userId),
  ]);
  // Persist ALL timed events (Meet or not) into the per-user calendar cache
  // BEFORE the Meet filter — this is the only place artifact-less calendar
  // events ever touch the DB (powers the "no recording" listing view).
  // A cache write failure must never break the sweep.
  try {
    await upsertCalendarEvents(userId, allEvents.filter(isCacheableEvent).map(toCalendarUpsert));
  } catch (err) {
    console.warn(`[gmeet-poller] calendar cache write failed for ${account.user_email}:`, err);
  }

  const events = allEvents.filter(isMeetEvent);
  const mutedKeys = new Set(skips.map((s) => s.event_key));
  const now = Date.now();

  // ---- past events → 'unimported' reminders -------------------------------
  const past = events.filter((e) => {
    const end = e.end?.dateTime ?? e.end?.date;
    return end ? Date.parse(end) < now - 15 * 60_000 : false;
  });
  const pastMeetings = past.map((e) => ({
    code: e.conferenceData!.conferenceId!,
    startTime: eventStartIso(e),
  }));
  const imported = await findImportedByMeetingCodes(pastMeetings, caller);
  const cacheRows = await getMeetingCacheByKeys(
    pastMeetings.map((m) => eventKeyOf(m.code, m.startTime))
  );

  for (let i = 0; i < past.length; i++) {
    const e = past[i]!;
    const code = pastMeetings[i]!.code;
    const startIso = pastMeetings[i]!.startTime;
    const key = eventKeyOf(code, startIso);
    if (imported[i]) {
      await resolveReminderByKey(userId, 'unimported', key, 'imported');
      continue;
    }
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) {
      await resolveReminderByKey(userId, 'unimported', key, 'muted');
      continue;
    }
    // Meeting artifacts only appear a while after the call ends; re-checked
    // every poll until the event ages out of the window.
    const recordName = await findConferenceRecordName(token, code, startIso ?? undefined);
    if (!recordName) continue; // never held or nothing captured — nothing to nag about
    const artifacts = await listRecordArtifacts(token, recordName);
    const hasRecording = artifacts.recordings.length > 0;
    const hasTranscript = artifacts.transcriptDocIds.length > 0;
    if (!hasRecording && !hasTranscript) continue;
    try {
      await captureMeetingMeta(token, {
        userId,
        eventKey: key,
        meetingCode: code,
        eventStart: startIso,
        event: e,
        recordName,
        artifacts,
        existing: cacheRows.get(key),
      });
    } catch (err) {
      console.warn('[gmeet-poller] meta capture failed for', key, err);
    }
    await upsertReminder({
      userId,
      kind: 'unimported',
      eventKey: key,
      meetingCode: code,
      title: e.summary ?? null,
      eventStart: startIso,
      organizerSelf: e.organizer?.self ?? false,
      hasRecording,
      hasTranscript,
    });
  }

  // ---- upcoming organized events → 'autorec_off' reminders ----------------
  const upcoming = events.filter((e) => {
    const start = eventStartIso(e);
    return start !== null && Date.parse(start) > now && e.organizer?.self === true;
  });
  for (const e of upcoming) {
    const code = e.conferenceData!.conferenceId!;
    const startIso = eventStartIso(e);
    const key = eventKeyOf(code, startIso);
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) continue;
    const cfg = await getArtifactConfig(token, code);
    if (!cfg) continue; // config invisible → we're not really the organizer; stay quiet
    const anythingOn = cfg.rec === 'ON' || cfg.trans === 'ON' || cfg.notes === 'ON';
    if (anythingOn) {
      await resolveReminderByKey(userId, 'autorec_off', key, 'config_on');
    } else {
      await upsertReminder({
        userId,
        kind: 'autorec_off',
        eventKey: key,
        meetingCode: code,
        title: e.summary ?? null,
        eventStart: startIso,
        organizerSelf: true,
        hasRecording: false,
        hasTranscript: false,
      });
    }
  }

  // ---- Teams events (own tenant) → 'unimported' reminders + cache ---------
  try {
    await sweepUserTeams(caller, allEvents, mutedKeys, now);
  } catch (err) {
    console.warn(`[gmeet-poller] teams sweep failed for ${account.user_email}:`, err);
  }

  // ---- reconcile older open reminders -------------------------------------
  // 'autorec_off' whose meeting already started is moot; stale 'unimported'
  // rows (outside the calendar window) still get import/mute resolution so a
  // colleague importing a 3-week-old meeting clears everyone's reminder.
  // Teams reminders (meeting_code `teams-…`) resolve through the cache row's
  // stored join URL instead of the Meet meeting-code lookup.
  const staleUnimported: Array<{ key: string; code: string; start: string | null }> = [];
  const staleTeams: Array<{ key: string; start: string | null }> = [];
  for (const r of openReminders) {
    if (r.kind === 'autorec_off') {
      if (r.event_start && Date.parse(r.event_start) < now) {
        await resolveReminderByKey(userId, 'autorec_off', r.event_key, 'expired');
      }
      continue;
    }
    if (mutedKeys.has(r.meeting_code ?? '') || mutedKeys.has(r.event_key)) {
      await resolveReminderByKey(userId, 'unimported', r.event_key, 'muted');
      continue;
    }
    if (r.meeting_code?.startsWith('teams-')) {
      staleTeams.push({ key: r.event_key, start: r.event_start });
    } else if (r.meeting_code) {
      staleUnimported.push({ key: r.event_key, code: r.meeting_code, start: r.event_start });
    }
  }
  if (staleUnimported.length > 0) {
    const found = await findImportedByMeetingCodes(
      staleUnimported.map((s) => ({ code: s.code, startTime: s.start })),
      caller
    );
    for (let i = 0; i < staleUnimported.length; i++) {
      if (found[i]) {
        await resolveReminderByKey(userId, 'unimported', staleUnimported[i]!.key, 'imported');
      }
    }
  }
  if (staleTeams.length > 0) {
    const resolutions = await getTeamsResolutionByKeys(staleTeams.map((s) => s.key));
    const withUrl = staleTeams.filter((s) => resolutions.get(s.key)?.joinWebUrl);
    if (withUrl.length > 0) {
      const found = await findImportedByTeamsMeetings(
        withUrl.map((s) => ({
          joinWebUrl: resolutions.get(s.key)!.joinWebUrl,
          startTime: s.start,
        })),
        caller
      );
      for (let i = 0; i < withUrl.length; i++) {
        if (found[i]) {
          await resolveReminderByKey(userId, 'unimported', withUrl[i]!.key, 'imported');
        }
      }
    }
  }

  await markGoogleAccountPolled(userId);
}

let started = false;
let sweeping = false;

async function sweepAll(): Promise<void> {
  if (sweeping) return; // a slow sweep must not stack onto the next tick
  sweeping = true;
  try {
    const accounts = await listPollableGoogleAccounts();
    for (const account of accounts) {
      try {
        await sweepUser(account);
      } catch (err) {
        console.warn(`[gmeet-poller] sweep failed for ${account.user_email}:`, err);
      }
    }
    if (accounts.length > 0) {
      console.log(`[gmeet-poller] swept ${accounts.length} account(s)`);
    }
    // Series auto-import rides the same 30-minute cadence — after the
    // per-account sweeps so freshly-cached calendar data is available.
    await sweepAutoImportSeries();
  } catch (err) {
    console.warn('[gmeet-poller] sweep pass failed:', err);
  } finally {
    sweeping = false;
  }
}

export function startGmeetPoller(): void {
  if (started) return;
  started = true;
  console.log(`[gmeet-poller] armed: every ${POLL_MS / 60000}m`);
  const timer = setInterval(() => void sweepAll(), POLL_MS);
  timer.unref?.();
  // First pass shortly after boot.
  setTimeout(() => void sweepAll(), 2 * 60 * 1000).unref?.();
}

/** One immediate pass — used by the manual "poll now" hook in dev/testing. */
export function triggerGmeetPoll(): Promise<void> {
  return sweepAll();
}

/**
 * Immediate first sweep for a just-connected account. The 30-minute tick is
 * far too slow for the post-connect experience — until last_poll_at lands,
 * the listing shows a "still syncing" banner and the calendar layers look
 * misleadingly empty. Fire-and-forget from the OAuth callback.
 */
export async function sweepNewAccount(userId: string): Promise<void> {
  try {
    const account = await getGoogleAccount(userId);
    if (!account) return;
    await sweepUser(account);
  } catch (err) {
    console.warn('[gmeet-poller] post-connect sweep failed:', err);
  }
}
