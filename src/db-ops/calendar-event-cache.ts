import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { OCCURRENCE_WINDOW_S } from '@/lib/meeting-evidence';
import { importedOccurrenceAntiJoin } from '@/db-ops/imported-occurrences';
import { norecFilterSql, unimportedFilterSql } from '@/db-ops/meeting-filter-sql';
import { EMPTY_MEETING_FILTERS, type MeetingFilters } from '@/lib/server/meeting-filters';
import type { TeamsChatEvidence } from '@/lib/teams-chat-evidence';

// Per-user calendar event cache (migration 022) + the paged queries behind
// GET /api/calendar-meetings. The poller batch-upserts EVERY timed event
// from a user's sweep here — including ones with no Meet conference — so
// the listing can show "calendar meetings that left no artifacts" (norec)
// next to "artifacts exist but nobody imported" (unimported, which reads
// the global gmeet_meeting_cache).
//
// PRIVACY: calendar_event_cache rows are strictly per-user — a user only
// ever sees events their own sweep wrote (unlike the global artifact
// cache). Display-only as always: nothing here grants content access.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

// ±12h occurrence window: single declaration in lib/meeting-evidence.

export interface CalendarEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
}

export interface CalendarEventUpsert {
  /** '<eventId>|<startIso>' */
  eventKey: string;
  eventId: string;
  recurringEventId: string | null;
  iCalUID: string | null;
  title: string | null;
  /** ISO dateTime — all-day events (date only) are never cached. */
  eventStart: string;
  eventEnd: string | null;
  /** null = no Meet conference on the event. */
  meetingCode: string | null;
  organizerEmail: string | null;
  organizerSelf: boolean | null;
  attendeeCount: number | null;
  attendees: CalendarEventAttendee[] | null;
  // Classified calendar attachments (lib/meeting-evidence) — the only
  // artifact evidence that outlives the Meet record's ~30d retention, and
  // the only evidence Gemini-notes-only meetings ever get (D1).
  attachmentVideoCount: number;
  attachmentVideoFileId: string | null;
  attachmentTranscriptDocId: string | null;
  attachmentGeminiNotes: boolean;
}

/**
 * Batch upsert of one user's calendar sweep. Title/end/attendees change
 * legitimately between sweeps → overwrite; identity-ish fields fill gaps
 * (a Meet link added to the event later fills in, a flaky read never
 * clobbers with null); first_seen_at is preserved.
 */
export async function upsertCalendarEvents(
  userId: string,
  events: CalendarEventUpsert[]
): Promise<void> {
  // Last write wins within a batch — ON CONFLICT can't touch a row twice.
  const batch = [...new Map(events.map((e) => [e.eventKey, e])).values()];
  if (batch.length === 0) return;
  await sql`
    INSERT INTO ${sql(SCHEMA)}.calendar_event_cache
      (user_id, event_key, event_id, recurring_event_id, ical_uid, title,
       event_start, event_end, meeting_code, organizer_email, organizer_self,
       attendee_count, attendees, attachment_video_count,
       attachment_video_file_id, attachment_transcript_doc_id,
       attachment_gemini_notes)
    SELECT ${userId}, e."eventKey", e."eventId", e."recurringEventId", e."iCalUID",
           e.title, e."eventStart", e."eventEnd", e."meetingCode",
           e."organizerEmail", e."organizerSelf", e."attendeeCount", e.attendees,
           COALESCE(e."attachmentVideoCount", 0), e."attachmentVideoFileId",
           e."attachmentTranscriptDocId", COALESCE(e."attachmentGeminiNotes", false)
    FROM jsonb_to_recordset(${sql.json(batch as unknown as never)}) AS e(
      "eventKey" text, "eventId" text, "recurringEventId" text, "iCalUID" text,
      title text, "eventStart" timestamptz, "eventEnd" timestamptz,
      "meetingCode" text, "organizerEmail" text, "organizerSelf" boolean,
      "attendeeCount" int, attendees jsonb, "attachmentVideoCount" int,
      "attachmentVideoFileId" text, "attachmentTranscriptDocId" text,
      "attachmentGeminiNotes" boolean
    )
    ON CONFLICT (user_id, event_key) DO UPDATE SET
      title              = EXCLUDED.title,
      event_end          = EXCLUDED.event_end,
      attendee_count     = EXCLUDED.attendee_count,
      attendees          = EXCLUDED.attendees,
      meeting_code       = COALESCE(EXCLUDED.meeting_code, calendar_event_cache.meeting_code),
      recurring_event_id = COALESCE(EXCLUDED.recurring_event_id, calendar_event_cache.recurring_event_id),
      ical_uid           = COALESCE(EXCLUDED.ical_uid, calendar_event_cache.ical_uid),
      organizer_email    = COALESCE(EXCLUDED.organizer_email, calendar_event_cache.organizer_email),
      organizer_self     = COALESCE(EXCLUDED.organizer_self, calendar_event_cache.organizer_self),
      -- Attachments accrue after the call; a later sweep only ever adds.
      attachment_video_count = GREATEST(EXCLUDED.attachment_video_count, calendar_event_cache.attachment_video_count),
      attachment_video_file_id = COALESCE(EXCLUDED.attachment_video_file_id, calendar_event_cache.attachment_video_file_id),
      attachment_transcript_doc_id = COALESCE(EXCLUDED.attachment_transcript_doc_id, calendar_event_cache.attachment_transcript_doc_id),
      attachment_gemini_notes = (EXCLUDED.attachment_gemini_notes OR calendar_event_cache.attachment_gemini_notes),
      last_seen_at       = now()
  `;
}

