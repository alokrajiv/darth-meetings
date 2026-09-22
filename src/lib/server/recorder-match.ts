import 'server-only';
import {
  callerInvolvedInOccurrence,
  findCalendarEventForImport,
  listOccurrencesOverlapping,
} from '@/db-ops/calendar-event-cache';
import type { CalendarOverlapRow } from '@/db-ops/calendar-event-cache';
import type { ConferenceProvider, RecorderMatch, RecorderMatchCandidate } from '@/lib/recorder';
import { callProvider } from '@/lib/recorder';
import type { RecorderCall } from '@/db-ops/recorder';
import type { SuggestedEvent } from '@/lib/format';

/**
 * "Which meeting is this recording of?" — run on every write to
 * `recorder_recordings` (docs/recorder-beta-plan.md, Stream S1).
 *
 * Cache only: the OWNER's own `calendar_event_cache` rows, no calendar API
 * read. Score = time overlap (how much of the shorter of recording/event the
 * two share) blended with title similarity (a Teams window title contains the
 * meeting subject; a Meet window title IS the meeting name). The top
 * candidate wins if it clears MIN_SCORE; the runners-up are stored so a human
 * (or a later fix-up) can see what else was in the frame.
 */

export const OVERLAP_WEIGHT = 0.7;
const TITLE_WEIGHT = 0.3;
/** Below this we store candidates but declare no match. */
const MIN_SCORE = 0.25;
/** A recording still in progress has no end — assume this much. */
const ASSUMED_OPEN_MS = 60 * 60 * 1000;
/** Calendar events with no end (rare) — same assumption as the listing. */
const ASSUMED_EVENT_MS = 60 * 60 * 1000;
/**
 * A candidate whose product contradicts the call's (D3): a Slack huddle
 * against a Google Meet invite. It stays a candidate — the human may still
 * know better — but its score is capped here, below every confidence bar and
 * below any same-product candidate that overlaps at all.
 */
export const PROVIDER_MISMATCH_CAP = 0.3;

/** The Meet code Google puts on an event: `abc-defg-hij`. */
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

/**
 * Which product an occurrence's invite describes, or null when it does not
 * say. There is no provider column on `calendar_event_cache` — the only
 * evidence is the Meet code (or our synthetic `teams-…` code) and the join
 * URL in `location`/`description`, which is what `conference_hint` carries.
 */
export function occurrenceProvider(
  row: Pick<CalendarOverlapRow, 'meeting_code' | 'conference_hint'>
): ConferenceProvider | null {
  const code = (row.meeting_code ?? '').trim();
  if (code.startsWith('teams-')) return 'teams';
  if (MEET_CODE_RE.test(code)) return 'meet';
  const hay = (row.conference_hint ?? '').toLowerCase();
  if (hay.includes('teams.microsoft.com')) return 'teams';
  if (hay.includes('meet.google.com')) return 'meet';
  if (hay.includes('zoom.us')) return 'zoom';
  if (hay.includes('webex.com')) return 'webex';
  // A code we could not parse still means SOME conference; it just does not
  // say which, and an unknown provider never vetoes.
  return null;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'call', 'meeting', 'meet', 'teams', 'zoom',
  'microsoft', 'google', 'weekly', 'daily', 'sync', 'catch', 'up', 'chat',
]);

/** Lower-cased alphanumeric tokens of length >= 3, minus filler words. */
function tokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

/** 0..1 — share of the SMALLER token set that appears in the other. A window
 * title ("Weekly sync | Microsoft Teams") is longer than the subject, so
 * containment beats Jaccard here. */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (big.has(t)) hits++;
  return hits / small.size;
}

/** 0..1 — overlap seconds / the shorter of the two spans. */
export function overlapRatio(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  if (overlap <= 0) return 0;
  const shortest = Math.max(1, Math.min(aEnd - aStart, bEnd - bStart));
  return Math.min(1, overlap / shortest);
}

