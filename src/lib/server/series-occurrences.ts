import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import {
  GraphApiError,
  isGraphConfigured,
  listRecordings,
  listTranscripts,
  resolveMeetingByJoinUrl,
} from '@/lib/server/ms-graph';
import { parseTeamsJoinLink, pickOccurrenceArtifacts } from '@/lib/teams-link';
import { listConferenceRecordsByCode, listRecordArtifacts } from '@/lib/server/gmeet';
import { listKeys, getSeries } from '@/db-ops/series';
import { recurringBaseId } from '@/lib/series-keys';
import type { GmeetAttendee } from '@/lib/format';

/**
 * Live occurrence sweep for a series — every instance we can see, including
 * artifact-less ones, merged from two sources:
 *
 *  - Google Calendar (caller's server-minted token): title search filtered
 *    by conferenceId / recurringEventId base, plus iCalUID lookups. Titles
 *    alone are ambiguous and recurringEventIds get re-sliced on "this and
 *    following" edits (verified: one series → 6 variants), hence the
 *    belt-and-suspenders union. Attachments ride the user's own event copy
 *    and never expire — this is what sees months-old recordings.
 *  - Google Meet REST API (caller's token): conferenceRecords filtered by
 *    the series' meeting code(s) — every call Google still holds (~30 days)
 *    with its recording/transcript inventory. This is what the import
 *    dialog uses too, and it sees artifacts the calendar copy does NOT
 *    carry: Meet attaches files to the event only for some attendees
 *    (verified 2026-08-21: DevOps Scrum, 112 calendar instances, 1 with an
 *    attachment, while Meet listed transcripts for the recent occurrences).
 *  - Microsoft Graph (Teams series): the series meeting object lists every
 *    occurrence's transcript/recording keyed by callId — including
 *    occurrences from before the caller was invited (verified: calendar saw
 *    5 instances, Graph had 11).
 *
 * Occurrences are ephemeral — computed here, never mirrored into the DB.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const CAL_API = 'https://www.googleapis.com/calendar/v3';
/** How far back the calendar sweep looks. */
const SWEEP_MONTHS_BACK = 12;
/** Include near-future instances so the dialog shows what's coming. */
const SWEEP_DAYS_FORWARD = 45;
/** External sweep results (calendar + Graph) are cached per series+user;
 * the refresh button forces past this. Only the expensive skeleton is
 * cached — imported cross-references are recomputed on every request. */
const SWEEP_TTL_MS = 6 * 3600_000;

interface SweepCacheEntry {
  at: number;
  googleConnected: boolean;
  meetChecked: boolean;
  graphChecked: boolean;
  occurrences: SeriesOccurrence[];
}

declare global {
  var __mwSeriesSweepCache: Map<string, SweepCacheEntry> | undefined;
}
const sweepCache: Map<string, SweepCacheEntry> =
  globalThis.__mwSeriesSweepCache ?? (globalThis.__mwSeriesSweepCache = new Map());

interface CalInstance {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  recurringEventId?: string;
  iCalUID?: string;
  organizer?: { email?: string };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  attachments?: Array<{ fileId?: string; title?: string; mimeType?: string }>;
  conferenceData?: { conferenceId?: string };
}

export interface OccurrenceImportedRef {
  assemblyai_id: string;
  title: string | null;
  accessible: boolean;
}

export interface SeriesOccurrence {
  /** Stable within one response: calendar instance id, else teams callId. */
  key: string;
  startIso: string;
  endIso: string | null;
  title: string | null;
  /** 'meet' = a Meet conference record no calendar instance matched (the
   * caller's calendar copy is gone or they were never on that instance);
   * 'imported' = a member transcript no calendar/Graph/Meet occurrence
   * matched (caller isn't on the event, outside the sweep window, or an
   * upload). */
  source: 'calendar' | 'graph' | 'both' | 'meet' | 'imported';
  upcoming: boolean;
  meetingCode: string | null;
  eventId: string | null;
  recurringEventId: string | null;
  iCalUID: string | null;
  organizerEmail: string | null;
  attendees: GmeetAttendee[];
  hasRecording: boolean;
  hasTranscript: boolean;
  videoFileId: string | null;
  transcriptDocId: string | null;
  /** transcriptDocId is a "Notes by Gemini" Doc (transcript lives in its
   * Transcript tab) rather than a classic transcript Doc. */
  geminiNotes: boolean;
  teams: { joinWebUrl: string; callId: string | null } | null;
  /** Google Meet conference record that backs this occurrence (Meet API
   * side). `*Pending` = Google lists the artifact but the file isn't
   * generated yet — still importable (the import defers until it lands). */
  meet: {
    recordName: string;
    videoPending: boolean;
    transcriptPending: boolean;
  } | null;
  /** Google Calendar "open event" link (calendar-sourced occurrences). */
  calendarUrl: string | null;
  imported: OccurrenceImportedRef[];
}