/**
 * The caller's own cached calendar row for a Meet occurrence → its classified
 * attachments (the poller persists them per event, migration 026). Lets a
 * probe that arrives without the live event (listing "Check…", API callers)
 * fold the Gemini-notes Doc / attached video in exactly like the poller does.
 */
export async function getCalendarAttachmentsFor(
  userId: string,
  q: { eventId?: string | null; meetingCode: string; startTime?: string | null }
): Promise<{
  videoFileId: string | null;
  videoCount: number;
  transcriptDocId: string | null;
  geminiNotes: boolean;
} | null> {
  const rows = await sql<
    Array<{
      attachment_video_file_id: string | null;
      attachment_video_count: number;
      attachment_transcript_doc_id: string | null;
      attachment_gemini_notes: boolean;
    }>
  >`
    SELECT attachment_video_file_id, attachment_video_count,
           attachment_transcript_doc_id, attachment_gemini_notes
    FROM ${sql(SCHEMA)}.calendar_event_cache
    WHERE user_id = ${userId}
      AND (
        ${q.eventId ? sql`event_id = ${q.eventId}` : sql`false`}
        OR (
          meeting_code = ${q.meetingCode}
          AND ${
            q.startTime
              ? sql`abs(extract(epoch FROM (event_start - ${q.startTime}::timestamptz))) <= ${OCCURRENCE_WINDOW_S}`
              : sql`false`
          }
        )
      )
    ORDER BY (attachment_transcript_doc_id IS NOT NULL OR attachment_video_file_id IS NOT NULL) DESC
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    videoFileId: r.attachment_video_file_id,
    videoCount: r.attachment_video_count,
    transcriptDocId: r.attachment_transcript_doc_id,
    geminiNotes: r.attachment_gemini_notes,
  };
}

/**
 * Does THIS user's calendar actually contain the occurrence (meeting code
 * ±12h of the start)? Gate for persistence keyed on client-supplied input:
 * /api/teams/evidence takes a raw join URL + startTime from the browser, and
 * without this check any authenticated caller could mint one permanent
 * gmeet_meeting_cache row per fabricated URL (the row key is derived from
 * the URL's hash, so the space is unbounded).
 */
export async function hasCalendarOccurrence(
  userId: string,
  meetingCode: string,
  startIso: string
): Promise<boolean> {
  const rows = await sql<Array<{ ok: boolean }>>`
    SELECT true AS ok
    FROM ${sql(SCHEMA)}.calendar_event_cache
    WHERE user_id = ${userId}
      AND meeting_code = ${meetingCode}
      AND abs(extract(epoch FROM (event_start - ${startIso}::timestamptz))) <= ${OCCURRENCE_WINDOW_S}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * THE caller-involvement check (2026-08-24 privacy audit) — the reusable
 * form of unimportedVisibleTo's calendar arms, for routes that resolve
 * global-cache rows / Graph artifacts from client-supplied meeting codes or
 * join URLs. A caller is "involved" in an occurrence when their own sweep
 * captured it, or they are organizer/invitee on ANY user's cached calendar
 * row for it (code ±12h; instant null = any occurrence of the code).
 * Callers holding the cache row should additionally accept
 * `lower(row.organizer_email) === caller.email` (the cache-only arm).
 * Returns the subset of input codes the caller is involved in.
 */
export async function callerInvolvedCodes(
  caller: { userId: string; email: string },
  occs: Array<{ code: string; instant?: string | null }>
): Promise<Set<string>> {
  const email = caller.email.toLowerCase();
  const batch = occs
    .filter((o) => typeof o.code === 'string' && o.code.length > 0)
    .map((o) => ({
      code: o.code,
      instant: o.instant && !Number.isNaN(Date.parse(o.instant)) ? o.instant : null,
    }));
  if (batch.length === 0) return new Set();
  const rows = await sql<Array<{ code: string }>>`
    SELECT DISTINCT o.code
    FROM jsonb_to_recordset(${sql.json(batch as unknown as never)})
         AS o(code text, instant timestamptz)
    WHERE EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_cache ce
      WHERE ce.meeting_code = o.code
        AND (
          o.instant IS NULL
          OR ce.event_start BETWEEN o.instant - ${OCCURRENCE_WINDOW_S} * interval '1 second'
                                AND o.instant + ${OCCURRENCE_WINDOW_S} * interval '1 second'
        )
        AND (
          ce.user_id = ${caller.userId}
          OR lower(ce.organizer_email) = ${email}
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(ce.attendees, '[]'::jsonb)) a
            WHERE lower(a->>'email') = ${email}
          )
        )
    )
  `;
  return new Set(rows.map((r) => r.code));
}

/** Single-occurrence form of callerInvolvedCodes. */
export async function callerInvolvedInOccurrence(
  caller: { userId: string; email: string },
  code: string,
  instant?: string | null
): Promise<boolean> {
  const set = await callerInvolvedCodes(caller, [{ code, instant }]);
  return set.has(code);
}

// ---------------------------------------------------------------------------
// Calendar-event mutes (migration 023) — per-user HIDE of calendar rows.
// Personal blocks ("my lunch", focus time) aren't real meetings; a mute
// removes them from BOTH calendar layers (norec and unimported). Distinct
// from gmeet_sync_skips' 'muted' flag, which only de-emphasizes.
//
//  - kind='occurrence': value = the row's event_key (one occurrence).
//  - kind='series':     value = recurring_event_id (falling back to
//    event_id for non-recurring events) — stable across future poller
//    rows, so new occurrences are excluded automatically.
// ---------------------------------------------------------------------------

export type CalendarMuteKind = 'occurrence' | 'series';

export interface CalendarEventMuteRow {
  kind: CalendarMuteKind;
  value: string;
  title: string | null;
  created_at: string;
}

export async function addCalendarEventMute(
  userId: string,
  kind: CalendarMuteKind,
  value: string,
  title: string | null
): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.calendar_event_mutes (user_id, kind, value, title)
    VALUES (${userId}, ${kind}, ${value}, ${title})
    ON CONFLICT (user_id, kind, value) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, calendar_event_mutes.title)
  `;
}

export async function removeCalendarEventMute(
  userId: string,
  kind: CalendarMuteKind,
  value: string
): Promise<void> {
  await sql`
    DELETE FROM ${sql(SCHEMA)}.calendar_event_mutes
    WHERE user_id = ${userId} AND kind = ${kind} AND value = ${value}
  `;
}

export async function listCalendarEventMutes(
  userId: string
): Promise<CalendarEventMuteRow[]> {
  return sql<CalendarEventMuteRow[]>`
    SELECT kind, value, title, created_at
    FROM ${sql(SCHEMA)}.calendar_event_mutes
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, kind, value
  `;
}

// ---------------------------------------------------------------------------
// /api/calendar-meetings listing queries
// ---------------------------------------------------------------------------

export type CalendarMeetingView = 'unimported' | 'norec';

/**
 * THE artifact-evidence predicate (D3): the unimported WHERE, the norec
 * anti-join and the SELECT display columns must all agree or a meeting shows
 * under the wrong label (or in both views / neither). Ready evidence counts
 * always; a still-'generating' artifact counts only while the meeting is
 * fresh (<24h) — the listing labels those "preparing…" instead of lying with
 * "No recording"; a generation that never materialized ages out silently.
 */
function evidencePresent(alias: string): ReturnType<typeof sql> {
  const a = sql(alias);
  return sql`(
    ${a}.ready_recording_count > 0
    OR ${a}.video_file_id IS NOT NULL
    OR COALESCE(jsonb_array_length(${a}.transcript_doc_ids), 0) > 0
    OR ${a}.transcript_parseable IS TRUE
    OR (
      (${a}.recording_state = 'generating' OR ${a}.transcript_state = 'generating')
      AND COALESCE(${a}.event_start, ${a}.conf_start) > now() - interval '24 hours'
    )
  )`;
}

export interface CalendarMeetingDbRow {
  day_key: string;
  key: string;
  meeting_code: string | null;
  title: string | null;
  event_start: string;
  event_end: string | null;
  duration_secs: number | null;
  has_recording: boolean;
  has_transcript: boolean;
  recording_count: number;
  transcript_parseable: boolean | null;
  /** Provider lists the artifact but the file isn't generated yet (<24h). */
  recording_preparing: boolean;
  transcript_preparing: boolean;
  /** Transcript comes from the Gemini-notes Doc (calendar attachment). */
  gemini_notes: boolean;
  organizer_email: string | null;
  organizer_self: boolean | null;
  attendee_count: number | null;
  provider: 'gmeet' | 'teams';
  has_meet: boolean;
  muted: boolean;
  event_id: string | null;
  /** Drive file / Google Doc ids for artifact deep links (unimported only). */
  video_file_id: string | null;
  transcript_doc_id: string | null;
  recurring_event_id: string | null;
  /** Occurrences currently cached for the row's recurring series (null when
   * the event isn't recurring) — powers "Hide all N + future ones". */
  series_count: number | null;
  /** norec rows: what the LAST provider probe (poller / Check…) recorded for
   * this occurrence in the artifact cache — 'none'/'none' = "asked
   * Google/Microsoft, nothing there" (as of evidence_checked_at); null =
   * never probed. Unimported rows always have evidence, so these are null. */
  evidence_recording_state: string | null;
  evidence_transcript_state: string | null;
  evidence_checked_at: string | null;
  /** Teams rows: the chat verdict (held / recorded — raw.teamsChat on the
   * occurrence's artifact-cache row, lib/teams-chat-evidence); null = never
   * checked. Serves the "Held 51 min · not recorded" line on norec rows. */
  teams_chat: TeamsChatEvidence | null;
  /** raw.external on the same row — organized by an external tenant. */
  chat_external: boolean | null;
}

export interface CalendarRangeOpts {
  /** Validated IANA name — the route falls back to 'UTC' on anything odd. */
  tz: string;
  /** YYYY-MM-DD inclusive, interpreted in tz. */
  from?: string | null;
  to?: string | null;
  /** Day key (exclusive): only days strictly older. */
  cursor?: string | null;
  /** Shared people/provider/q filters (lib/server/meeting-filters) — applied
   * to the rows AND the tab counts. `speaker` is ignored on these layers
   * (no speakers on calendar rows); provider=upload matches nothing. */
  filters?: MeetingFilters;
}

export interface CalendarPageOpts extends CalendarRangeOpts {
  days: number;
  minRows: number;
}

type Caller = { userId: string; email: string };

/**
 * Day-key bounds, in two forms each: the exact predicate on the tz-cast day
 * expression, plus a REDUNDANT (strictly wider — ±2 days swallows any tz
 * offset) range on the raw start column. The tz-cast form is unestimatable,
 * and its default selectivity convinces the planner the range matches ~1
 * row — which flips the imported-occurrence anti-join into a nested loop
 * that re-scans transcripts (detoasting the ~16KB gmeet_context per pair)
 * once per candidate row. The sargable twin restores real row estimates and
 * gives the planner an indexable band; it never changes which rows match.
 */
function dayFilters(
  dayExpr: ReturnType<typeof sql>,
  startExpr: ReturnType<typeof sql>,
  opts: CalendarRangeOpts
): ReturnType<typeof sql> {
  return sql`
    ${
      opts.from
        ? sql`AND ${startExpr} >= ${opts.from}::date - interval '2 days'
    AND ${dayExpr} >= ${opts.from}::date`
        : sql``
    }
    ${
      opts.to
        ? sql`AND ${startExpr} <= ${opts.to}::date + interval '2 days'
    AND ${dayExpr} <= ${opts.to}::date`
        : sql``
    }
    ${
      opts.cursor
        ? sql`AND ${startExpr} < ${opts.cursor}::date + interval '2 days'
    AND ${dayExpr} < ${opts.cursor}::date`
        : sql``
    }
  `;
}

/** unimported: global cache rows with artifacts, minus anything anyone
 * imported live (deferred defer-* placeholders count as imported — they
 * carry the same meetingCode, so the plain anti-join covers them). Teams
 * cache rows (`teams-…` codes) join transcripts through the stashed
 * resolution's joinWebUrl — Teams imports carry no meetingCode. */
function unimportedDay(tz: string): ReturnType<typeof sql> {
  return sql`(COALESCE(c.event_start, c.conf_start) AT TIME ZONE ${tz})::date`;
}

/** Caller-scoped mute exclusion for the unimported view. A mute hides the
 * row when it matches the gmeet cache row directly (occurrence → its
 * event_key, series → its recurring_event_id) OR through the caller's own
 * calendar row for the same occurrence — so a mute created from the norec
 * layer keeps hiding the meeting after artifacts appear and it migrates to
 * the unimported layer (hiding is layer-agnostic). */
function unimportedMuteExclusion(userId: string): ReturnType<typeof sql> {
  return sql`
    AND NOT EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_mutes m
      WHERE m.user_id = ${userId}
        AND (
          (m.kind = 'occurrence' AND m.value = c.event_key)
          OR (m.kind = 'series' AND m.value = c.recurring_event_id)
          OR EXISTS (
            SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_cache ce
            WHERE ce.user_id = ${userId}
              AND ce.meeting_code = c.meeting_code
              AND ce.event_start
                    BETWEEN COALESCE(c.event_start, c.conf_start) - ${OCCURRENCE_WINDOW_S} * interval '1 second'
                        AND COALESCE(c.event_start, c.conf_start) + ${OCCURRENCE_WINDOW_S} * interval '1 second'
              AND (
                (m.kind = 'occurrence' AND m.value = ce.event_key)
                OR (m.kind = 'series' AND m.value = COALESCE(ce.recurring_event_id, ce.event_id))
              )
          )
        )
    )
  `;
}

/**
 * PRIVACY GATE (2026-08-24): the unimported view reads the GLOBAL artifact
 * cache, which holds every connected user's meetings — without this
 * predicate any caller sees titles/organizers/times of meetings they were
 * never invited to. A row is visible only when the caller is involved in
 * the occurrence:
 *  1. their OWN calendar sweep captured it (code + ±12h — rides the
 *     migration-029 user-scoped index), or
 *  2. the cache row says they organized it, or
 *  3. they appear as an invitee on ANY user's cached calendar row for the
 *     occurrence (covers "invited, but own sweep hasn't seen it" — e.g.
 *     history older than their first sweep; migration-030 unscoped index).
 * Teams rows ride the same arms: calendar sweeps stamp the identical
 * canonical `teams-…` code on calendar_event_cache rows.
 */
function unimportedVisibleTo(caller: Caller): ReturnType<typeof sql> {
  const email = caller.email.toLowerCase();
  return sql`(
    EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_cache ce
      WHERE ce.user_id = ${caller.userId}
        AND ce.meeting_code = c.meeting_code
        AND ce.event_start
              BETWEEN COALESCE(c.event_start, c.conf_start) - ${OCCURRENCE_WINDOW_S} * interval '1 second'
                  AND COALESCE(c.event_start, c.conf_start) + ${OCCURRENCE_WINDOW_S} * interval '1 second'
    )
    OR lower(c.organizer_email) = ${email}
    OR EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_cache ce2
      WHERE ce2.meeting_code = c.meeting_code
        AND ce2.event_start
              BETWEEN COALESCE(c.event_start, c.conf_start) - ${OCCURRENCE_WINDOW_S} * interval '1 second'
                  AND COALESCE(c.event_start, c.conf_start) + ${OCCURRENCE_WINDOW_S} * interval '1 second'
        AND (
          lower(ce2.organizer_email) = ${email}
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(ce2.attendees, '[]'::jsonb)) a
            WHERE lower(a->>'email') = ${email}
          )
        )
    )
  )`;
}

function unimportedWhere(caller: Caller, opts: CalendarRangeOpts): ReturnType<typeof sql> {
  const userId = caller.userId;
  // THE already-imported rule (db-ops/imported-occurrences): meeting code /
  // Teams join URL pinned by the ±12h window, plus calendar eventIds —
  // uploads and pasted transcripts link by eventId, not meeting code (D9) —
  // resolved through the caller's own calendar rows for the occurrence.
  return sql`
    WHERE COALESCE(c.event_start, c.conf_start) IS NOT NULL
      AND ${unimportedVisibleTo(caller)}
      AND ${evidencePresent('c')}
      AND ${importedOccurrenceAntiJoin({
        meetingCode: sql`c.meeting_code`,
        joinWebUrl: sql`c.raw->'teamsResolution'->>'joinWebUrl'`,
        eventIdIn: sql`(
          SELECT ce.event_id
          FROM ${sql(SCHEMA)}.calendar_event_cache ce
          WHERE ce.user_id = ${userId}
            AND ce.meeting_code = c.meeting_code
            AND ce.event_start
                  BETWEEN COALESCE(c.event_start, c.conf_start) - ${OCCURRENCE_WINDOW_S} * interval '1 second'
                      AND COALESCE(c.event_start, c.conf_start) + ${OCCURRENCE_WINDOW_S} * interval '1 second'
        )`,
        instant: sql`COALESCE(c.event_start, c.conf_start)`,
      })}
      ${unimportedMuteExclusion(userId)}
      ${dayFilters(unimportedDay(opts.tz), sql`COALESCE(c.event_start, c.conf_start)`, opts)}
      ${unimportedFilterSql(userId, opts.filters ?? EMPTY_MEETING_FILTERS)}
  `;
}

/** norec: caller's own calendar events (past only) where no artifact ever
 * showed up — no Meet link at all, or a Meet link whose conference left
 * nothing in the artifact cache — and nobody imported the code either. */
function norecDay(tz: string): ReturnType<typeof sql> {
  return sql`(c.event_start AT TIME ZONE ${tz})::date`;
}

function norecWhere(userId: string, opts: CalendarRangeOpts): ReturnType<typeof sql> {
  return sql`
    WHERE c.user_id = ${userId}
      AND c.event_start <= now()
      AND (c.meeting_code IS NULL OR NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.gmeet_meeting_cache g
        WHERE g.meeting_code = c.meeting_code
          AND ${evidencePresent('g')}
          AND abs(extract(epoch FROM (
                COALESCE(g.event_start, g.conf_start) - c.event_start
              ))) <= ${OCCURRENCE_WINDOW_S}
      ))
      -- THE already-imported rule: meeting code ±12h, plus calendar eventId
      -- (uploads / pasted transcripts link by eventId — without it a linked
      -- import leaves the event stranded in "No recording").
      AND ${importedOccurrenceAntiJoin({
        meetingCode: sql`c.meeting_code`,
        eventIdIn: sql`(SELECT c.event_id)`,
        instant: sql`c.event_start`,
      })}
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_mutes m
        WHERE m.user_id = ${userId}
          AND (
            (m.kind = 'occurrence' AND m.value = c.event_key)
            OR (m.kind = 'series' AND m.value = COALESCE(c.recurring_event_id, c.event_id))
          )
      )
      ${dayFilters(norecDay(opts.tz), sql`c.event_start`, opts)}
      ${norecFilterSql(opts.filters ?? EMPTY_MEETING_FILTERS)}
  `;
}

/** Tab counts — respect from/to and the people/provider/q filters (they
 * label the tabs over a filtered list), never the cursor. */
export async function countCalendarMeetings(
  caller: Caller,
  opts: CalendarRangeOpts
): Promise<{ unimported: number; norec: number }> {
  const range = { ...opts, cursor: null };
  const [u, n] = await Promise.all([
    // The global cache keys rows by the raw startIso, so the same occurrence
    // captured from two users' calendars (different tz offsets) yields two
    // event_keys — count/list one row per (code, instant) pair.
    sql<Array<{ n: number }>>`
      SELECT count(DISTINCT (c.meeting_code, COALESCE(c.event_start, c.conf_start)))::int AS n
      FROM ${sql(SCHEMA)}.gmeet_meeting_cache c
      ${unimportedWhere(caller, range)}
    `,
    sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM ${sql(SCHEMA)}.calendar_event_cache c
      ${norecWhere(caller.userId, range)}
    `,
  ]);
  return { unimported: u[0]?.n ?? 0, norec: n[0]?.n ?? 0 };
}

