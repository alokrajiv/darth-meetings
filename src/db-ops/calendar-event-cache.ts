import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

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

/** Same ±12h occurrence window as findImportedByMeetingCodes (gmeet-sync). */
const OCCURRENCE_WINDOW_S = 12 * 3600;

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
       attendee_count, attendees)
    SELECT ${userId}, e."eventKey", e."eventId", e."recurringEventId", e."iCalUID",
           e.title, e."eventStart", e."eventEnd", e."meetingCode",
           e."organizerEmail", e."organizerSelf", e."attendeeCount", e.attendees
    FROM jsonb_to_recordset(${sql.json(batch as unknown as never)}) AS e(
      "eventKey" text, "eventId" text, "recurringEventId" text, "iCalUID" text,
      title text, "eventStart" timestamptz, "eventEnd" timestamptz,
      "meetingCode" text, "organizerEmail" text, "organizerSelf" boolean,
      "attendeeCount" int, attendees jsonb
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
      last_seen_at       = now()
  `;
}

// ---------------------------------------------------------------------------
// /api/calendar-meetings listing queries
// ---------------------------------------------------------------------------

export type CalendarMeetingView = 'unimported' | 'norec';

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
  organizer_email: string | null;
  organizer_self: boolean | null;
  attendee_count: number | null;
  provider: 'gmeet' | 'teams';
  has_meet: boolean;
  muted: boolean;
}

export interface CalendarRangeOpts {
  /** Validated IANA name — the route falls back to 'UTC' on anything odd. */
  tz: string;
  /** YYYY-MM-DD inclusive, interpreted in tz. */
  from?: string | null;
  to?: string | null;
  /** Day key (exclusive): only days strictly older. */
  cursor?: string | null;
}

export interface CalendarPageOpts extends CalendarRangeOpts {
  days: number;
  minRows: number;
}

type Caller = { userId: string; email: string };

/** Occurrence timestamp of a stored import — same COALESCE chain as
 * findImportedByMeetingCodes (gmeet-sync.ts). */
const IMPORT_OCCURRENCE = sql`
  COALESCE(
    t.gmeet_context->>'startTime',
    t.gmeet_context->'actuals'->>'conferenceStart',
    t.recorded_at::text
  )::timestamptz
`;

function dayFilters(
  dayExpr: ReturnType<typeof sql>,
  opts: CalendarRangeOpts
): ReturnType<typeof sql> {
  return sql`
    ${opts.from ? sql`AND ${dayExpr} >= ${opts.from}::date` : sql``}
    ${opts.to ? sql`AND ${dayExpr} <= ${opts.to}::date` : sql``}
    ${opts.cursor ? sql`AND ${dayExpr} < ${opts.cursor}::date` : sql``}
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

function unimportedWhere(opts: CalendarRangeOpts): ReturnType<typeof sql> {
  return sql`
    WHERE COALESCE(c.event_start, c.conf_start) IS NOT NULL
      AND (c.recording_count > 0 OR COALESCE(jsonb_array_length(c.transcript_doc_ids), 0) > 0)
      AND NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcripts t
        WHERE t.deleted_at IS NULL
          AND (
            t.gmeet_context->>'meetingCode' = c.meeting_code
            OR (
              c.raw->'teamsResolution'->>'joinWebUrl' IS NOT NULL
              AND t.gmeet_context->'teams'->>'joinWebUrl' = c.raw->'teamsResolution'->>'joinWebUrl'
            )
          )
          AND abs(extract(epoch FROM (
                ${IMPORT_OCCURRENCE} - COALESCE(c.event_start, c.conf_start)
              ))) <= ${OCCURRENCE_WINDOW_S}
      )
      ${dayFilters(unimportedDay(opts.tz), opts)}
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
          AND (g.recording_count > 0 OR COALESCE(jsonb_array_length(g.transcript_doc_ids), 0) > 0)
          AND abs(extract(epoch FROM (
                COALESCE(g.event_start, g.conf_start) - c.event_start
              ))) <= ${OCCURRENCE_WINDOW_S}
      ))
      AND (c.meeting_code IS NULL OR NOT EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.transcripts t
        WHERE t.deleted_at IS NULL
          AND t.gmeet_context->>'meetingCode' = c.meeting_code
          AND abs(extract(epoch FROM (${IMPORT_OCCURRENCE} - c.event_start))) <= ${OCCURRENCE_WINDOW_S}
      ))
      ${dayFilters(norecDay(opts.tz), opts)}
  `;
}

/** Tab counts — respect from/to (they label the tabs over a filtered list),
 * never the cursor. */
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
      ${unimportedWhere(range)}
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
      (c.recording_count > 0) AS has_recording,
      (COALESCE(jsonb_array_length(c.transcript_doc_ids), 0) > 0) AS has_transcript,
      c.recording_count,
      c.transcript_parseable,
      COALESCE(c.organizer_email, cal.organizer_email) AS organizer_email,
      COALESCE(cal.organizer_self, lower(c.organizer_email) = ${caller.email.toLowerCase()}) AS organizer_self,
      cal.attendee_count,
      CASE WHEN c.meeting_code LIKE 'teams-%' THEN 'teams' ELSE 'gmeet' END AS provider,
      true AS has_meet,
      EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.gmeet_sync_skips s
        WHERE s.user_id = ${caller.userId}
          AND s.event_key IN (c.meeting_code, c.event_key)
      ) AS muted
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
      SELECT ce.title, ce.event_end, ce.organizer_email, ce.organizer_self, ce.attendee_count
      FROM ${sql(SCHEMA)}.calendar_event_cache ce
      WHERE ce.user_id = ${caller.userId}
        AND ce.meeting_code = c.meeting_code
        AND abs(extract(epoch FROM (
              ce.event_start - COALESCE(c.event_start, c.conf_start)
            ))) <= ${OCCURRENCE_WINDOW_S}
      ORDER BY abs(extract(epoch FROM (
        ce.event_start - COALESCE(c.event_start, c.conf_start)
      )))
      LIMIT 1
    ) cal ON true
    ${unimportedWhere(opts)}
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
      c.organizer_email,
      c.organizer_self,
      c.attendee_count,
      'gmeet' AS provider,
      (c.meeting_code IS NOT NULL) AS has_meet,
      EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.gmeet_sync_skips s
        WHERE s.user_id = c.user_id
          AND s.event_key IN (c.meeting_code, c.event_id, c.event_key)
      ) AS muted
    FROM ${sql(SCHEMA)}.calendar_event_cache c
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
    view === 'unimported' ? unimportedWhere(opts) : norecWhere(caller.userId, opts);
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
