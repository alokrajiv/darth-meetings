import 'server-only';
import {
  classifyRecordings,
  classifyTranscripts,
  OCCURRENCE_WINDOW_MS,
} from '@/lib/meeting-evidence';
import {
  getMeetingCacheByKeys,
  getMeetingCacheByMeetings,
  getTeamsJoinUrlByMeeting,
  type GmeetMeetingCacheRow,
} from '@/db-ops/gmeet-meeting-cache';
import {
  cacheKeyOf,
  persistMeetingEvidence,
  probeMeetingEvidence,
  probeRecordEvidence,
} from '@/lib/server/meeting-discovery';
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
import { listConferenceRecordsByCode } from '@/lib/server/gmeet';
import { getSeries } from '@/db-ops/series';
import { listEmptyTranscriptDocIds } from '@/db-ops/empty-transcripts';
import { listOwnCalendarRows, type OwnCalendarRow } from '@/db-ops/calendar-event-cache';
import { loadCuratedSeries } from '@/lib/server/curated-series';
import { factsFromCalendarRow, pickSeries } from '@/lib/series-patterns';
import { importedOccurrenceMatches } from '@/lib/imported-occurrence';
import type { GmeetAttendee } from '@/lib/format';

/**
 * Live occurrence sweep for a series — every instance we can see, including
 * artifact-less ones, merged from two sources:
 *
 *  - The caller's OWN calendar, as the poller cached it
 *    (calendar_event_cache, `user_id = caller`): every row whose facts the
 *    curated matcher gives to THIS series (lib/series-patterns — the same
 *    winner rule membership uses, so an import of the occurrence joins this
 *    series). Curated series, 2026-10-06 (docs/curated-series-spec.md §7):
 *    this replaced the live Calendar `q=title` search filtered by the old
 *    evidence keys. Attachments ride the user's own event copy and never
 *    expire — the cache keeps them classified — so months-old recordings
 *    are still seen. Own-calendar rows only: the own-token rule stands.
 *  - Google Meet REST API (caller's token): conferenceRecords filtered by
 *    the meeting codes of the matched calendar rows — every call Google
 *    still holds (~30 days)
 *    with its recording/transcript inventory. This is what the import
 *    dialog uses too, and it sees artifacts the calendar copy does NOT
 *    carry: Meet attaches files to the event only for some attendees
 *    (verified 2026-08-21: DevOps Scrum, 112 calendar instances, 1 with an
 *    attachment, while Meet listed transcripts for the recent occurrences).
 *  - Microsoft Graph (Teams series): the join URLs of the matched calendar
 *    rows' `teams-…` codes (the artifact cache's stashed resolution); the
 *    series meeting object lists every occurrence's transcript/recording
 *    keyed by callId — including occurrences from before the caller was
 *    invited (verified: calendar saw 5 instances, Graph had 11).
 *
 * Occurrences themselves are ephemeral (computed here, never mirrored), but
 * every Meet-record inventory the sweep performs IS written back to the
 * global artifact cache through the discovery service — so a series sweep
 * feeds the listing and the import dialog, and vice versa: at serve time the
 * skeleton is re-read against that cache (the poller re-probes −7d every 30
 * minutes) and recently-ended occurrences are re-probed live, so a meeting
 * that just finished no longer reads "bare" for six hours (D12).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
/** How far back the calendar sweep looks. */
const SWEEP_MONTHS_BACK = 12;
/** Include near-future instances so the dialog shows what's coming. */
const SWEEP_DAYS_FORWARD = 45;
/** External sweep results (calendar + Graph) are cached per series+user;
 * the refresh button forces past this. Only the expensive skeleton is
 * cached — imported cross-references are recomputed on every request. */
const SWEEP_TTL_MS = 6 * 3600_000;
/** Past occurrences younger than this may still be growing artifacts (or
 * have just ended) — re-probed live at serve time instead of trusting the
 * cached skeleton (D12). */