async function unimportedRows(
  caller: Caller,
  opts: CalendarRangeOpts,
  dayKeys: string[]
): Promise<CalendarMeetingDbRow[]> {
  const day = unimportedDay(opts.tz);
  // DISTINCT ON (code, instant): the raw-startIso event_key means one
  // occurrence can appear under two tz representations — keep one row.
  return sql<CalendarMeetingDbRow[]>`
    SELECT * FROM (
    SELECT DISTINCT ON (c.meeting_code, COALESCE(c.event_start, c.conf_start))
      to_char(${day}, 'YYYY-MM-DD') AS day_key,
      c.event_key AS key,
      c.meeting_code,
      COALESCE(rem.title, cal.title) AS title,
      COALESCE(c.event_start, c.conf_start) AS event_start,
      COALESCE(c.conf_end, cal.event_end) AS event_end,
      COALESCE(
        extract(epoch FROM (c.conf_end - c.conf_start)),
        c.video_duration_ms / 1000.0
      )::float8 AS duration_secs,
      (c.ready_recording_count > 0 OR c.video_file_id IS NOT NULL) AS has_recording,
      (COALESCE(jsonb_array_length(c.transcript_doc_ids), 0) > 0
        OR c.transcript_parseable IS TRUE) AS has_transcript,
      -- "Recording ×N" = files you can actually pull, never the listed count
      -- (a stop/restart meeting lists 3 entries with 1 file for a while).
      GREATEST(
        c.ready_recording_count,
        CASE WHEN c.video_file_id IS NOT NULL THEN 1 ELSE 0 END
      ) AS recording_count,
      c.transcript_parseable,
      (c.recording_state = 'generating'
        AND COALESCE(c.event_start, c.conf_start) > now() - interval '24 hours')
        AS recording_preparing,
      (c.transcript_state = 'generating'
        AND COALESCE(c.event_start, c.conf_start) > now() - interval '24 hours')
        AS transcript_preparing,
      (c.transcript_source = 'gemini') AS gemini_notes,
      COALESCE(c.organizer_email, cal.organizer_email) AS organizer_email,
      COALESCE(cal.organizer_self, lower(c.organizer_email) = ${caller.email.toLowerCase()}) AS organizer_self,
      cal.attendee_count,
      CASE WHEN c.meeting_code LIKE 'teams-%' THEN 'teams' ELSE 'gmeet' END AS provider,
      true AS has_meet,
      EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.gmeet_sync_skips s
        WHERE s.user_id = ${caller.userId}
          AND s.event_key IN (c.meeting_code, c.event_key)
      ) AS muted,
      cal.event_id,
      NULL::text AS evidence_recording_state,
      NULL::text AS evidence_transcript_state,
      NULL::timestamptz AS evidence_checked_at,
      c.raw->'teamsChat' AS teams_chat,
      (c.raw->>'external')::boolean AS chat_external,
      -- Artifact deep links (display-only ids; Google enforces access when
      -- the link is opened — same exposure as the gmeet/check meta).
      c.video_file_id,
      c.transcript_doc_ids->>0 AS transcript_doc_id,
      COALESCE(c.recurring_event_id, cal.recurring_event_id) AS recurring_event_id,
      -- "Hide all N": occurrences currently cached for the series. The
      -- artifact cache is global, so count deduped (code, instant) pairs;
      -- when only the caller's calendar row knows the recurring id, count
      -- their own calendar rows instead.
      CASE
        WHEN c.recurring_event_id IS NOT NULL THEN (
          SELECT count(DISTINCT (g2.meeting_code, COALESCE(g2.event_start, g2.conf_start)))::int
          FROM ${sql(SCHEMA)}.gmeet_meeting_cache g2
          WHERE g2.recurring_event_id = c.recurring_event_id
        )
        WHEN cal.recurring_event_id IS NOT NULL THEN (
          SELECT count(*)::int
          FROM ${sql(SCHEMA)}.calendar_event_cache ce2
          WHERE ce2.user_id = ${caller.userId}
            AND ce2.recurring_event_id = cal.recurring_event_id
        )
      END AS series_count
    FROM ${sql(SCHEMA)}.gmeet_meeting_cache c
    -- Titles live in reminder rows, not the artifact cache. Any user's row
    -- works — display-only per the own-token rule.
    LEFT JOIN LATERAL (
      SELECT r.title FROM ${sql(SCHEMA)}.gmeet_reminders r
      WHERE r.event_key = c.event_key AND r.title IS NOT NULL
      ORDER BY r.last_seen_at DESC
      LIMIT 1
    ) rem ON true
    -- The caller's own calendar row for the same occurrence enriches with
    -- attendee count / organizer_self / title+end fallbacks.
    LEFT JOIN LATERAL (
      SELECT ce.title, ce.event_end, ce.organizer_email, ce.organizer_self,
             ce.attendee_count, ce.event_id, ce.recurring_event_id
      FROM ${sql(SCHEMA)}.calendar_event_cache ce
      WHERE ce.user_id = ${caller.userId}
        AND ce.meeting_code = c.meeting_code
        AND ce.event_start
              BETWEEN COALESCE(c.event_start, c.conf_start) - ${OCCURRENCE_WINDOW_S} * interval '1 second'
                  AND COALESCE(c.event_start, c.conf_start) + ${OCCURRENCE_WINDOW_S} * interval '1 second'
      ORDER BY abs(extract(epoch FROM (
        ce.event_start - COALESCE(c.event_start, c.conf_start)
      )))
      LIMIT 1
    ) cal ON true
    ${unimportedWhere(caller, opts)}
      AND to_char(${day}, 'YYYY-MM-DD') = ANY(${dayKeys})
    ORDER BY c.meeting_code, COALESCE(c.event_start, c.conf_start), c.event_key DESC
    ) d
    ORDER BY d.event_start DESC, d.key DESC
  `;
}

