import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { OCCURRENCE_WINDOW_S } from '@/lib/meeting-evidence';
import {
  toLikePatterns,
  type MeetingFilters,
  type MeetingProvider,
} from '@/lib/server/meeting-filters';

// SQL twins of the shared people/provider filters (lib/server/meeting-filters)
// for every listing layer. Each builder returns a fragment of zero or more
// `AND (…)` clauses, so callers drop it straight into an existing WHERE —
// the same fragment feeds the rows query AND the tab-count query of a layer,
// which is what keeps counts and rows in agreement.
//
// Matching is ILIKE '%term%' against the stored strings (organizer email,
// attendee email + display name, speaker names), `ILIKE ANY(text[])` for the
// comma-OR list. Everything stays correct without indexes (these tables are
// small: hundreds of transcripts, low thousands of calendar rows per user).

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

type Fragment = ReturnType<typeof sql>;

/** `expr ILIKE ANY('{%a%,%b%}')` — one predicate per field for the OR list. */
function anyIlike(expr: Fragment, terms: readonly string[]): Fragment {
  return sql`${expr} ILIKE ANY(${toLikePatterns(terms)}::text[])`;
}

/** jsonb value as an array, or '[]' when it is null / not an array — keeps
 * jsonb_array_elements from throwing on malformed context. */
function jsonArray(expr: Fragment): Fragment {
  return sql`(CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END)`;
}

function jsonObject(expr: Fragment): Fragment {
  return sql`(CASE WHEN jsonb_typeof(${expr}) = 'object' THEN ${expr} ELSE '{}'::jsonb END)`;
}

/**
 * Attendee-list predicate: any element whose email OR display name matches.
 * Archive attendees (`gmeet_context.attendees`) carry `name`; calendar cache
 * attendees carry `displayName` — both are checked so one builder serves
 * every layer.
 */
