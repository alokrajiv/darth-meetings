import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import {
  countCalendarMeetings,
  listCalendarMeetingsPage,
  type CalendarMeetingDbRow,
  type CalendarMeetingView,
} from '@/db-ops/calendar-event-cache';
import { findSeriesByRecurringBaseIds } from '@/db-ops/series';
import { ensureMeetingsForOccurrences } from '@/db-ops/meetings';
import { getAutoSyncLog, predictedAutoSyncImporters, type AutoSyncLogRow } from '@/db-ops/user-prefs';
import { recurringBaseId } from '@/lib/series-keys';
import { parseMeetingFilters } from '@/lib/server/meeting-filters';

export const runtime = 'nodejs';

/**
 * GET /api/calendar-meetings?view=unimported|norec — the two calendar-backed
 * listing views:
 *
 *  - unimported: meetings whose recording/transcript exists at Google (or
 *    Microsoft) but nobody imported — from the global artifact cache.
 *  - norec: the caller's own past calendar events that left no artifacts at
 *    all — from their per-user calendar_event_cache sweep rows.
 *
 * Same from/to/tz/days/minRows/cursor semantics as the listing v2 endpoint:
 * whole-day buckets, newest first, a day is never split across pages. Also
 * the shared people/provider filters (participant / organizer / provider /
 * q — lib/server/meeting-filters; `speaker` is ignored here, provider=upload
 * matches nothing), applied to rows AND counts; bad provider → 400.
 * Display-only rule: never returns tokens or file IDs — importing always
 * goes through the existing dialog flow (caller's own Google token).
 */

/** Row shape served to the frontend (workstream D `import type`s this). */
export interface CalendarMeetingRow {
  /** event_key of the underlying cache row. */
  key: string;
  meetingCode: string | null;
  title: string | null;
  eventStart: string;
  eventEnd: string | null;
  /** conf_end-conf_start or video_duration_ms/1000 when known. */
  durationSecs: number | null;
  hasRecording: boolean;
  hasTranscript: boolean;
  recordingCount: number;
  transcriptParseable: boolean | null;
  /** Artifact listed at the provider but the file isn't generated yet. */
  recordingPreparing: boolean;
  transcriptPreparing: boolean;
  /** Transcript is the Gemini-notes Doc (calendar attachment). */
  geminiNotes: boolean;
  organizerEmail: string | null;
  organizerSelf: boolean | null;
  provider: 'gmeet' | 'teams';
  attendeeCount: number | null;
  /** norec rows: whether the event even had a Meet link. */
  hasMeet: boolean;
  muted: boolean;
  /** Calendar event id (unimported rows: from the caller's own calendar row
   * for the occurrence, when they have one). */
  eventId: string | null;
  /** Drive file id of the first recording — deep link for diagnosis.
   * Display-only: Google enforces access when the link is opened. */
  videoFileId: string | null;
  /** First transcript Google-Doc id — deep link for diagnosis. */
  transcriptDocId: string | null;
  /** Stable series id — the "Hide all + future" mute value. */
  recurringEventId: string | null;
  /** Cached occurrences of the series ("Hide all N…"); null = not recurring. */
  seriesCount: number | null;
  /** App-level series this occurrence belongs to (recurring-base-id match) —
   * renders the same member chip archive rows get; click opens SeriesDialog. */
  seriesId: number | null;
  seriesTitle: string | null;
  /** norec rows only: what the last provider probe (poller sweep or a
   * "Check…") recorded for this occurrence — 'none' + 'none' means "asked
   * Google/Microsoft, nothing there" as of `evidenceCheckedAt`; null = never
   * probed (a Check… is the only way to know). Always null on unimported
   * rows (they have evidence by definition). */
  recordingState: string | null;
  transcriptState: string | null;
  evidenceCheckedAt: string | null;
  /** Teams rows: the chat verdict (was the call held / recorded — read from
   * the meeting chat via the caller's Darth Tasks Microsoft link; persisted
   * as raw.teamsChat on the artifact-cache row). All null until a sweep or
   * Check… recorded one. `chatHeld` null with `chatReason` set = the lookup
   * itself failed (forbidden / throttled / graph_error). */
  chatHeld: boolean | null;
  chatCallStart: string | null;
  chatCallEnd: string | null;
  chatDurationMs: number | null;
  chatRecorded: boolean | null;
  chatTranscribed: boolean | null;
  chatCheckedAt: string | null;
  chatReason: string | null;
  /** Organized by an external tenant (raw.external on the same row). */
  chatExternal: boolean | null;
  /** Stable meeting identity (migration 036) — /m/<uuid> works BEFORE any
   * import and keeps resolving to the transcript afterwards. Minted for
   * rows with a meeting code. */
  meetingUuid: string | null;
  /** Account auto-sync's intent for the occurrence (unimported rows):
   * 'imported'/'queued' = the ledger claimed it, 'pending' = an enabled
   * user's open reminder covers it and a sweep will take it — either way
   * the Import… CTA gives way to the auto-sync chip. */
  autoSync: {
    state: 'imported' | 'queued' | 'pending';
    importerEmail: string | null;
  } | null;
}

