import 'server-only';
import {
  callerInvolvedInOccurrence,
  findCalendarEventForImport,
  listOccurrencesOverlapping,
} from '@/db-ops/calendar-event-cache';
import type { RecorderMatch, RecorderMatchCandidate } from '@/lib/recorder';
import type { RecorderCall } from '@/db-ops/recorder';

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

const OVERLAP_WEIGHT = 0.7;
const TITLE_WEIGHT = 0.3;
/** Below this we store candidates but declare no match. */
const MIN_SCORE = 0.25;
/** A recording still in progress has no end — assume this much. */
const ASSUMED_OPEN_MS = 60 * 60 * 1000;
/** Calendar events with no end (rare) — same assumption as the listing. */
const ASSUMED_EVENT_MS = 60 * 60 * 1000;

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

  const callTitle = typeof input.call?.title === 'string' ? input.call.title : null;
  const candidates: RecorderMatchCandidate[] = rows
    .map((r) => {
      const es = new Date(r.event_start).getTime();
      const ee = r.event_end ? new Date(r.event_end).getTime() : es + ASSUMED_EVENT_MS;
      const overlap = overlapRatio(start, end, es, ee <= es ? es + ASSUMED_EVENT_MS : ee);
      const titleScore = titleSimilarity(callTitle, r.title);
      return {
        event_key: r.event_key,
        event_id: r.event_id,
        meeting_code: r.meeting_code,
        occ_start: new Date(r.event_start).toISOString(),
        title: r.title,
        overlap: Math.round(overlap * 1000) / 1000,
        title_score: Math.round(titleScore * 1000) / 1000,
        score: Math.round((OVERLAP_WEIGHT * overlap + TITLE_WEIGHT * titleScore) * 1000) / 1000,
      };
    })
    .filter((c) => c.overlap > 0)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap);

  const best = candidates[0];
  if (!best || best.score < MIN_SCORE) return null;
  return { ...best, candidates: candidates.slice(1, 4), matched_at: new Date().toISOString() };
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