function attendeesMatch(attendeesExpr: Fragment, terms: readonly string[]): Fragment {
  return sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(${jsonArray(attendeesExpr)}) att
    WHERE ${anyIlike(sql`att->>'email'`, terms)}
       OR ${anyIlike(sql`att->>'name'`, terms)}
       OR ${anyIlike(sql`att->>'displayName'`, terms)}
  )`;
}

// ---------------------------------------------------------------------------
// Archive (transcripts, alias `t`)
// ---------------------------------------------------------------------------

/**
 * The listing's provider derivation with 'upload' made explicit (the listing
 * SELECT leaves it NULL — "no provider glyph"): Teams is stamped, anything
 * that came through Meet carries a meetingCode / gmeet- id, the rest was
 * uploaded or pasted.
 */
export function archiveProviderExpr(): Fragment {
  return sql`(CASE
    WHEN t.gmeet_context->>'provider' = 'teams' THEN 'teams'
    WHEN t.assemblyai_id LIKE 'gmeet-%'
         OR t.gmeet_context->>'meetingCode' IS NOT NULL THEN 'gmeet'
    ELSE 'upload'
  END)`;
}

/**
 * Speaker names of an archive row: confirmed speaker_mappings labels
 * (owner-keyed — mappings live under the owner's user_id, same as the
 * speakers route reads them), the Meet/Teams transcript's attendee list
 * (`gmeet_context.meetTranscript.attendees`, plain strings), and AI
 * suggestions (`speaker_mappings.suggestions[label].name`).
 */
function archiveSpeakerMatch(terms: readonly string[]): Fragment {
  return sql`(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${jsonArray(sql`t.gmeet_context->'meetTranscript'->'attendees'`)}) mt(name)
      WHERE ${anyIlike(sql`mt.name`, terms)}
    )
    OR EXISTS (
      SELECT 1 FROM ${sql(SCHEMA)}.speaker_mappings sm
      WHERE sm.user_id = t.user_id
        AND sm.assemblyai_id = t.assemblyai_id
        AND (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(${jsonArray(sql`sm.speaker_labels`)}) lbl
            WHERE ${anyIlike(sql`lbl->>'customName'`, terms)}
          )
          OR EXISTS (
            SELECT 1 FROM jsonb_each(${jsonObject(sql`sm.suggestions`)}) sug
            WHERE ${anyIlike(sql`sug.value->>'name'`, terms)}
          )
        )
    )
  )`;
}

/**
 * `AND (…)` clauses for a transcripts query aliased `t` (listing v2 page +
 * counts, deep search). Empty fragment when nothing is set. `q` is NOT
 * applied here — the archive queries already have their own q search with
 * matched_in / snippet semantics.
 */
export function archiveFilterSql(f: MeetingFilters): Fragment {
  return sql`
    ${
      f.participant.length > 0
        ? sql`AND (
            ${anyIlike(sql`t.gmeet_context->>'organizerEmail'`, f.participant)}
            OR ${attendeesMatch(sql`t.gmeet_context->'attendees'`, f.participant)}
            OR ${archiveSpeakerMatch(f.participant)}
          )`
        : sql``
    }
    ${
      f.organizer.length > 0
        ? sql`AND ${anyIlike(sql`t.gmeet_context->>'organizerEmail'`, f.organizer)}`
        : sql``
    }
    ${
      f.provider.length > 0
        ? sql`AND ${archiveProviderExpr()} = ANY(${f.provider as MeetingProvider[]}::text[])`
        : sql``
    }
    ${f.speaker.length > 0 ? sql`AND ${archiveSpeakerMatch(f.speaker)}` : sql``}
  `;
}

/**
 * Attendee emails of an archive row for the listing's optional
 * `participants` field: organizer first, then attendees, de-duplicated,
 * lower-cased. Cheap (one jsonb walk per page row).
 */
export function archiveParticipantsExpr(): Fragment {
  return sql`(
    SELECT COALESCE(array_agg(e ORDER BY ord), '{}'::text[])
    FROM (
      SELECT DISTINCT ON (e) e, ord FROM (
        SELECT lower(t.gmeet_context->>'organizerEmail') AS e, 0 AS ord
        UNION ALL
        SELECT lower(att->>'email'), ordinality
        FROM jsonb_array_elements(${jsonArray(sql`t.gmeet_context->'attendees'`)}) WITH ORDINALITY AS x(att, ordinality)
      ) raw
      WHERE e IS NOT NULL AND e <> ''
      ORDER BY e, ord
    ) dedup
  )`;
}

// ---------------------------------------------------------------------------
// Calendar layers (/api/calendar-meetings)
// ---------------------------------------------------------------------------

/** Provider of a calendar-layer row: Teams cache rows carry `teams-…`
 * meeting codes, everything else (incl. no-Meet norec events) is 'gmeet' —
 * identical to both views' SELECT. 'upload' never matches here. */
function calendarProviderClause(codeExpr: Fragment, providers: MeetingProvider[]): Fragment {
  return sql`AND (CASE WHEN ${codeExpr} LIKE 'teams-%' THEN 'teams' ELSE 'gmeet' END)
             = ANY(${providers}::text[])`;
}

/**
 * norec view (alias `c` = calendar_event_cache, the caller's own rows):
 * organizer / attendees / title are right on the row.
 */
export function norecFilterSql(f: MeetingFilters): Fragment {
  const q = f.q ? [f.q] : [];
  return sql`
    ${
      f.participant.length > 0
        ? sql`AND (
            ${anyIlike(sql`c.organizer_email`, f.participant)}
            OR ${attendeesMatch(sql`c.attendees`, f.participant)}
          )`
        : sql``
    }
    ${f.organizer.length > 0 ? sql`AND ${anyIlike(sql`c.organizer_email`, f.organizer)}` : sql``}
    ${f.provider.length > 0 ? calendarProviderClause(sql`c.meeting_code`, f.provider) : sql``}
    ${
      q.length > 0
        ? sql`AND (
            ${anyIlike(sql`c.title`, q)}
            OR ${anyIlike(sql`c.organizer_email`, q)}
            OR ${attendeesMatch(sql`c.attendees`, q)}
          )`
        : sql``
    }
  `;
}

/**
 * unimported view (alias `c` = gmeet_meeting_cache, the global artifact
 * cache). The cache row itself only knows the organizer email; attendees
 * and the title come from the caller's own calendar row for the same
 * occurrence (meeting code, ±12h — the same pairing the view's SELECT uses)
 * and from reminder rows. The cache's Gemini-parsed `speakers` array is
 * deliberately NOT matched: speaker names are an archive-only match per the
 * contract, the unimported row never displays them, and matching them would
 * leak "did X speak in meeting Y" for meetings the caller was never invited
 * to. Self-contained
 * EXISTS subqueries, so the fragment works in the rows query, the day-bucket
 * query AND the count query regardless of which joins they carry.
 */
export function unimportedFilterSql(userId: string, f: MeetingFilters): Fragment {
  const viaCalendarRow = (pred: Fragment): Fragment => sql`EXISTS (
    SELECT 1 FROM ${sql(SCHEMA)}.calendar_event_cache ce
    WHERE ce.user_id = ${userId}
      AND ce.meeting_code = c.meeting_code
      AND abs(extract(epoch FROM (
            ce.event_start - COALESCE(c.event_start, c.conf_start)
          ))) <= ${OCCURRENCE_WINDOW_S}
      AND (${pred})
  )`;
  const viaReminderTitle = (terms: readonly string[]): Fragment => sql`EXISTS (
    SELECT 1 FROM ${sql(SCHEMA)}.gmeet_reminders r
    WHERE r.event_key = c.event_key AND ${anyIlike(sql`r.title`, terms)}
  )`;
  const q = f.q ? [f.q] : [];
  return sql`
    ${
      f.participant.length > 0
        ? sql`AND (
            ${anyIlike(sql`c.organizer_email`, f.participant)}
            OR ${viaCalendarRow(sql`
              ${anyIlike(sql`ce.organizer_email`, f.participant)}
              OR ${attendeesMatch(sql`ce.attendees`, f.participant)}
            `)}
          )`
        : sql``
    }
    ${
      f.organizer.length > 0
        ? sql`AND (
            ${anyIlike(sql`c.organizer_email`, f.organizer)}
            OR ${viaCalendarRow(anyIlike(sql`ce.organizer_email`, f.organizer))}
          )`
        : sql``
    }
    ${f.provider.length > 0 ? calendarProviderClause(sql`c.meeting_code`, f.provider) : sql``}
    ${
      q.length > 0
        ? sql`AND (
            ${viaReminderTitle(q)}
            OR ${anyIlike(sql`c.organizer_email`, q)}
            OR ${viaCalendarRow(sql`
              ${anyIlike(sql`ce.title`, q)}
              OR ${anyIlike(sql`ce.organizer_email`, q)}
              OR ${attendeesMatch(sql`ce.attendees`, q)}
            `)}
          )`
        : sql``
    }
  `;
}