export interface SeriesOccurrencesResult {
  seriesId: number;
  seriesTitle: string;
  googleConnected: boolean;
  /** The Meet REST API conferenceRecords pass ran (needs Google + a
   * meeting-code key). */
  meetChecked: boolean;
  graphChecked: boolean;
  /** When the external sweep actually ran (cache timestamp). */
  sweptAt: string;
  fromCache: boolean;
  occurrences: SeriesOccurrence[];
  counts: {
    total: number;
    imported: number;
    importable: number;
    bare: number;
    upcoming: number;
    /** Occurrences the calendar/Graph sweep actually saw (excludes the
     * member-only 'imported' rows) — 0 with members present means "this
     * meeting isn't on the caller's calendar". */
    external: number;
  };
}

const FIELDS =
  'items(id,status,summary,htmlLink,recurringEventId,iCalUID,organizer(email),start,end,' +
  'attendees(email,displayName,responseStatus),attachments(fileId,title,mimeType),' +
  'conferenceData(conferenceId)),nextPageToken';

async function calList(token: string, params: URLSearchParams): Promise<CalInstance[]> {
  const out: CalInstance[] = [];
  let pageToken: string | undefined;
  for (let p = 0; p < 8; p++) {
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${CAL_API}/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return out;
    const j = (await res.json()) as { items?: CalInstance[]; nextPageToken?: string };
    out.push(...(j.items ?? []));
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/** Artifact classification — same rules as the import dialog: a classic
 * "… - Transcript" Doc wins; otherwise a "Notes by Gemini" Doc counts as the
 * transcript source (Gemini keeps the transcript in that Doc's "Transcript"
 * tab, which the import extracts). Series that run Gemini notes instead of
 * plain transcription only ever get the Gemini Doc attached — verified
 * 2026-08-21 on DevOps Scrum (the Meet API's own transcript docId IS the
 * Gemini Doc). Other docs (agendas, "Notes - <title>") are ignored. */
function classifyAttachments(e: CalInstance): {
  videoFileId: string | null;
  transcriptDocId: string | null;
  geminiNotes: boolean;
} {
  const atts = e.attachments ?? [];
  const video = atts.find((a) => /^video\//.test(a.mimeType ?? ''));
  const docs = atts.filter((a) => a.mimeType === 'application/vnd.google-apps.document' && a.fileId);
  const transcriptDoc = docs.find((a) => /transcript\s*$/i.test(a.title ?? ''));
  const geminiDoc = docs.find((a) => /gemini/i.test(a.title ?? ''));
  const doc = transcriptDoc ?? geminiDoc ?? null;
  return {
    videoFileId: video?.fileId ?? null,
    transcriptDocId: doc?.fileId ?? null,
    geminiNotes: !transcriptDoc && Boolean(geminiDoc),
  };
}

interface ImportedRow {
  id: number;
  assemblyai_id: string;
  title: string | null;
  recorded_at: string | null;
  created_at: string;
  drive_file_id: string | null;
  event_id: string | null;
  transcript_doc_id: string | null;
  video_file_id: string | null;
  teams_call_id: string | null;
  meeting_code: string | null;
  accessible: boolean;
  is_member: boolean;
}

/** Everything imported that could belong to this series: members plus rows
 * matching any series key. Fetched once, matched to occurrences in JS. */
async function loadImportedCandidates(
  seriesId: number,
  caller: { userId: string; email: string }
): Promise<ImportedRow[]> {
  const normEmail = caller.email.trim().toLowerCase();
  return sql<ImportedRow[]>`
    SELECT DISTINCT t.id, t.assemblyai_id, t.title,
           t.recorded_at::text AS recorded_at, t.created_at::text AS created_at,
           t.drive_file_id,
           t.gmeet_context->>'eventId' AS event_id,
           t.gmeet_context->>'transcriptDocId' AS transcript_doc_id,
           t.gmeet_context->>'videoFileId' AS video_file_id,
           t.gmeet_context->'teams'->>'callId' AS teams_call_id,
           t.gmeet_context->>'meetingCode' AS meeting_code,
           (t.user_id = ${caller.userId} OR sh.id IS NOT NULL) AS accessible,
           COALESCE(m.series_id = ${seriesId}, false) AS is_member
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.series_members m ON m.transcript_id = t.id
    LEFT JOIN ${sql(SCHEMA)}.series_keys k ON k.series_id = ${seriesId} AND (
      (k.kind = 'meeting-code' AND t.gmeet_context->>'meetingCode' = k.value) OR
      (k.kind = 'recurring-base-id' AND
       regexp_replace(COALESCE(t.gmeet_context->>'recurringEventId',''), '_R\\d{8}T\\d{6}Z?$', '') = k.value) OR
      (k.kind = 'teams-join-url' AND t.gmeet_context->'teams'->>'joinWebUrl' = k.value) OR
      (k.kind = 'graph-meeting-id' AND t.gmeet_context->'teams'->>'graphMeetingId' = k.value)
    )
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares sh
      ON sh.transcript_id = t.id AND sh.shared_with_email = ${normEmail}
    WHERE t.deleted_at IS NULL
      AND (m.series_id = ${seriesId} OR k.id IS NOT NULL)
  `;
}

const DAY_MS = 86_400_000;
/** Meet artifact lookups per parallel batch (2 API calls each). */
const MEET_BATCH = 6;

function matchImported(
  occ: SeriesOccurrence,
  candidates: ImportedRow[]
): OccurrenceImportedRef[] {
  const occStart = Date.parse(occ.startIso);
  return candidates
    .filter((c) => {
      if (occ.eventId && c.event_id && c.event_id === occ.eventId) return true;
      if (occ.videoFileId && (c.drive_file_id === occ.videoFileId || c.video_file_id === occ.videoFileId)) return true;
      if (occ.transcriptDocId && c.transcript_doc_id === occ.transcriptDocId) return true;
      if (occ.teams?.callId && c.teams_call_id === occ.teams.callId) return true;
      // Same meeting code + within half a day = same occurrence (the
      // /api/gmeet/check ±12h convention; timezone strings vary per user).
      const when = c.recorded_at ?? c.created_at;
      if (
        occ.meetingCode &&
        c.meeting_code === occ.meetingCode &&
        when &&
        Math.abs(Date.parse(when) - occStart) < DAY_MS / 2
      ) {
        return true;
      }
      return false;
    })
    .map((c) => ({ assemblyai_id: c.assemblyai_id, title: c.title, accessible: c.accessible }));
}

export async function sweepSeriesOccurrences(
  seriesId: number,
  caller: { userId: string; email: string },
  opts: { forceRefresh?: boolean } = {}
): Promise<SeriesOccurrencesResult | null> {
  const series = await getSeries(seriesId);
  if (!series) return null;

  // Serve the external skeleton from cache when it's warm — the DB
  // cross-reference below always runs fresh, so an import made from the
  // dialog shows as imported on the very next (instant) refresh.
  const cacheKey = `${seriesId}:${caller.userId}`;
  let entry = sweepCache.get(cacheKey);
  const stale = opts.forceRefresh || !entry || Date.now() - entry.at > SWEEP_TTL_MS;
  if (stale) {
    entry = {
      at: Date.now(),
      ...(await computeSweepSkeleton(series.title, seriesId, caller)),
    };
    sweepCache.set(cacheKey, entry);
  }

  const candidates = await loadImportedCandidates(seriesId, caller);
  const nowMs = Date.now();
  const occurrences: SeriesOccurrence[] = entry!.occurrences.map((o) => ({
    ...o,
    // recomputed at serve time — a cached "upcoming" may have happened since
    upcoming: Date.parse(o.startIso) > nowMs,
    imported: [],
  }));
  for (const occ of occurrences) occ.imported = matchImported(occ, candidates);
  const external = occurrences.length;

  // Members no external occurrence claimed still ARE occurrences of this
  // series (the caller may simply not be on the calendar event — e.g. a
  // colleague's import in a series they were never invited to). Fold them
  // in so the list and counts agree with "N meetings in this series".
  const linked = new Set(occurrences.flatMap((o) => o.imported.map((i) => i.assemblyai_id)));
  for (const c of candidates) {
    if (!c.is_member || linked.has(c.assemblyai_id)) continue;
    linked.add(c.assemblyai_id);
    const startIso = new Date(c.recorded_at ?? c.created_at).toISOString();
    occurrences.push({
      key: `imp-${c.assemblyai_id}`,
      startIso,
      endIso: null,
      title: c.title,
      source: 'imported',
      upcoming: false,
      meetingCode: c.meeting_code,
      eventId: c.event_id,
      recurringEventId: null,
      iCalUID: null,
      organizerEmail: null,
      attendees: [],
      hasRecording: Boolean(c.drive_file_id || c.video_file_id),
      hasTranscript: Boolean(c.transcript_doc_id),
      videoFileId: c.video_file_id ?? c.drive_file_id,
      transcriptDocId: c.transcript_doc_id,
      geminiNotes: false,
      teams: null,
      meet: null,
      calendarUrl: null,
      imported: [{ assemblyai_id: c.assemblyai_id, title: c.title, accessible: c.accessible }],
    });
  }
  occurrences.sort((a, b) => Date.parse(b.startIso) - Date.parse(a.startIso));

  const past = occurrences.filter((o) => !o.upcoming);
  const counts = {
    external,
    total: occurrences.length,
    imported: past.filter((o) => o.imported.length > 0).length,
    importable: past.filter((o) => o.imported.length === 0 && (o.hasRecording || o.hasTranscript))
      .length,
    bare: past.filter((o) => o.imported.length === 0 && !o.hasRecording && !o.hasTranscript).length,
    upcoming: occurrences.filter((o) => o.upcoming).length,
  };

  return {
    seriesId,
    seriesTitle: series.title,
    googleConnected: entry!.googleConnected,
    meetChecked: entry!.meetChecked,
    graphChecked: entry!.graphChecked,
    sweptAt: new Date(entry!.at).toISOString(),
    fromCache: !stale,
    occurrences,
    counts,
  };
}

/** The expensive external enumeration: calendar pages + Graph artifacts. */
async function computeSweepSkeleton(
  seriesTitle: string,
  seriesId: number,
  caller: { userId: string; email: string }
): Promise<{
  googleConnected: boolean;
  meetChecked: boolean;
  graphChecked: boolean;
  occurrences: SeriesOccurrence[];
}> {
  const keys = await listKeys(seriesId);
  const byKind = (kind: string) => keys.filter((k) => k.kind === kind).map((k) => k.value);
  const codes = new Set(byKind('meeting-code'));
  const bases = new Set([...byKind('recurring-base-id'), ...byKind('ical-uid-base')]);
  const joinUrls = byKind('teams-join-url');
  const graphMeetingIds = byKind('graph-meeting-id');

  const timeMin = new Date(Date.now() - SWEEP_MONTHS_BACK * 30 * DAY_MS).toISOString();
  const timeMax = new Date(Date.now() + SWEEP_DAYS_FORWARD * DAY_MS).toISOString();
  const nowMs = Date.now();

  // ---- Google Calendar side ----------------------------------------------
  const minted = await getServerAccessToken(caller.userId).catch(() => null);
  const googleConnected = Boolean(minted);
  const instances = new Map<string, CalInstance>();
  if (minted) {
    const queries: URLSearchParams[] = [];
    queries.push(
      new URLSearchParams({
        q: seriesTitle,
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        fields: FIELDS,
      })
    );
    for (const base of bases) {
      queries.push(
        new URLSearchParams({
          iCalUID: `${base}@google.com`,
          timeMin,
          timeMax,
          singleEvents: 'true',
          maxResults: '250',
          fields: FIELDS,
        })
      );
    }
    const results = await Promise.all(queries.map((p) => calList(minted.token, p)));
    for (const item of results.flat()) {
      if (!item.id || item.status === 'cancelled') continue;
      const matchesSeries =
        (item.conferenceData?.conferenceId && codes.has(item.conferenceData.conferenceId)) ||
        (item.recurringEventId && bases.has(recurringBaseId(item.recurringEventId))) ||
        (item.iCalUID && bases.has(recurringBaseId(item.iCalUID.replace(/@google\.com$/i, ''))));
      if (!matchesSeries) continue;
      instances.set(item.id, item);
    }
  }

  const occurrences: SeriesOccurrence[] = [];
  for (const inst of instances.values()) {
    const startIso = inst.start?.dateTime ?? inst.start?.date;
    if (!startIso) continue;
    const { videoFileId, transcriptDocId, geminiNotes } = classifyAttachments(inst);
    occurrences.push({
      key: inst.id!,
      startIso,
      endIso: inst.end?.dateTime ?? inst.end?.date ?? null,
      title: inst.summary ?? null,
      source: 'calendar',
      upcoming: Date.parse(startIso) > nowMs,
      meetingCode: inst.conferenceData?.conferenceId ?? null,
      eventId: inst.id!,
      recurringEventId: inst.recurringEventId ?? null,
      iCalUID: inst.iCalUID ?? null,
      organizerEmail: inst.organizer?.email ?? null,
      attendees: (inst.attendees ?? [])
        .filter((a) => a.email)
        .map((a) => ({ email: a.email!, name: a.displayName, responseStatus: a.responseStatus })),
      hasRecording: Boolean(videoFileId),
      hasTranscript: Boolean(transcriptDocId),
      videoFileId,
      transcriptDocId,
      geminiNotes,
      teams: null,
      meet: null,
      calendarUrl: inst.htmlLink ?? null,
      imported: [],
    });
  }

  // ---- Google Meet REST API side (conference records per meeting code) ----
  // Calendar attachments are per-copy and frequently absent on the caller's
  // event; Meet's own record of each call is authoritative for "was this
  // recorded / transcribed". Enrich matching calendar instances, surface
  // the rest as Meet-only occurrences. Records not recorded at all add no
  // occurrence (the calendar already lists the instance as bare).
  let meetChecked = false;
  if (minted && codes.size > 0) {
    for (const code of codes) {
      const records = await listConferenceRecordsByCode(minted.token, code);
      if (records.length === 0) continue;
      meetChecked = true;
      const sameCode = occurrences.filter((o) => o.meetingCode === code && !o.teams);
      // Artifacts in small parallel batches — two calls per record.
      for (let i = 0; i < records.length; i += MEET_BATCH) {
        const batch = records.slice(i, i + MEET_BATCH);
        const inventories = await Promise.all(
          batch.map((r) => listRecordArtifacts(minted.token, r.name))
        );
        batch.forEach((rec, j) => {
          const inv = inventories[j]!;
          if (!rec.startTime) return;
          const hasRec = inv.recordings.length > 0;
          const hasTr = inv.transcriptsListed > 0;
          if (!hasRec && !hasTr) return;
          const fileId = inv.recordings.find((r) => r.fileId)?.fileId ?? null;
          const docId = inv.transcriptDocIds[0] ?? null;
          const meet = {
            recordName: rec.name,
            videoPending: hasRec && !fileId,
            transcriptPending: hasTr && !docId,
          };
          const recStart = Date.parse(rec.startTime);
          // Nearest calendar instance of the same code within half a day
          // (the /api/gmeet/check ±12h convention — codes are reused across
          // the series, so time is the only disambiguator).
          let best: SeriesOccurrence | null = null;
          let bestDelta = DAY_MS / 2;
          for (const o of sameCode) {
            const delta = Math.abs(Date.parse(o.startIso) - recStart);
            if (delta < bestDelta) {
              bestDelta = delta;
              best = o;
            }
          }
          if (best) {
            best.hasRecording = best.hasRecording || hasRec;
            best.hasTranscript = best.hasTranscript || hasTr;
            best.videoFileId = best.videoFileId ?? fileId;
            best.transcriptDocId = best.transcriptDocId ?? docId;
            // Earliest record wins for a same-day stop/restart; keep the
            // first recordName, OR the pending flags.
            best.meet = best.meet
              ? {
                  recordName: best.meet.recordName,
                  videoPending: best.meet.videoPending || meet.videoPending,
                  transcriptPending: best.meet.transcriptPending || meet.transcriptPending,
                }
              : meet;
            return;
          }
          occurrences.push({
            key: `meet-${rec.name.replace(/^conferenceRecords\//, '')}`,
            startIso: rec.startTime,
            endIso: rec.endTime ?? null,
            title: seriesTitle,
            source: 'meet',
            upcoming: false,
            meetingCode: code,
            eventId: null,
            recurringEventId: null,
            iCalUID: null,
            organizerEmail: null,
            attendees: [],
            hasRecording: hasRec,
            hasTranscript: hasTr,
            videoFileId: fileId,
            transcriptDocId: docId,
            geminiNotes: false,
            teams: null,
            meet,
            calendarUrl: null,
            imported: [],
          });
        });
      }
    }
  }

  // ---- Microsoft Graph side (Teams series) --------------------------------
  let graphChecked = false;
  if (isGraphConfigured() && (joinUrls.length > 0 || graphMeetingIds.length > 0)) {
    for (const rawUrl of joinUrls) {
      const info = parseTeamsJoinLink(rawUrl);
      if (!info) continue;
      try {
        const meeting = await resolveMeetingByJoinUrl(info.organizerOid, info.joinWebUrl);
        if (!meeting) continue;
        graphChecked = true;
        const [gTr, gRec] = await Promise.all([
          listTranscripts(info.organizerOid, meeting.id),
          listRecordings(info.organizerOid, meeting.id),
        ]);
        // Attach artifacts to matching calendar instances first…
        const claimed = new Set<string>();
        for (const occ of occurrences) {
          if (!occ.endIso) continue;
          const picked = pickOccurrenceArtifacts(gTr, gRec, occ.startIso, occ.endIso);
          const callId = picked.transcript?.callId ?? picked.recording?.callId ?? null;
          if (!callId) continue;
          claimed.add(callId);
          occ.source = 'both';
          occ.hasTranscript = occ.hasTranscript || Boolean(picked.transcript);
          occ.hasRecording = occ.hasRecording || Boolean(picked.recording);
          occ.teams = { joinWebUrl: info.joinWebUrl, callId };
        }
        // …then surface Graph-only occurrences (before the caller was
        // invited, or the calendar copy is gone).
        const leftovers = new Map<string, { start?: string; end?: string; tr: boolean; rec: boolean }>();
        for (const t of gTr) {
          if (!t.callId || claimed.has(t.callId)) continue;
          const cur = leftovers.get(t.callId) ?? { tr: false, rec: false };
          cur.tr = true;
          cur.start = cur.start ?? t.createdDateTime;
          cur.end = t.endDateTime ?? cur.end;
          leftovers.set(t.callId, cur);
        }
        for (const r of gRec) {
          if (!r.callId || claimed.has(r.callId)) continue;
          const cur = leftovers.get(r.callId) ?? { tr: false, rec: false };
          cur.rec = true;
          cur.start = cur.start ?? r.createdDateTime;
          cur.end = r.endDateTime ?? cur.end;
          leftovers.set(r.callId, cur);
        }
        for (const [callId, l] of leftovers) {
          if (!l.start) continue;
          occurrences.push({
            key: `call-${callId}`,
            startIso: l.start,
            endIso: l.end ?? null,
            title: seriesTitle,
            source: 'graph',
            upcoming: false,
            meetingCode: null,
            eventId: null,
            recurringEventId: null,
            iCalUID: null,
            organizerEmail: null,
            attendees: [],
            hasRecording: l.rec,
            hasTranscript: l.tr,
            videoFileId: null,
            transcriptDocId: null,
            geminiNotes: false,
            teams: { joinWebUrl: info.joinWebUrl, callId },
            meet: null,
            calendarUrl: null,
            imported: [],
          });
        }
      } catch (err) {
        if (err instanceof GraphApiError) {
          console.warn('[series] Graph sweep failed (continuing with calendar):', err.message);
        } else {
          throw err;
        }
      }
    }
  }

  return { googleConnected, meetChecked, graphChecked, occurrences };
}