const LIVE_REFRESH_AGE_MS = 48 * 3600_000;
/** Don't re-probe more often than this per series+user (refresh-spam guard). */
const LIVE_REFRESH_MIN_GAP_MS = 5 * 60_000;
/** Cap on live probes per serve — each is 1–3 Meet API calls. */
const LIVE_REFRESH_MAX = 8;

interface SweepCacheEntry {
  at: number;
  /** Last live re-probe of recent occurrences (D12). */
  refreshedAt: number;
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

export interface OccurrenceImportedRef {
  assemblyai_id: string;
  title: string | null;
  accessible: boolean;
  /** A queued import (deferred/background placeholder) — the row exists but
   * the import hasn't run yet. Still "claimed": not importable again. */
  queued: boolean;
  /** The import failed for good (row is in 'error') — still claims the
   * occurrence; trash the row to retry. */
  failed: boolean;
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
  /** The transcript Doc is known to hold no speech (Google: "Transcription
   * ended after …", not enough conversation) — hasTranscript is forced false
   * so nothing offers it for import; the Doc link is kept for reference. */
  emptyTranscript: boolean;
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
    /** Subset of bare: the transcript Doc exists but holds no speech. */
    empty: number;
    upcoming: number;
    /** Occurrences the calendar/Graph sweep actually saw (excludes the
     * member-only 'imported' rows) — 0 with members present means "this
     * meeting isn't on the caller's calendar". */
    external: number;
  };
}

interface ImportedRow {
  id: number;
  assemblyai_id: string;
  title: string | null;
  recorded_at: string | null;
  created_at: string;
  /** Same COALESCE chain as the shared lookup. */
  occurrence_start: string | null;
  drive_file_id: string | null;
  event_id: string | null;
  transcript_doc_id: string | null;
  video_file_id: string | null;
  teams_call_id: string | null;
  meeting_code: string | null;
  status: string;
  accessible: boolean;
  is_member: boolean;
}

/** The series' members (spec §7: the imported cross-reference IS the
 * membership), with whether the CALLER can open each. Matched to
 * occurrences in JS. Inaccessible members still count as "imported" for an
 * occurrence on the caller's own calendar (so nothing re-imports it) but are
 * never folded in as rows of their own, and never carry a title or id out of
 * the sweep (see matchImported / the fold-in below). */
async function loadImportedCandidates(
  seriesId: number,
  caller: { userId: string; email: string }
): Promise<ImportedRow[]> {
  const normEmail = caller.email.trim().toLowerCase();
  return sql<ImportedRow[]>`
    SELECT t.id, t.assemblyai_id, t.title,
           t.recorded_at::text AS recorded_at, t.created_at::text AS created_at,
           COALESCE(
             t.gmeet_context->>'startTime',
             t.gmeet_context->'actuals'->>'conferenceStart',
             t.recorded_at::text
           ) AS occurrence_start,
           t.drive_file_id,
           t.gmeet_context->>'eventId' AS event_id,
           t.gmeet_context->>'transcriptDocId' AS transcript_doc_id,
           t.gmeet_context->>'videoFileId' AS video_file_id,
           t.gmeet_context->'teams'->>'callId' AS teams_call_id,
           t.gmeet_context->>'meetingCode' AS meeting_code,
           t.status,
           (t.user_id = ${caller.userId} OR EXISTS (
             SELECT 1 FROM ${sql(SCHEMA)}.transcript_shares sh
             WHERE sh.transcript_id = t.id AND sh.shared_with_email = ${normEmail}
           )) AS accessible,
           true AS is_member
    FROM ${sql(SCHEMA)}.series_members m
    JOIN ${sql(SCHEMA)}.transcripts t ON t.id = m.transcript_id
    WHERE m.series_id = ${seriesId}
      AND t.deleted_at IS NULL
      AND NOT t.scratch
  `;
}

const DAY_MS = 86_400_000;
/** Meet artifact lookups per parallel batch (2 API calls each). */
const MEET_BATCH = 6;