async function norecRows(
  userId: string,
  opts: CalendarRangeOpts,
  dayKeys: string[]
): Promise<CalendarMeetingDbRow[]> {
  const day = norecDay(opts.tz);
  return sql<CalendarMeetingDbRow[]>`
    SELECT
      to_char(${day}, 'YYYY-MM-DD') AS day_key,
      c.event_key AS key,
      c.meeting_code,
      c.title,
      c.event_start,
      c.event_end,
      extract(epoch FROM (c.event_end - c.event_start))::float8 AS duration_secs,
      false AS has_recording,
      false AS has_transcript,
      0 AS recording_count,
      NULL::boolean AS transcript_parseable,
      false AS recording_preparing,
      false AS transcript_preparing,
      false AS gemini_notes,
      NULL::text AS video_file_id,
      NULL::text AS transcript_doc_id,
      c.organizer_email,
      c.organizer_self,
      c.attendee_count,
      CASE WHEN c.meeting_code LIKE 'teams-%' THEN 'teams' ELSE 'gmeet' END AS provider,
      (c.meeting_code IS NOT NULL) AS has_meet,
      EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.gmeet_sync_skips s
        WHERE s.user_id = c.user_id
          AND s.event_key IN (c.meeting_code, c.event_id, c.event_key)
      ) AS muted,
      c.event_id,
      c.recurring_event_id,
      CASE WHEN c.recurring_event_id IS NOT NULL THEN (
        SELECT count(*)::int
        FROM ${sql(SCHEMA)}.calendar_event_cache ce2
        WHERE ce2.user_id = c.user_id
          AND ce2.recurring_event_id = c.recurring_event_id
      ) END AS series_count,
      ev.recording_state AS evidence_recording_state,
      ev.transcript_state AS evidence_transcript_state,
      ev.updated_at AS evidence_checked_at,
      chatv.teams_chat,
      chatv.chat_external
    FROM ${sql(SCHEMA)}.calendar_event_cache c
    -- The artifact cache row the last probe left for this occurrence (the
    -- anti-join above already proved it holds no evidence — this only tells
    -- the UI "probed, nothing there" vs "never probed", so the row can say
    -- so instead of inviting an Import click). Indexed code lookup, one
    -- row per listed event.
    LEFT JOIN LATERAL (
      SELECT g.recording_state, g.transcript_state, g.updated_at
      FROM ${sql(SCHEMA)}.gmeet_meeting_cache g
      WHERE c.meeting_code IS NOT NULL
        AND g.meeting_code = c.meeting_code
        AND abs(extract(epoch FROM (
              COALESCE(g.event_start, g.conf_start) - c.event_start
            ))) <= ${OCCURRENCE_WINDOW_S}
      ORDER BY g.updated_at DESC
      LIMIT 1
    ) ev ON true
    -- The chat verdict separately: dual-tz event keys leave tz-duplicate
    -- twin rows for one occurrence, and whichever was touched last is not
    -- necessarily the one the chat sweep wrote raw.teamsChat on — a
    -- chat-less twin must not mask its sibling's verdict, so this lateral
    -- only looks at chat-bearing rows.
    LEFT JOIN LATERAL (
      SELECT g.raw->'teamsChat' AS teams_chat,
             (g.raw->>'external')::boolean AS chat_external
      FROM ${sql(SCHEMA)}.gmeet_meeting_cache g
      WHERE c.meeting_code IS NOT NULL
        AND g.meeting_code = c.meeting_code
        AND g.raw ? 'teamsChat'
        AND abs(extract(epoch FROM (
              COALESCE(g.event_start, g.conf_start) - c.event_start
            ))) <= ${OCCURRENCE_WINDOW_S}
      ORDER BY g.updated_at DESC
      LIMIT 1
    ) chatv ON true
    ${norecWhere(userId, opts)}
      AND to_char(${day}, 'YYYY-MM-DD') = ANY(${dayKeys})
    ORDER BY c.event_start DESC, c.event_key DESC
  `;
}