export interface MatchInput {
  startedAt: string | null | undefined;
  endedAt?: string | null;
  call?: RecorderCall | null;
}

export async function matchRecording(
  ownerUserId: string,
  input: MatchInput
): Promise<RecorderMatch | null> {
  if (!input.startedAt) return null;
  const start = Date.parse(input.startedAt);
  if (Number.isNaN(start)) return null;
  const endRaw = input.endedAt ? Date.parse(input.endedAt) : NaN;
  const end = Number.isNaN(endRaw) || endRaw <= start ? start + ASSUMED_OPEN_MS : endRaw;

  const rows = await listOccurrencesOverlapping(
    ownerUserId,
    new Date(start).toISOString(),
    new Date(end).toISOString()
  );
  if (rows.length === 0) return null;

  return scoreOccurrences(
    { startMs: start, endMs: end, call: input.call ?? null },
    rows,
    new Date().toISOString()
  );
}

/**
 * The pure half of `matchRecording`: score the caller's overlapping
 * occurrences against one recording. Exported so the rules can be tested
 * without a Postgres handle (src/lib/server/__tests__/recorder-match.test.ts).
 */
export function scoreOccurrences(
  input: { startMs: number; endMs: number; call?: RecorderCall | null },
  rows: CalendarOverlapRow[],
  matchedAt: string
): RecorderMatch | null {
  const { startMs: start, endMs: end } = input;
  const callTitle = typeof input.call?.title === 'string' ? input.call.title : null;
  const provOfCall = callProvider(input.call);

  const candidates: RecorderMatchCandidate[] = rows
    .map((r) => {
      const es = new Date(r.event_start).getTime();
      const ee = r.event_end ? new Date(r.event_end).getTime() : es + ASSUMED_EVENT_MS;
      const overlap = overlapRatio(start, end, es, ee <= es ? es + ASSUMED_EVENT_MS : ee);
      const titleScore = titleSimilarity(callTitle, r.title);
      const provider = occurrenceProvider(r);
      // D3: known-and-different products veto confidence. Unknown on either
      // side changes nothing — most Slack/WhatsApp calls have no invite at
      // all and most invites carry no product we can read.
      const mismatch = !!provOfCall && !!provider && provOfCall !== provider;
      const blended = OVERLAP_WEIGHT * overlap + TITLE_WEIGHT * titleScore;
      const score = mismatch ? Math.min(blended, PROVIDER_MISMATCH_CAP) : blended;
      return {
        event_key: r.event_key,
        event_id: r.event_id,
        meeting_code: r.meeting_code,
        occ_start: new Date(r.event_start).toISOString(),
        occ_end: r.event_end ? new Date(r.event_end).toISOString() : null,
        title: r.title,
        overlap: Math.round(overlap * 1000) / 1000,
        title_score: Math.round(titleScore * 1000) / 1000,
        score: Math.round(score * 1000) / 1000,
        provider,
        ...(mismatch ? { provider_mismatch: true } : {}),
      };
    })
    .filter((c) => c.overlap > 0)
    // A vetoed candidate never outranks a same-product one: the cap does
    // most of that, and the tie-break finishes it.
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(!!a.provider_mismatch) - Number(!!b.provider_mismatch) ||
        b.overlap - a.overlap
    );

  const best = candidates[0];
  if (!best || best.score < MIN_SCORE) return null;
  return {
    ...best,
    candidates: candidates.slice(1, 4),
    matched_at: matchedAt,
    call_provider: provOfCall,
  };
}

/**
 * The match as the SUGGESTION the rest of the app speaks (D2). Pure — the
 * upload route calls it with the registry row it already read.
 *
 * Everything here is either the occurrence's own identity or the numbers
 * behind the guess, plus the tray's `call.kind`: the human is being asked
 * "is this Slack huddle the Triton next steps! Meet invite?" and must be able
 * to see both halves before answering.
 */