function matchImported(
  occ: SeriesOccurrence,
  candidates: ImportedRow[]
): OccurrenceImportedRef[] {
  // THE shared rule (lib/imported-occurrence): strong ids exact, meeting
  // code pinned by the ±12h window.
  return candidates
    .filter((c) =>
      importedOccurrenceMatches(
        {
          meeting_code: c.meeting_code,
          join_web_url: null,
          event_id: c.event_id,
          video_file_id: c.video_file_id,
          drive_file_id: c.drive_file_id,
          transcript_doc_id: c.transcript_doc_id,
          teams_call_id: c.teams_call_id,
          occurrence_start: c.occurrence_start ?? c.recorded_at ?? c.created_at,
        },
        {
          meetingCode: occ.meetingCode,
          eventId: occ.eventId,
          videoFileId: occ.videoFileId,
          transcriptDocId: occ.transcriptDocId,
          teamsCallId: occ.teams?.callId ?? null,
          startTime: occ.startIso,
        }
      )
    )
    .map((c) => ({
      // PRIVACY (spec §6): a meeting the caller cannot open is "imported by
      // someone" — no id, no title.
      assemblyai_id: c.accessible ? c.assemblyai_id : '',
      title: c.accessible ? c.title : null,
      accessible: c.accessible,
      queued: c.status === 'waiting',
      failed: c.status === 'error',
    }));
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
      refreshedAt: Date.now(),
      ...(await computeSweepSkeleton(series.title, seriesId, caller)),
    };
    sweepCache.set(cacheKey, entry);
  }

  const nowMs = Date.now();
  // Serve-time evidence refresh: fold the shared artifact cache in ALWAYS
  // (D8 — the poller's Doc-parse verdict must reach auto-import even on a
  // fresh skeleton), and live re-probe recently-ended occurrences when
  // serving a cached skeleton (D12). Mutates the cached entries in place so
  // the next serve starts from the better answer even before the 6h TTL.
  await refreshRecentEvidence(entry!, caller, nowMs, { live: !stale });

  const candidates = await loadImportedCandidates(seriesId, caller);
  const occurrences: SeriesOccurrence[] = entry!.occurrences.map((o) => ({
    ...o,
    // recomputed at serve time — a cached "upcoming" may have happened since
    upcoming: Date.parse(o.startIso) > nowMs,
    imported: [],
  }));
  for (const occ of occurrences) occ.imported = matchImported(occ, candidates);
  // Known-empty transcript Docs (ledger written by the import): not
  // importable, never were — read fresh so an "Import all" that just found
  // one flips the row on the very next refresh.
  const emptyDocs = await listEmptyTranscriptDocIds(
    occurrences.map((o) => o.transcriptDocId).filter((d): d is string => !!d)
  );
  for (const occ of occurrences) {
    if (occ.transcriptDocId && emptyDocs.has(occ.transcriptDocId)) {
      occ.emptyTranscript = true;
      occ.hasTranscript = false;
    }
  }
  const external = occurrences.length;

  // Members no external occurrence claimed still ARE occurrences of this
  // series (the caller may simply not be on the calendar event — e.g. a
  // colleague's import in a series they were never invited to). Fold them
  // in so the list and counts agree with "N meetings in this series".
  // Members the caller cannot open are never folded in (spec §6: members
  // are never listed beyond the caller's access).
  const linked = new Set(
    occurrences.flatMap((o) =>
      o.imported.filter((i) => i.accessible).map((i) => i.assemblyai_id)
    )
  );
  for (const c of candidates) {
    if (!c.is_member || !c.accessible || linked.has(c.assemblyai_id)) continue;
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
      emptyTranscript: false,
      teams: null,
      meet: null,
      calendarUrl: null,
      imported: [
        {
          assemblyai_id: c.assemblyai_id,
          title: c.title,
          accessible: true,
          queued: c.status === 'waiting',
          failed: c.status === 'error',
        },
      ],
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
    empty: past.filter((o) => o.imported.length === 0 && o.emptyTranscript).length,
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

/**
 * Fold a shared-cache row into an occurrence: ready evidence the skeleton
 * missed (the poller/dialog probed it since), and the Doc-parse verdict —
 * `transcript_parseable=false` means the Doc holds no speech, so the
 * occurrence is NOT importable as a transcript (D8: the dialog and the
 * listing already honoured this; the series sweep, "Import all" and
 * auto-import used to fire doomed imports at it).
 */
function applyCacheRow(occ: SeriesOccurrence, row: GmeetMeetingCacheRow): void {
  const hasRec = row.ready_recording_count > 0 || !!row.video_file_id;
  const docIds = row.transcript_doc_ids ?? [];
  if (hasRec) {
    occ.hasRecording = true;
    occ.videoFileId = occ.videoFileId ?? row.video_file_id;
  }
  if (docIds.length > 0 && row.transcript_parseable !== false) {
    const hadDoc = !!occ.transcriptDocId;
    occ.hasTranscript = true;
    occ.transcriptDocId = occ.transcriptDocId ?? docIds[0] ?? null;
    if (!hadDoc && row.transcript_source === 'gemini') occ.geminiNotes = true;
  }
  if (
    row.transcript_parseable === false &&
    (!occ.transcriptDocId || docIds.includes(occ.transcriptDocId))
  ) {
    occ.emptyTranscript = true;
    occ.hasTranscript = false;
  }
  if (row.conference_record && !occ.meet) {
    occ.meet = {
      recordName: row.conference_record,
      videoPending: row.recording_state === 'generating' || row.recording_state === 'partial',
      transcriptPending: row.transcript_state === 'generating',
    };
  }
}

/**
 * Serve-time refresh of the cached skeleton (D12): (1) re-read the shared
 * artifact cache for every Meet occurrence — cheap, and the poller re-probes
 * the last 7 days every 30 minutes; (2) for past occurrences that ended
 * within LIVE_REFRESH_AGE_MS and still look incomplete, probe Google live
 * (through the discovery service, which writes back). Never throws.
 */
async function refreshRecentEvidence(
  entry: SweepCacheEntry,
  caller: { userId: string; email: string },
  nowMs: number,
  opts: { live: boolean }
): Promise<void> {
  try {
    const meetOccs = entry.occurrences.filter((o) => o.meetingCode && !o.teams);
    if (meetOccs.length === 0) return;
    const rows = await getMeetingCacheByMeetings(
      meetOccs.map((o) => ({ code: o.meetingCode!, startTime: o.startIso }))
    );
    const rowOf = new Map<SeriesOccurrence, GmeetMeetingCacheRow>();
    meetOccs.forEach((o, i) => {
      const row = rows[i];
      if (row) {
        rowOf.set(o, row);
        applyCacheRow(o, row);
      }
    });

    if (!opts.live) return;
    if (nowMs - entry.refreshedAt < LIVE_REFRESH_MIN_GAP_MS) return;
    const minted = await getServerAccessToken(caller.userId).catch(() => null);
    if (!minted) return;
    const targets = meetOccs
      .filter((o) => {
        const start = Date.parse(o.startIso);
        if (start > nowMs) return false; // still upcoming
        if (nowMs - start > LIVE_REFRESH_AGE_MS) return false;
        const end = o.endIso ? Date.parse(o.endIso) : start;
        if (nowMs < end) return false; // in progress — nothing to inventory yet
        // Could still change: no evidence yet, or a listed-but-pending
        // artifact. A record already inventoried with nothing pending is
        // settled — don't re-ask Google every serve for a transcript-only
        // meeting that simply had recording off.
        if (o.meet && !o.meet.videoPending && !o.meet.transcriptPending) return false;
        return (
          !o.hasRecording ||
          !o.hasTranscript ||
          !!o.meet?.videoPending ||
          !!o.meet?.transcriptPending
        );
      })
      .sort((a, b) => Date.parse(b.startIso) - Date.parse(a.startIso))
      .slice(0, LIVE_REFRESH_MAX);
    entry.refreshedAt = nowMs;
    for (const o of targets) {
      const probe = await probeMeetingEvidence(minted.token, {
        userId: caller.userId,
        meetingCode: o.meetingCode!,
        eventStart: o.startIso,
        recordName: o.meet?.recordName ?? null,
        event: {
          recurringEventId: o.recurringEventId,
          iCalUID: o.iCalUID,
          organizerEmail: o.organizerEmail,
        },
        existing: rowOf.get(o) ?? undefined,
      });
      const { recording, transcript, verdict } = probe;
      if (verdict.hasRecording) {
        o.hasRecording = true;
        o.videoFileId = o.videoFileId ?? recording.fileIds[0] ?? null;
      }
      if (transcript.state === 'ready') {
        o.hasTranscript = true;
        o.transcriptDocId = o.transcriptDocId ?? transcript.docIds[0] ?? null;
      }
      if (probe.recordName) {
        o.meet = {
          recordName: probe.recordName,
          videoPending: recording.state === 'generating' || recording.state === 'partial',
          transcriptPending: transcript.state === 'generating',
        };
        // Same 24h aging as the listing: a fresh listed-but-generating
        // artifact still counts as importable (the import defers on it).
        const fresh = nowMs - Date.parse(o.startIso) < 24 * 3600_000;
        if (fresh && o.meet.videoPending) o.hasRecording = true;
        if (fresh && o.meet.transcriptPending) o.hasTranscript = true;
      }
      if (probe.row) applyCacheRow(o, probe.row);
    }
  } catch (err) {
    console.warn('[series] evidence refresh failed (serving cached skeleton):', err);
  }
}

/** One matched own-calendar row → an occurrence (attachments as the poller
 * classified them; a `teams-…` stamp is not a Meet code). */
function occurrenceFromCalendarRow(row: OwnCalendarRow, nowMs: number): SeriesOccurrence {
  const startIso = new Date(row.event_start).toISOString();
  const teamsRow = row.meeting_code?.startsWith('teams-') ?? false;
  return {
    key: row.event_id,
    startIso,
    endIso: row.event_end ? new Date(row.event_end).toISOString() : null,
    title: row.title,
    source: 'calendar',
    upcoming: Date.parse(startIso) > nowMs,
    meetingCode: teamsRow ? null : row.meeting_code,
    eventId: row.event_id,
    recurringEventId: row.recurring_event_id,
    iCalUID: row.ical_uid,
    organizerEmail: row.organizer_email,
    attendees: (row.attendees ?? [])
      .filter((a) => a?.email)
      .map((a) => ({ email: a.email, name: a.displayName, responseStatus: a.responseStatus })),
    hasRecording: Boolean(row.attachment_video_file_id),
    hasTranscript: Boolean(row.attachment_transcript_doc_id),
    videoFileId: row.attachment_video_file_id,
    transcriptDocId: row.attachment_transcript_doc_id,
    geminiNotes: row.attachment_gemini_notes,
    emptyTranscript: false,
    teams: null,
    meet: null,
    calendarUrl: row.html_link,
    imported: [],
  };
}

/** The classified-attachment shape the discovery write-back wants, rebuilt
 * from the cache columns (what classifyCalendarAttachments produced when the
 * poller cached the row). */
function attachmentsOf(row: OwnCalendarRow) {
  return {
    videoFileId: row.attachment_video_file_id,
    videoCount: row.attachment_video_count ?? 0,
    transcriptDocId: row.attachment_transcript_doc_id,
    geminiNotes: row.attachment_gemini_notes,
  };
}

/**
 * The expensive external enumeration (cached ~6h per series+user):
 *
 *  1. the caller's OWN calendar rows in the sweep window whose facts the
 *     curated matcher gives to this series (same winner rule as membership,
 *     so priority fights resolve identically everywhere);
 *  2. Meet conference records for those rows' codes — they ENRICH the
 *     matched rows only. A record no own-calendar row claims is dropped:
 *     Meet codes get reused (personal rooms), and "own-calendar rows only"
 *     (spec §7) means a call the caller was not invited to never becomes an
 *     occurrence — let alone an auto-import;
 *  3. Graph artifacts for the join URLs of the matched Teams rows (one join
 *     URL = one Teams meeting object, so its other occurrences ARE this
 *     meeting's).
 */
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
  const timeMin = new Date(Date.now() - SWEEP_MONTHS_BACK * 30 * DAY_MS).toISOString();
  const timeMax = new Date(Date.now() + SWEEP_DAYS_FORWARD * DAY_MS).toISOString();
  const nowMs = Date.now();

  // ---- the caller's own calendar, through the curated matcher -------------
  const minted = await getServerAccessToken(caller.userId).catch(() => null);
  const googleConnected = Boolean(minted);
  const [rows, allSeries] = await Promise.all([
    listOwnCalendarRows(caller.userId, timeMin, timeMax),
    loadCuratedSeries(),
  ]);
  const matched = rows.filter((r) => pickSeries(allSeries, factsFromCalendarRow(r))?.id === seriesId);
  // One occurrence per calendar instance (a re-keyed start leaves the newest).
  const byEvent = new Map<string, OwnCalendarRow>();
  for (const r of matched) byEvent.set(r.event_id, r);
  const rowOfEvent = new Map<string, OwnCalendarRow>(byEvent);

  const occurrences: SeriesOccurrence[] = [...byEvent.values()].map((r) =>
    occurrenceFromCalendarRow(r, nowMs)
  );
  const codes = new Set(
    [...byEvent.values()]
      .map((r) => r.meeting_code)
      .filter((c): c is string => !!c && !c.startsWith('teams-'))
  );
  // Teams: the canonical join URL a past probe stashed for each `teams-…`
  // code (gmeet_meeting_cache raw.teamsResolution) — keyed back to the
  // occurrences it belongs to, so Graph artifacts only land on them.
  const teamsOccs = new Map<string, SeriesOccurrence[]>();
  for (const r of byEvent.values()) {
    if (!r.meeting_code?.startsWith('teams-')) continue;
    const url = await getTeamsJoinUrlByMeeting(r.meeting_code, r.event_start).catch(() => null);
    if (!url) continue;
    const occ = occurrences.find((o) => o.eventId === r.event_id);
    if (occ) teamsOccs.set(url, [...(teamsOccs.get(url) ?? []), occ]);
  }
  const joinUrls = [...teamsOccs.keys()];

  // ---- Google Meet REST API side (conference records per meeting code) ----
  // Calendar attachments are per-copy and frequently absent on the caller's
  // event; Meet's own record of each call is authoritative for "was this
  // recorded / transcribed". It enriches the MATCHED calendar instances
  // only — a record none of them claims is not an occurrence of this series
  // (a reused code; see the function doc).
  let meetChecked = false;
  if (minted && codes.size > 0) {
    for (const code of codes) {
      const records = await listConferenceRecordsByCode(minted.token, code);
      if (records.length === 0) continue;
      meetChecked = true;
      const sameCode = occurrences.filter((o) => o.meetingCode === code && !o.teams);
      // Artifacts in small parallel batches — two calls per record, through
      // the discovery service so each inventory is classified by the shared
      // rules AND written back to the global artifact cache (the listing and
      // the dialog see what this sweep learned).
      const writeBacks: Array<{
        key: string;
        eventStart: string | null;
        rec: (typeof records)[number];
        ev: Awaited<ReturnType<typeof probeRecordEvidence>>;
        target: SeriesOccurrence | null;
      }> = [];
      for (let i = 0; i < records.length; i += MEET_BATCH) {
        const batch = records.slice(i, i + MEET_BATCH);
        const inventories = await Promise.all(
          batch.map((r) => probeRecordEvidence(minted.token, r.name))
        );
        batch.forEach((rec, j) => {
          const ev = inventories[j]!;
          if (!rec.startTime) return;
          // Same 24h aging as the listing's evidencePresent(): a listed-but-
          // never-generated artifact used to count "importable" here FOREVER
          // (and series auto-import fired doomed imports at it) while the
          // listing aged it out.
          const recEv = ev.recording;
          const trEv = ev.transcript;
          const fresh = Date.now() - Date.parse(rec.startTime) < 24 * 3600_000;
          const hasRec =
            recEv.ready > 0 || (fresh && recEv.state === 'generating');
          const hasTr =
            trEv.state === 'ready' || (fresh && trEv.state === 'generating');
          const recStart = Date.parse(rec.startTime);
          // Nearest calendar instance of the same code within the ONE
          // occurrence window (codes are reused across the series, so time
          // is the only disambiguator).
          let best: SeriesOccurrence | null = null;
          let bestDelta = OCCURRENCE_WINDOW_MS;
          for (const o of sameCode) {
            const delta = Math.abs(Date.parse(o.startIso) - recStart);
            if (delta < bestDelta) {
              bestDelta = delta;
              best = o;
            }
          }
          if (ev.verdict.importable) {
            writeBacks.push({
              key: cacheKeyOf(code, best ? best.startIso : rec.startTime),
              eventStart: best ? best.startIso : rec.startTime,
              rec,
              ev,
              target: best,
            });
          }
          if (!hasRec && !hasTr) return;
          const fileId = recEv.fileIds[0] ?? null;
          const docId = trEv.docIds[0] ?? null;
          const meet = {
            recordName: rec.name,
            videoPending: recEv.state === 'generating' || recEv.state === 'partial',
            transcriptPending: trEv.state === 'generating',
          };
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
          // No own-calendar instance within the window: not this series'
          // (the inventory above is still written back to the shared cache).
        });
      }
      // Write back what this sweep learned — best-effort, never blocks the
      // skeleton. Calendar attachments fold in for matched instances.
      try {
        const existing = await getMeetingCacheByKeys(writeBacks.map((w) => w.key));
        for (const w of writeBacks) {
          const calRow = w.target ? rowOfEvent.get(w.target.eventId ?? '') : undefined;
          const att = calRow ? attachmentsOf(calRow) : null;
          const row = await persistMeetingEvidence(minted.token, {
            userId: caller.userId,
            meetingCode: code,
            eventStart: w.eventStart,
            recordName: w.rec.name,
            recording: att ? classifyRecordings(w.ev.artifacts.recordings, att) : w.ev.recording,
            transcript: att
              ? classifyTranscripts({
                  docIds: w.ev.artifacts.transcriptDocIds,
                  listed: w.ev.artifacts.transcriptsListed,
                  attachments: att,
                })
              : w.ev.transcript,
            artifacts: w.ev.artifacts,
            attachments: att,
            event: w.target
              ? {
                  recurringEventId: w.target.recurringEventId,
                  iCalUID: w.target.iCalUID,
                  organizerEmail: w.target.organizerEmail,
                }
              : null,
            existing: existing.get(w.key) ?? undefined,
          });
          if (row) existing.set(w.key, row);
        }
      } catch (err) {
        console.warn('[series] artifact-cache write-back failed (continuing):', err);
      }
    }
  }

  // ---- Microsoft Graph side (Teams series) --------------------------------
  let graphChecked = false;
  if (isGraphConfigured() && joinUrls.length > 0) {
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
        // Attach artifacts to this join URL's calendar instances first…
        const claimed = new Set<string>();
        for (const occ of teamsOccs.get(rawUrl) ?? []) {
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
            emptyTranscript: false,
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
