import 'server-only';
import {
  upsertCalendarEvents,
  type CalendarEventUpsert,
} from '@/db-ops/calendar-event-cache';
import {
  getMeetingCacheByKeys,
  getMeetingCacheByMeetings,
  upsertMeetingCache,
  type GmeetMeetingCacheRow,
} from '@/db-ops/gmeet-meeting-cache';
import {
  classifyCalendarAttachments,
  classifyEvidence,
  classifyRecordings,
  classifyTranscripts,
  recordMatchesOccurrence,
  type ClassifiedAttachments,
  type EvidenceVerdict,
  type RecordingEvidence,
  type TranscriptEvidence,
} from '@/lib/meeting-evidence';
import type {
  CachedMeetingMeta,
  DiscoveredEvent,
  DiscoveredMeetInfo,
  DiscoveredRow,
} from '@/lib/meeting-discovery-types';
import {
  getDriveFileMeta,
  getSpaceMeetingCode,
  GoogleApiError,
  listConferenceRecords,
  listRecordArtifacts,
  nearestRecord,
  parseTranscriptDocs,
  recordFilterForOccurrence,
  type ConferenceRecordLite,
} from '@/lib/server/gmeet';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import { findTeamsJoinUrl } from '@/lib/teams-link';

/**
 * THE meeting-discovery service (docs/meeting-evidence-consolidation.md,
 * Phase 2). Every surface that asks Google "what is on the calendar" or
 * "what did Meet keep for this occurrence" goes through here, and every
 * answer is written back to the two caches — so work done by any one caller
 * (the 30-minute poller, a dialog day view, a series sweep, an import
 * pre-check) feeds all the others instead of being thrown away.
 *
 *  - syncCalendarWindow  → Calendar API → calendar_event_cache (per user)
 *  - probeMeetingEvidence → Meet API (+Drive/Docs gap-fill) → gmeet_meeting_cache
 *  - discoverWindow       → both, joined into dialog-ready rows
 *
 * Token rule is unchanged: each call runs under the token the caller hands
 * in (the poller: the account owner's; routes: the caller's server-minted
 * token). The caches are display-only — nothing here grants content access.
 */

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const MEET_API = 'https://meet.googleapis.com/v2';
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const MEET_BATCH = 6;

/** Calendar fields every consumer needs (the union of the old poller /
 * dialog / series field lists — one declaration). */
const CAL_FIELDS =
  'items(id,status,summary,htmlLink,recurringEventId,iCalUID,organizer(email,self),' +
  'location,description,start,end,' +
  'attendees(email,displayName,responseStatus,self,resource),' +
  'attachments(fileId,title,mimeType),' +
  'conferenceData(conferenceId,conferenceSolution(key(type)),entryPoints(uri))),nextPageToken';