export function suggestedEventFromMatch(
  matched: RecorderMatch | null | undefined,
  call?: RecorderCall | null
): SuggestedEvent | null {
  if (!matched) return null;
  const key = typeof matched.event_key === 'string' ? matched.event_key.trim() : '';
  if (!key) return null;
  return {
    key,
    eventId: matched.event_id ?? null,
    title: matched.title ?? null,
    startIso: matched.occ_start,
    endIso: matched.occ_end ?? null,
    provider: matched.provider ?? null,
    meetingCode: matched.meeting_code ?? null,
    score: matched.score,
    overlap: matched.overlap,
    titleScore: matched.title_score,
    callKind: typeof call?.kind === 'string' ? call.kind : null,
  };
}

// ---------------------------------------------------------------------------
// Occurrence references ( ?event= on the recordings routes )
// ---------------------------------------------------------------------------

export interface ResolvedOccurrence {
  code: string | null;
  /** UTC ISO, or null when the ref was a bare code with no cached occurrence. */
  instant: string | null;
  title: string | null;
  /** The caller is organizer/invitee/holder of this occurrence. */
  involved: boolean;
}

/**
 * `?event=` → an occurrence the caller may ask about. Accepts the three refs
 * the rest of the app already speaks:
 *   - `<eventId>|<startIso>` — the calendar `key` (caller's own cache row;
 *     involvement implicit),
 *   - `<meetingCode>|<startIso>` — the occurrence key used by the auto-sync
 *     ledger and the listing rows,
 *   - `<meetingCode>` — the caller's latest PAST occurrence of that code
 *     (same rule as `upload --event`).
 *
 * Involvement is decided by callerInvolvedCodes — the canonical predicate.
 * An uninvolved caller gets `involved:false` and the route answers with an
 * EMPTY list, never a 403 (a 403 is itself an oracle).
 */
export async function resolveOccurrenceRef(
  caller: { userId: string; email: string },
  raw: string | null | undefined
): Promise<ResolvedOccurrence | null> {
  const ref = raw?.trim();
  if (!ref || ref.length > 512) return null;

  if (ref.includes('|')) {
    const own = await findCalendarEventForImport(caller.userId, { eventKey: ref });
    if (own) {
      return {
        code: own.meeting_code,
        instant: new Date(own.event_start).toISOString(),
        title: own.title,
        involved: true,
      };
    }
    const cut = ref.indexOf('|');
    const code = ref.slice(0, cut);
    const startRaw = ref.slice(cut + 1);
    const t = Date.parse(startRaw);
    if (!code || Number.isNaN(t)) return null;
    const instant = new Date(t).toISOString();
    const involved = await callerInvolvedInOccurrence(caller, code, instant);
    return { code, instant, title: null, involved };
  }

  const row = await findCalendarEventForImport(caller.userId, { meetingCode: ref });
  if (row) {
    return {
      code: row.meeting_code ?? ref,
      instant: new Date(row.event_start).toISOString(),
      title: row.title,
      involved: true,
    };
  }
  const involved = await callerInvolvedInOccurrence(caller, ref, null);
  return { code: ref, instant: null, title: null, involved };
}

/**
 * Re-match on a write: the incoming partial wins, anything it omits comes
 * from the stored row — so a PATCH that only carries `ended_at` still scores
 * against the original `started_at` and call title.
 */
export async function matchForWrite(
  userId: string,
  existing: { started_at: string | null; ended_at: string | null; call: RecorderCall | null } | null,
  write: { startedAt?: string | null; endedAt?: string | null; call?: unknown }
): Promise<RecorderMatch | null> {
  const iso = (v: string | null | undefined) => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };
  const startedAt = iso(write.startedAt) ?? iso(existing?.started_at ?? null);
  if (!startedAt) return null;
  const endedAt = iso(write.endedAt) ?? iso(existing?.ended_at ?? null);
  const call = ((write.call as RecorderCall | undefined) ?? existing?.call ?? null) as RecorderCall | null;
  return matchRecording(userId, { startedAt, endedAt, call });
}