export interface CalendarMeetingsResponse {
  days: Array<{ key: string; rows: CalendarMeetingRow[] }>;
  counts: { unimported: number; norec: number };
  nextCursor: string | null;
  hasMore: boolean;
  connected: boolean;
  /** First-sweep progress for the caller's Google account. `syncing` is true
   * from connect until the poller stamps last_poll_at — the UI shows a
   * "still syncing, events may be missing" banner while it holds. */
  sync: {
    connectedAt: string | null;
    lastPollAt: string | null;
    syncing: boolean;
  };
}

// Digits included so zones like 'Etc/GMT+8' pass — same allow-list as the
// listing v2 endpoint; the Intl check below rejects made-up names.
const TZ_RE = /^[A-Za-z0-9_/+-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeTz(raw: string | null): string {
  if (!raw || !TZ_RE.test(raw)) return 'UTC';
  try {
    // Same IANA database as Postgres — rejects made-up names before SQL does.
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    return 'UTC';
  }
}

function dayParam(raw: string | null): string | null {
  return raw && DAY_RE.test(raw) ? raw : null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isoOf(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Normalized occurrence key — matches the auto-sync ledger's occ_key. */
function occKeyOf(r: CalendarMeetingDbRow): string | null {
  return r.meeting_code ? `${r.meeting_code}|${new Date(r.event_start).toISOString()}` : null;
}

function autoSyncOf(
  key: string | null,
  log: Map<string, AutoSyncLogRow>,
  predicted: Map<string, string>
): CalendarMeetingRow['autoSync'] {
  if (!key) return null;
  const claim = log.get(key);
  if (claim) {
    // failed/no_access/nudged: the sweep tried and can't (yet) — the honest
    // CTA there is the plain Import… button, so no chip.
    if (claim.outcome === 'imported' || claim.outcome === 'already')
      return { state: 'imported', importerEmail: claim.importer_email };
    if (claim.outcome === 'deferred')
      return { state: 'queued', importerEmail: claim.importer_email };
    return null;
  }
  const importer = predicted.get(key);
  return importer ? { state: 'pending', importerEmail: importer } : null;
}

function toRow(
  r: CalendarMeetingDbRow,
  seriesByBase: Map<string, { series_id: number; title: string }>,
  extras: {
    uuids: Map<string, string>;
    log: Map<string, AutoSyncLogRow>;
    predicted: Map<string, string>;
  }
): CalendarMeetingRow {
  const series = r.recurring_event_id
    ? (seriesByBase.get(recurringBaseId(r.recurring_event_id)) ?? null)
    : null;
  const occKey = occKeyOf(r);
  return {
    meetingUuid: occKey ? (extras.uuids.get(occKey) ?? null) : null,
    autoSync: autoSyncOf(occKey, extras.log, extras.predicted),
    key: r.key,
    meetingCode: r.meeting_code,
    title: r.title,
    eventStart: isoOf(r.event_start),
    eventEnd: r.event_end == null ? null : isoOf(r.event_end),
    durationSecs: r.duration_secs == null ? null : Math.round(r.duration_secs),
    hasRecording: r.has_recording,
    hasTranscript: r.has_transcript,
    recordingCount: r.recording_count,
    transcriptParseable: r.transcript_parseable,
    recordingPreparing: r.recording_preparing,
    transcriptPreparing: r.transcript_preparing,
    geminiNotes: r.gemini_notes,
    organizerEmail: r.organizer_email,
    organizerSelf: r.organizer_self,
    provider: r.provider,
    attendeeCount: r.attendee_count,
    hasMeet: r.has_meet,
    muted: r.muted,
    eventId: r.event_id,
    videoFileId: r.video_file_id,
    transcriptDocId: r.transcript_doc_id,
    recurringEventId: r.recurring_event_id,
    seriesCount: r.series_count,
    seriesId: series?.series_id ?? null,
    seriesTitle: series?.title ?? null,
    recordingState: r.evidence_recording_state,
    transcriptState: r.evidence_transcript_state,
    evidenceCheckedAt:
      r.evidence_checked_at == null ? null : isoOf(r.evidence_checked_at),
    chatHeld: r.teams_chat?.held ?? null,
    chatCallStart: r.teams_chat?.callStart ?? null,
    chatCallEnd: r.teams_chat?.callEnd ?? null,
    chatDurationMs: r.teams_chat?.durationMs ?? null,
    chatRecorded: r.teams_chat ? r.teams_chat.recorded === true : null,
    chatTranscribed: r.teams_chat ? r.teams_chat.transcribed === true : null,
    chatCheckedAt: r.teams_chat?.checkedAt ?? null,
    chatReason: r.teams_chat?.reason ?? null,
    chatExternal: r.chat_external ?? null,
  };
}

export const GET = withAuth(async ({ user, request }) => {
  const params = request.nextUrl.searchParams;
  const view = params.get('view');
  if (view !== 'unimported' && view !== 'norec') {
    return NextResponse.json(
      { error: "Expected ?view=unimported|norec" },
      { status: 400 }
    );
  }
  const parsed = parseMeetingFilters(params);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const tz = safeTz(params.get('tz'));
  const range = {
    tz,
    from: dayParam(params.get('from')),
    to: dayParam(params.get('to')),
    filters: parsed.filters,
  };
  const caller = { userId: user.userId, email: user.email };

  const [account, counts, page] = await Promise.all([
    getGoogleAccount(user.userId),
    countCalendarMeetings(caller, range),
    listCalendarMeetingsPage(caller, view as CalendarMeetingView, {
      ...range,
      cursor: dayParam(params.get('cursor')),
      days: clampInt(params.get('days'), 14, 1, 60),
      minRows: clampInt(params.get('minRows'), 40, 1, 200),
    }),
  ]);

  // One batch lookup maps this page's recurring events onto app-level series.
  const baseIds = [
    ...new Set(
      page.days.flatMap((d) =>
        d.rows.flatMap((r) => (r.recurring_event_id ? [recurringBaseId(r.recurring_event_id)] : []))
      )
    ),
  ];
  // Pre-import identity + auto-sync intent, batched over the served rows.
  const allRows = page.days.flatMap((d) => d.rows);
  const occs = allRows
    .filter((r) => r.meeting_code)
    .map((r) => ({
      code: r.meeting_code!,
      startIso: isoOf(r.event_start),
      provider: (r.meeting_code!.startsWith('teams-') ? 'teams' : 'gmeet') as string,
      title: r.title,
    }));
  const occKeys = [...new Set(occs.map((o) => `${o.code}|${o.startIso}`))];
  const [seriesByBase, uuids, log, predicted] = await Promise.all([
    findSeriesByRecurringBaseIds(baseIds),
    ensureMeetingsForOccurrences(occs).catch((err) => {
      console.warn('[calendar-meetings] occurrence uuid mint failed:', err);
      return new Map<string, string>();
    }),
    view === 'unimported' ? getAutoSyncLog(occKeys) : Promise.resolve(new Map<string, AutoSyncLogRow>()),
    view === 'unimported'
      ? predictedAutoSyncImporters(occs)
      : Promise.resolve(new Map<string, string>()),
  ]);
  const extras = { uuids, log, predicted };

  const body: CalendarMeetingsResponse = {
    days: page.days.map((d) => ({ key: d.key, rows: d.rows.map((r) => toRow(r, seriesByBase, extras)) })),
    counts,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    connected: !!account,
    sync: {
      connectedAt: account?.connected_at ?? null,
      lastPollAt: account?.last_poll_at ?? null,
      // No completed sweep since (re)connecting → the first sweep is still
      // running (or queued); calendar layers may be missing events.
      syncing:
        !!account &&
        (account.last_poll_at === null ||
          (account.connected_at !== null &&
            new Date(account.last_poll_at) < new Date(account.connected_at))),
    },
  };
  return NextResponse.json(body);
});