async function apiJson<T>(token: string, url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.debug('[discovery] api miss', res.status, url.split('?')[0]);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.debug('[discovery] api error', url.split('?')[0], err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export class CalendarListError extends Error {
  constructor(public status: number) {
    super(`Calendar request failed (${status})`);
    this.name = 'CalendarListError';
  }
}

export interface CalendarListParams {
  timeMin: string;
  timeMax: string;
  /** Free-text search (series sweep). */
  q?: string;
  iCalUID?: string;
  maxPages?: number;
}

/**
 * Raw Calendar API listing (primary calendar, single instances, cancelled
 * dropped). Throws CalendarListError on a non-OK FIRST page so callers can
 * surface "Google session expired" vs silently showing an empty day; later
 * page failures return what was collected.
 */
export async function listCalendarEvents(
  token: string,
  params: CalendarListParams
): Promise<DiscoveredEvent[]> {
  const out: DiscoveredEvent[] = [];
  let pageToken: string | undefined;
  const maxPages = params.maxPages ?? 4;
  for (let p = 0; p < maxPages; p++) {
    const q = new URLSearchParams({
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      fields: CAL_FIELDS,
    });
    if (params.q) q.set('q', params.q);
    if (params.iCalUID) {
      q.set('iCalUID', params.iCalUID);
      q.delete('orderBy');
    }
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`${CAL_API}/calendars/primary/events?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (p === 0) throw new CalendarListError(res.status);
      break;
    }
    const j = (await res.json()) as {
      items?: Array<DiscoveredEvent & { status?: string }>;
      nextPageToken?: string;
    };
    for (const e of j.items ?? []) {
      if (!e.id || e.status === 'cancelled') continue;
      out.push(e);
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export function isMeetEvent(e: DiscoveredEvent): boolean {
  const code = e.conferenceData?.conferenceId ?? '';
  const type = e.conferenceData?.conferenceSolution?.key?.type;
  // conferenceSolution isn't always requested/present — a well-formed code
  // is the practical signal (the poller's stricter check only ever added
  // the type test when it WAS present).
  return MEET_CODE_RE.test(code) && (type === undefined || type === 'hangoutsMeet');
}

/** Teams meetings scheduled from Google Calendar (GSuite add-on) carry the
 * meetup-join link in location / description / conference entry points. */
export function teamsUrlOf(e: DiscoveredEvent): string | null {
  const hay = [
    e.location,
    e.description,
    ...(e.conferenceData?.entryPoints ?? []).map((p) => p.uri),
  ]
    .filter(Boolean)
    .join('\n');
  return findTeamsJoinUrl(hay);
}

export function eventStartIso(e: DiscoveredEvent): string | null {
  return e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
}

/** All-day events carry only start.date — the calendar cache keeps timed
 * events only (an all-day block is never a "meeting that wasn't recorded"). */
export function isCacheableEvent(e: DiscoveredEvent): boolean {
  return !!e.id && !!e.start?.dateTime;
}

export function toCalendarUpsert(e: DiscoveredEvent): CalendarEventUpsert {
  // Rooms/resources aren't people — drop them where trivially identifiable.
  const people = (e.attendees ?? []).filter((a) => a.email && !a.resource);
  // Teams events get their `teams-…` cache code so the norec view knows the
  // event HAS a meeting link (Teams glyph, importable) and can migrate the
  // row to the unimported view once the Teams sweep records artifacts under
  // the same code. External-tenant links count too — the import dialog's
  // guided manual panel is still the right click-through for those.
  const meet = isMeetEvent(e);
  const teamsUrl = meet ? null : teamsUrlOf(e);
  const att = classifyCalendarAttachments(e.attachments);
  return {
    eventKey: `${e.id}|${e.start!.dateTime}`,
    eventId: e.id,
    recurringEventId: e.recurringEventId ?? null,
    iCalUID: e.iCalUID ?? null,
    title: e.summary ?? null,
    eventStart: e.start!.dateTime!,
    eventEnd: e.end?.dateTime ?? null,
    meetingCode: meet
      ? e.conferenceData!.conferenceId!
      : teamsUrl
        ? teamsCacheCode(teamsUrl)
        : null,
    organizerEmail: e.organizer?.email ?? null,
    organizerSelf: e.organizer?.self ?? null,
    attendeeCount: people.length,
    attendees: people.slice(0, 50).map((a) => ({
      email: a.email!,
      ...(a.displayName ? { displayName: a.displayName } : {}),
      ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
    })),
    attachmentVideoCount: att.videoCount,
    attachmentVideoFileId: att.videoFileId,
    attachmentTranscriptDocId: att.transcriptDocId,
    attachmentGeminiNotes: att.geminiNotes,
  };
}

/** Write calendar events into the caller's per-user cache. Never throws — a
 * cache write failure must not break discovery. */
export async function persistCalendarEvents(
  userId: string,
  events: readonly DiscoveredEvent[]
): Promise<void> {
  try {
    await upsertCalendarEvents(userId, events.filter(isCacheableEvent).map(toCalendarUpsert));
  } catch (err) {
    console.warn('[discovery] calendar cache write failed for', userId, err);
  }
}

/**
 * Calendar window for one user: fetch + write back. Used by the poller
 * (−7d→+24h), the dialog day/sync views (via /api/calendar/discover) and
 * anything else that wants "what's on the calendar" — there is no other
 * Calendar listing path.
 */
export async function syncCalendarWindow(
  userId: string,
  token: string,
  window: { from: string; to: string; maxPages?: number }
): Promise<DiscoveredEvent[]> {
  const events = await listCalendarEvents(token, {
    timeMin: window.from,
    timeMax: window.to,
    maxPages: window.maxPages,
  });
  await persistCalendarEvents(userId, events);
  return events;
}

// ---------------------------------------------------------------------------
// Meet evidence
// ---------------------------------------------------------------------------

export interface RecordEvidence {
  recordName: string;
  recording: RecordingEvidence;
  transcript: TranscriptEvidence;
  verdict: EvidenceVerdict;
  checkFailed: boolean;
  artifacts: Awaited<ReturnType<typeof listRecordArtifacts>>;
}

/** One record's inventory, classified through the shared rules. No
 * persistence — pair with persistMeetingEvidence (or use probeMeetingEvidence). */
export async function probeRecordEvidence(
  token: string,
  recordName: string,
  attachments?: ClassifiedAttachments | null
): Promise<RecordEvidence> {
  const artifacts = await listRecordArtifacts(token, recordName);
  const recording = classifyRecordings(artifacts.recordings, attachments);
  const transcript = classifyTranscripts({
    docIds: artifacts.transcriptDocIds,
    listed: artifacts.transcriptsListed,
    attachments,
  });
  return {
    recordName,
    recording,
    transcript,
    verdict: classifyEvidence({ recording, transcript }),
    checkFailed: artifacts.checkFailed,
    artifacts,
  };
}

export function meetInfoOf(ev: RecordEvidence): DiscoveredMeetInfo {
  return {
    recordName: ev.recordName,
    videoFileId: ev.recording.fileIds[0] ?? null,
    transcriptDocId: ev.transcript.docIds[0] ?? null,
    videoPending: ev.recording.state === 'generating' || ev.recording.state === 'partial',
    transcriptPending: ev.transcript.state === 'generating',
    checked: !ev.checkFailed,
  };
}

export interface PersistEvidenceInput {
  userId: string;
  meetingCode: string;
  /** The occurrence anchor — the calendar start (raw dateTime string) when
   * there is one, else the record's start. Forms the global cache key
   * `${code}|${start}` exactly like the poller always has. */
  eventStart: string | null;
  recordName: string | null;
  recording: RecordingEvidence;
  transcript: TranscriptEvidence;
  artifacts: Awaited<ReturnType<typeof listRecordArtifacts>>;
  attachments: ClassifiedAttachments | null;
  event?: {
    recurringEventId?: string | null;
    iCalUID?: string | null;
    organizerEmail?: string | null;
  } | null;
  /** Pre-fetched row, to skip the read. */
  existing?: GmeetMeetingCacheRow | null;
}

export function cacheKeyOf(meetingCode: string, eventStart: string | null): string {
  return `${meetingCode}|${eventStart ?? ''}`;
}

/**
 * Write one occurrence's evidence into the global artifact cache — the
 * poller's old captureMeetingMeta, now the single writer for EVERY probe.
 * Fill-gaps semantics: conference times, Drive size/duration and the Doc
 * parse (parseable = "quick import would work") are each fetched at most
 * once ever across all users; later probes only add what's missing. Returns
 * the row as it stands after the write (null when nothing was worth writing
 * and nothing existed).
 */
export async function persistMeetingEvidence(
  token: string,
  input: PersistEvidenceInput
): Promise<GmeetMeetingCacheRow | null> {
  const { meetingCode, recordName, artifacts, recording: recEv } = input;
  // ONE row per occurrence: the poller keys rows by the calendar's raw
  // start string; a dialog/series probe may arrive with the record's ISO
  // start or another user's tz offset for the SAME instant. Reuse whatever
  // row already sits within the occurrence window instead of minting a
  // second key (the listing dedupes by instant, so a second key = a second
  // "Not imported" row, and the fetch-once contract would re-parse Docs).
  let existing: GmeetMeetingCacheRow | null = input.existing ?? null;
  if (input.existing === undefined || input.existing === null) {
    existing = input.eventStart
      ? ((await getMeetingCacheByMeetings([
          { code: meetingCode, startTime: input.eventStart },
        ]))[0] ?? null)
      : ((await getMeetingCacheByKeys([cacheKeyOf(meetingCode, null)])).get(
          cacheKeyOf(meetingCode, null)
        ) ?? null);
  }
  const eventStart = existing?.event_start ?? input.eventStart;
  const key = existing?.event_key ?? cacheKeyOf(meetingCode, eventStart);
  const trEvPre = input.transcript;
  const docIds = trEvPre.docIds;
  const verdict = classifyEvidence({ recording: recEv, transcript: trEvPre });
  // Nothing held / nothing attached / nothing generating — nothing to track
  // (a row would only say "no evidence", which the absence already says).
  if (!verdict.importable && !existing) return null;

  const firstFileId =
    artifacts.recordings.find((r) => r.fileId)?.fileId ?? input.attachments?.videoFileId ?? null;
  const needConf = !!recordName && !existing?.conf_start;
  const needVideo = !!firstFileId && existing?.video_size == null;
  const needParse = docIds.length > 0 && existing?.transcript_parseable == null;
  const needInventory =
    !existing ||
    recEv.listed > existing.recordings_listed ||
    recEv.ready > existing.ready_recording_count ||
    (!!firstFileId && !existing.video_file_id) ||
    docIds.length > (existing.transcript_doc_ids?.length ?? 0) ||
    trEvPre.listed > existing.transcripts_listed ||
    (!!recordName && !existing.conference_record);
  if (!needConf && !needVideo && !needParse && !needInventory) return existing;

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
      // leave nulls; a probe under the organizer's token will fill them.
      console.debug('[discovery] drive meta miss', firstFileId, err);
    }
  }

  let parseable: boolean | null = null;
  let utteranceCount: number | null = null;
  let wordCount: number | null = null;
  let speakers: string[] | null = null;
  if (needParse) {
    try {
      const parsed = await parseTranscriptDocs(token, docIds);
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
      console.debug('[discovery] transcript doc miss', key, err.status);
    }
  }

  // Re-classify with the parse verdict folded in (ready → unparseable).
  const trEv = classifyTranscripts({
    docIds: artifacts.transcriptDocIds,
    listed: artifacts.transcriptsListed,
    parseable: parseable ?? existing?.transcript_parseable ?? null,
    attachments: input.attachments,
  });
  await upsertMeetingCache({
    eventKey: key,
    meetingCode,
    eventStart,
    conferenceRecord: recordName,
    confStart,
    confEnd,
    recordingCount: recEv.listed,
    videoFileId: firstFileId,
    videoSize,
    videoDurationMs,
    transcriptDocIds: docIds.length > 0 ? docIds : null,
    transcriptParseable: parseable,
    utteranceCount,
    wordCount,
    speakers,
    recurringEventId: input.event?.recurringEventId ?? null,
    iCalUID: input.event?.iCalUID ?? null,
    organizerEmail: input.event?.organizerEmail ?? null,
    raw: Object.keys(raw).length > 0 ? raw : null,
    capturedBy: input.userId,
    recordingsListed: recEv.listed,
    readyRecordingCount: recEv.ready,
    transcriptsListed: trEv.listed,
    recordingState: recEv.state,
    transcriptState: trEv.state,
    transcriptSource: trEv.source,
  });
  return (await getMeetingCacheByKeys([key])).get(key) ?? null;
}

export function cachedMetaOf(c: GmeetMeetingCacheRow | null | undefined): CachedMeetingMeta | null {
  if (!c) return null;
  return {
    conferenceRecord: c.conference_record,
    confStart: c.conf_start,
    confEnd: c.conf_end,
    recordingCount: c.recording_count,
    readyRecordingCount: c.ready_recording_count,
    recordingState: c.recording_state,
    transcriptState: c.transcript_state,
    transcriptSource: c.transcript_source,
    videoFileId: c.video_file_id,
    videoSize: c.video_size,
    videoDurationMs: c.video_duration_ms,
    transcriptDocIds: c.transcript_doc_ids,
    transcriptParseable: c.transcript_parseable,
    utteranceCount: c.utterance_count,
    wordCount: c.word_count,
    speakerCount: c.speakers?.length ?? null,
  };
}

export interface ProbeInput {
  userId: string;
  meetingCode: string;
  /** Calendar start of the occurrence (raw dateTime string) — null for a
   * pasted link / Meet-only record. */
  eventStart: string | null;
  /** Known record — skips the lookup. */
  recordName?: string | null;
  attachments?: ClassifiedAttachments | null;
  event?: PersistEvidenceInput['event'];
  existing?: GmeetMeetingCacheRow | null;
}

export interface ProbeResult {
  recordName: string | null;
  recording: RecordingEvidence;
  transcript: TranscriptEvidence;
  verdict: EvidenceVerdict;
  checkFailed: boolean;
  artifacts: Awaited<ReturnType<typeof listRecordArtifacts>>;
  /** Row after write-back (null = nothing to track). */
  row: GmeetMeetingCacheRow | null;
}

const EMPTY_ARTIFACTS: Awaited<ReturnType<typeof listRecordArtifacts>> = {
  recordings: [],
  transcriptDocIds: [],
  transcriptsListed: 0,
  checkFailed: false,
  raw: {},
};

/**
 * "What did Google keep for this occurrence?" — find the record (within the
 * ONE lookup window), inventory it, fold calendar attachments in, classify,
 * and ALWAYS write back. The poller, the dialog's evidence route, the
 * series sweep and the import pre-checks all call this.
 */
/** Evidence the shared cache already proved for this occurrence (another
 * user's probe, the poller) in attachment shape, so a probe under a token
 * that sees less (non-organizer, aged-out record) still reports it. */
function cachedAsAttachments(row: GmeetMeetingCacheRow | null | undefined): ClassifiedAttachments | null {
  if (!row) return null;
  const docId = row.transcript_doc_ids?.[0] ?? null;
  if (!row.video_file_id && !docId) return null;
  return {
    videoFileId: row.video_file_id,
    videoCount: row.video_file_id ? Math.max(1, row.ready_recording_count) : 0,
    transcriptDocId: docId,
    geminiNotes: row.transcript_source === 'gemini',
  };
}

function mergeAttachments(
  a: ClassifiedAttachments | null,
  b: ClassifiedAttachments | null
): ClassifiedAttachments | null {
  if (!a) return b;
  if (!b) return a;
  return {
    videoFileId: a.videoFileId ?? b.videoFileId,
    videoCount: Math.max(a.videoCount, b.videoCount),
    transcriptDocId: a.transcriptDocId ?? b.transcriptDocId,
    geminiNotes: a.transcriptDocId ? a.geminiNotes : b.geminiNotes,
  };
}

export async function probeMeetingEvidence(token: string, input: ProbeInput): Promise<ProbeResult> {
  // Look the occurrence's row up front (callers may pass it) — its known
  // evidence folds into the verdict like calendar attachments do.
  let existingRow: GmeetMeetingCacheRow | null | undefined = input.existing;
  if (existingRow === undefined && input.eventStart) {
    existingRow =
      (await getMeetingCacheByMeetings([
        { code: input.meetingCode, startTime: input.eventStart },
      ]).catch(() => [null]))[0] ?? null;
  }
  const att = mergeAttachments(input.attachments ?? null, cachedAsAttachments(existingRow));
  let recordName = input.recordName ?? existingRow?.conference_record ?? null;
  // A failed record LOOKUP (403/quota/network) must read as "could not
  // check", never as "never started" (D5) — it's a separate call from the
  // artifact listing, so track it separately.
  let lookupFailed = false;
  if (!recordName) {
    const records = await listConferenceRecords(
      token,
      recordFilterForOccurrence(input.meetingCode, input.eventStart),
      1
    );
    if (records === null) lookupFailed = true;
    else recordName = nearestRecord(records, input.eventStart)?.name ?? null;
  }
  const artifacts = recordName ? await listRecordArtifacts(token, recordName) : EMPTY_ARTIFACTS;
  const recording = classifyRecordings(artifacts.recordings, att);
  const transcript = classifyTranscripts({
    docIds: artifacts.transcriptDocIds,
    listed: artifacts.transcriptsListed,
    parseable: existingRow?.transcript_parseable ?? null,
    attachments: att,
  });
  const verdict = classifyEvidence({ recording, transcript });
  let row: GmeetMeetingCacheRow | null = existingRow ?? null;
  try {
    row = await persistMeetingEvidence(token, {
      userId: input.userId,
      meetingCode: input.meetingCode,
      eventStart: input.eventStart,
      recordName,
      recording,
      transcript,
      artifacts,
      attachments: att,
      event: input.event,
      existing: existingRow,
    });
  } catch (err) {
    console.warn('[discovery] evidence write-back failed for', input.meetingCode, err);
  }
  // The write-back may have just probed the Doc (parseable=false) — fold
  // that into what we hand back so "ready" and "unparseable" can't disagree
  // between the response and the row.
  let transcriptOut = transcript;
  let verdictOut = verdict;
  if (row && row.transcript_parseable !== null && row.transcript_parseable !== transcript.state.startsWith('ready')) {
    transcriptOut = classifyTranscripts({
      docIds: artifacts.transcriptDocIds,
      listed: artifacts.transcriptsListed,
      parseable: row.transcript_parseable,
      attachments: att,
    });
    verdictOut = classifyEvidence({ recording, transcript: transcriptOut });
  }
  return {
    recordName,
    recording,
    transcript: transcriptOut,
    verdict: verdictOut,
    checkFailed: artifacts.checkFailed || lookupFailed,
    artifacts,
    row,
  };
}

// ---------------------------------------------------------------------------
// Dialog-facing discovery: rows for a window
// ---------------------------------------------------------------------------

function attachmentById(
  atts: DiscoveredEvent['attachments'],
  id: string | null
): NonNullable<DiscoveredEvent['attachments']>[number] | null {
  return id ? (atts?.find((a) => a.fileId === id) ?? null) : null;
}

/** A calendar event → a pickable row (attachments classified, no Meet info yet). */
export function rowOfEvent(e: DiscoveredEvent): DiscoveredRow {
  const c = classifyCalendarAttachments(e.attachments);
  return {
    event: e,
    video: attachmentById(e.attachments, c.videoFileId),
    transcriptDoc: c.geminiNotes ? null : attachmentById(e.attachments, c.transcriptDocId),
    geminiNotes: c.geminiNotes ? attachmentById(e.attachments, c.transcriptDocId) : null,
    videoCount: c.videoCount,
    meet: null,
    // An explicit Teams link wins over an (often auto-added) Meet link for
    // the pick list — legacy dialog behaviour; the Teams options step
    // re-resolves artifacts server-side anyway.
    teamsUrl: teamsUrlOf(e),
    offCalendar: false,
  };
}

/** A conference record with no calendar event → a synthetic row. */
export function rowOfRecord(
  rec: ConferenceRecordLite,
  code: string | null,
  meet: DiscoveredMeetInfo,
  label?: string
): DiscoveredRow {
  return {
    event: {
      id: rec.name,
      summary: label ?? `Meet${code ? ` · ${code}` : ''} (not on calendar)`,
      start: { dateTime: rec.startTime },
      end: { dateTime: rec.endTime },
      conferenceData: code ? { conferenceId: code } : undefined,
      attendees: [],
    },
    video: null,
    transcriptDoc: null,
    geminiNotes: null,
    videoCount: 0,
    meet,
    teamsUrl: null,
    offCalendar: true,
  };
}

export interface DiscoverWindowResult {
  rows: DiscoveredRow[];
  meetChecked: boolean;
}

/**
 * The dialog's day / sync view, server-side: calendar events in the window
 * (written back), joined with the Meet records that actually happened in it
 * (each inventoried + written back), Meet-only conferences surfaced as
 * off-calendar rows. `meetOnly` = "only rows with a Meet/Teams presence"
 * (the sync tab); the day view keeps every timed event.
 */
export async function discoverWindow(
  userId: string,
  token: string,
  opts: { from: string; to: string; meetOnly?: boolean; maxPages?: number }
): Promise<DiscoverWindowResult> {
  const events = await syncCalendarWindow(userId, token, {
    from: opts.from,
    to: opts.to,
    maxPages: opts.maxPages,
  });
  const rows: DiscoveredRow[] = events
    // Meetings only — all-day events have no dateTime.
    .filter((e) => e.start?.dateTime)
    .map(rowOfEvent)
    .filter((r) => !opts.meetOnly || r.event.conferenceData?.conferenceId || r.teamsUrl);

  // Records over the window, joined ONLY by exact meeting code (+ nearest
  // start within the lookup window). No time-overlap guessing: a moved
  // calendar event once matched a neighbouring slot's record and imported a
  // completely different meeting's transcript.
  let meetChecked = false;
  const records = await listConferenceRecords(
    token,
    `start_time >= "${opts.from}" AND start_time <= "${opts.to}"`,
    3
  );
  if (records) {
    meetChecked = true;
    const byRecord = new Map<string, { code: string | null; ev: RecordEvidence }>();
    for (let i = 0; i < records.length; i += MEET_BATCH) {
      const batch = records.slice(i, i + MEET_BATCH);
      const results = await Promise.all(
        batch.map(async (r) => {
          const [code, ev] = await Promise.all([
            r.space ? getSpaceMeetingCode(token, r.space) : Promise.resolve(null),
            probeRecordEvidence(token, r.name),
          ]);
          return { rec: r, code, ev };
        })
      );
      for (const x of results) byRecord.set(x.rec.name, { code: x.code, ev: x.ev });
    }
    const extras: DiscoveredRow[] = [];
    const cacheKeys: string[] = [];
    const pending: Array<{ rec: ConferenceRecordLite; code: string; target: DiscoveredRow | null; ev: RecordEvidence }> = [];
    for (const rec of records) {
      const { code, ev } = byRecord.get(rec.name)!;
      const candidates = code
        ? rows.filter(
            (row) =>
              row.event.conferenceData?.conferenceId === code &&
              recordMatchesOccurrence(rec.startTime, row.event.start?.dateTime)
          )
        : [];
      let target: DiscoveredRow | null = null;
      if (candidates.length > 0) {
        const t = Date.parse(rec.startTime ?? '');
        target = candidates.reduce((best, row) => {
          const d = Math.abs(Date.parse(row.event.start?.dateTime ?? '') - t);
          const bd = Math.abs(Date.parse(best.event.start?.dateTime ?? '') - t);
          return d < bd ? row : best;
        });
      }
      if (target) {
        // Re-fold the event's attachments: an attached video/Doc counts as
        // evidence even when the record's own listing is thin.
        const att = classifyCalendarAttachments(target.event.attachments);
        const recording = classifyRecordings(ev.artifacts.recordings, att);
        const transcript = classifyTranscripts({
          docIds: ev.artifacts.transcriptDocIds,
          listed: ev.artifacts.transcriptsListed,
          attachments: att,
        });
        const folded: RecordEvidence = {
          ...ev,
          recording,
          transcript,
          verdict: classifyEvidence({ recording, transcript }),
        };
        // Keep the earliest-found artifacts; later records of the same code
        // on the same day (stop/restart) only OR the pending flags in.
        const info = meetInfoOf(folded);
        target.meet = target.meet
          ? {
              ...target.meet,
              videoFileId: target.meet.videoFileId ?? info.videoFileId,
              transcriptDocId: target.meet.transcriptDocId ?? info.transcriptDocId,
              videoPending: target.meet.videoPending || info.videoPending,
              transcriptPending: target.meet.transcriptPending || info.transcriptPending,
              checked: target.meet.checked && info.checked,
            }
          : info;
        if (code) {
          pending.push({ rec, code, target, ev: folded });
          cacheKeys.push(cacheKeyOf(code, target.event.start?.dateTime ?? null));
        }
      } else {
        extras.push(rowOfRecord(rec, code, meetInfoOf(ev)));
        if (code && rec.startTime) {
          pending.push({ rec, code, target: null, ev });
          cacheKeys.push(cacheKeyOf(code, rec.startTime));
        }
      }
    }
    rows.push(...extras);
    // Past Meet events that matched no record but carry calendar attachments
    // (the Gemini-notes Doc, an attached video) are evidence too — the
    // poller persists exactly these (D1); the day view must not fall short
    // of it for days outside the poller's window.
    const nowMs = Date.now();
    for (const row of rows) {
      const code = row.event.conferenceData?.conferenceId ?? null;
      if (!code || row.meet || row.offCalendar || row.teamsUrl) continue;
      const end = Date.parse(row.event.end?.dateTime ?? row.event.start?.dateTime ?? '');
      if (Number.isNaN(end) || end > nowMs) continue;
      const att = classifyCalendarAttachments(row.event.attachments);
      if (!att.videoFileId && !att.transcriptDocId) continue;
      const recording = classifyRecordings([], att);
      const transcript = classifyTranscripts({ docIds: [], listed: 0, attachments: att });
      pending.push({
        rec: { name: '' },
        code,
        target: row,
        ev: {
          recordName: '',
          recording,
          transcript,
          verdict: classifyEvidence({ recording, transcript }),
          checkFailed: false,
          artifacts: EMPTY_ARTIFACTS,
        },
      });
      cacheKeys.push(cacheKeyOf(code, row.event.start?.dateTime ?? null));
    }
    // Write back everything the sweep learned (the whole point of Phase 2 —
    // a dialog visit feeds the listing and the poller). Best-effort and
    // DETACHED: the rows already carry the evidence; the gap-fill (Drive
    // meta, Doc parse) must not hold the dialog's spinner.
    void (async () => {
    try {
      const existing = await getMeetingCacheByKeys(cacheKeys);
      for (const p of pending) {
        const eventStart = p.target ? (p.target.event.start?.dateTime ?? null) : (p.rec.startTime ?? null);
        const key = cacheKeyOf(p.code, eventStart);
        // Feed each write back so a same-day stop/restart (several records,
        // one occurrence) takes the no-op path instead of "last record wins".
        const row = await persistMeetingEvidence(token, {
          userId,
          meetingCode: p.code,
          eventStart,
          recordName: p.rec.name || null,
          recording: p.ev.recording,
          transcript: p.ev.transcript,
          artifacts: p.ev.artifacts,
          attachments: p.target ? classifyCalendarAttachments(p.target.event.attachments) : null,
          event: p.target
            ? {
                recurringEventId: p.target.event.recurringEventId ?? null,
                iCalUID: p.target.event.iCalUID ?? null,
                organizerEmail: p.target.event.organizer?.email ?? null,
              }
            : null,
          // undefined = let the service find the occurrence's row (±12h).
          existing: existing.get(key) ?? undefined,
        });
        if (row) existing.set(key, row);
      }
    } catch (err) {
      console.warn('[discovery] window write-back failed:', err);
    }
    })();
  }

  rows.sort((a, b) =>
    (a.event.start?.dateTime ?? '').localeCompare(b.event.start?.dateTime ?? '')
  );
  return { rows, meetChecked };
}

/**
 * Meet-API-only listings: the last N days of conferences the user was in
 * ("Recent 30d"), or every record for a pasted code. Artifacts are NOT
 * inventoried here (checked:false) — the evidence route resolves a row on
 * pick, exactly as the dialog always did.
 */
export async function listMeetRecordRows(
  token: string,
  query: { fromIso: string } | { code: string }
): Promise<DiscoveredRow[] | null> {
  const filter =
    'code' in query ? `space.meeting_code = "${query.code}"` : `start_time >= "${query.fromIso}"`;
  const records = await listConferenceRecords(token, filter, 3);
  if (!records) return null;
  records.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
  // Resolve each record's meeting code (spaces.get) — the evidence probe,
  // the "in archive" marks and the import body all key on it.
  const codeByRecord = new Map<string, string | null>();
  if ('fromIso' in query) {
    for (let i = 0; i < records.length; i += MEET_BATCH) {
      const batch = records.slice(i, i + MEET_BATCH);
      const codes = await Promise.all(
        batch.map((r) => (r.space ? getSpaceMeetingCode(token, r.space) : Promise.resolve(null)))
      );
      batch.forEach((r, j) => codeByRecord.set(r.name, codes[j] ?? null));
    }
  }
  // Labels carry no time — the client renders the start in ITS timezone.
  return records.map((r) => {
    const code = 'code' in query ? query.code : (codeByRecord.get(r.name) ?? null);
    return rowOfRecord(
      r,
      code,
      {
        recordName: r.name,
        videoFileId: null,
        transcriptDocId: null,
        videoPending: false,
        transcriptPending: false,
        checked: false,
      },
      code ?? 'Meet'
    );
  });
}