export interface CalendarMeetingsPage {
  days: Array<{ key: string; rows: CalendarMeetingDbRow[] }>;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Day-bucketed page: pick whole days newest-first (cursor-exclusive) until
 * the soft row target or the day cap is hit — a day is NEVER split across
 * pages — then fetch the rows for exactly those days.
 */
export async function listCalendarMeetingsPage(
  caller: Caller,
  view: CalendarMeetingView,
  opts: CalendarPageOpts
): Promise<CalendarMeetingsPage> {
  const day = view === 'unimported' ? unimportedDay(opts.tz) : norecDay(opts.tz);
  const where =
    view === 'unimported'
      ? unimportedWhere(caller, opts)
      : norecWhere(caller.userId, opts);
  const table = view === 'unimported' ? sql`gmeet_meeting_cache` : sql`calendar_event_cache`;

  // Per-day row counts drive the minRows accounting — for unimported, count
  // deduped (code, instant) pairs to match what unimportedRows returns.
  const dayCount =
    view === 'unimported'
      ? sql`count(DISTINCT (c.meeting_code, COALESCE(c.event_start, c.conf_start)))::int`
      : sql`count(*)::int`;
  const dayRows = await sql<Array<{ key: string; n: number }>>`
    SELECT to_char(${day}, 'YYYY-MM-DD') AS key, ${dayCount} AS n
    FROM ${sql(SCHEMA)}.${table} c
    ${where}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${opts.days + 1}
  `;

  const picked: string[] = [];
  let rowCount = 0;
  let i = 0;
  while (i < dayRows.length && picked.length < opts.days) {
    picked.push(dayRows[i]!.key);
    rowCount += dayRows[i]!.n;
    i++;
    if (rowCount >= opts.minRows) break;
  }
  const hasMore = i < dayRows.length;
  if (picked.length === 0) return { days: [], nextCursor: null, hasMore: false };

  const rows =
    view === 'unimported'
      ? await unimportedRows(caller, opts, picked)
      : await norecRows(caller.userId, opts, picked);
  const byDay = new Map<string, CalendarMeetingDbRow[]>(picked.map((k) => [k, []]));
  for (const r of rows) byDay.get(r.day_key)?.push(r);
  return {
    days: picked.map((key) => ({ key, rows: byDay.get(key) ?? [] })),
    nextCursor: hasMore ? picked[picked.length - 1]! : null,
    hasMore,
  };
}

export interface CalendarEventImportRow {
  event_key: string;
  event_id: string;
  recurring_event_id: string | null;
  ical_uid: string | null;
  title: string | null;
  event_start: string;
  event_end: string | null;
  meeting_code: string | null;
  organizer_email: string | null;
  attendees: CalendarEventAttendee[] | null;
  attachment_video_file_id: string | null;
  attachment_transcript_doc_id: string | null;
}

/**
 * The CALLER's cached calendar row for an occurrence they want to import
 * (CLI/API import-by-code, T3). Caller-scoped by construction — rows in this
 * cache are per-user from their own sweeps, so involvement is implicit.
 * `meetingCode` picks the latest PAST occurrence of that code (the "import
 * the one that just ended" case); `eventKey` is exact.
 */
export async function findCalendarEventForImport(
  userId: string,
  ref: { meetingCode?: string; eventKey?: string }
): Promise<CalendarEventImportRow | null> {
  if (!ref.meetingCode && !ref.eventKey) return null;
  const rows = await sql<CalendarEventImportRow[]>`
    SELECT event_key, event_id, recurring_event_id, ical_uid, title,
           event_start, event_end, meeting_code, organizer_email, attendees,
           attachment_video_file_id, attachment_transcript_doc_id
    FROM ${sql(SCHEMA)}.calendar_event_cache
    WHERE user_id = ${userId}
      AND ${ref.eventKey ? sql`event_key = ${ref.eventKey}` : sql`meeting_code = ${ref.meetingCode!} AND event_start <= now()`}
    ORDER BY event_start DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
