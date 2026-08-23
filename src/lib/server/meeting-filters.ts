/**
 * People / provider filters shared by every meeting listing layer:
 *
 *   GET /api/transcripts?v=2            (archive listing + tab counts)
 *   GET /api/transcripts/search          (deep search)
 *   GET /api/calendar-meetings?view=…    (unimported / norec calendar layers)
 *
 * THE contract (all three routes accept exactly these names):
 *
 *   participant=<csv>  case-insensitive substring, comma = OR. Matches the
 *                      organizer email, attendee emails AND attendee display
 *                      names, and (archive rows only) speaker names —
 *                      confirmed speaker_mappings names, the Meet/Teams
 *                      transcript's attendee list, AI speaker suggestions.
 *                      "@lp-global.com" → domain filter, "nicolas" → name.
 *   organizer=<csv>    case-insensitive substring on the organizer email.
 *   provider=<csv>     teams | gmeet | upload (anything else → 400).
 *                      Calendar layers never have 'upload' rows.
 *   speaker=<csv>      archive only — substring on speaker names (the
 *                      calendar layers ignore it; they have no speakers).
 *   q=<string>         free text (>= 2 chars, shorter is ignored — same rule
 *                      the listing v2 always had).
 *
 * Semantics: the given filters AND together; each filter's comma list is OR.
 * Filters apply to the rows AND to the tab counts.
 *
 * This module is pure (no DB import) so it can be unit-tested; the SQL
 * fragment builders that consume a MeetingFilters live next to the queries
 * in src/db-ops/meeting-filter-sql.ts.
 */

export const MEETING_PROVIDERS = ['teams', 'gmeet', 'upload'] as const;
export type MeetingProvider = (typeof MEETING_PROVIDERS)[number];

export interface MeetingFilters {
  /** Lower-cased, trimmed, de-duplicated OR terms (empty = not filtering). */
  participant: string[];
  organizer: string[];
  provider: MeetingProvider[];
  speaker: string[];
  /** Trimmed free-text query, or null when absent / shorter than 2 chars. */
  q: string | null;
}

export const EMPTY_MEETING_FILTERS: MeetingFilters = Object.freeze({
  participant: [],
  organizer: [],
  provider: [],
  speaker: [],
  q: null,
}) as MeetingFilters;

export type ParsedMeetingFilters =
  | { ok: true; filters: MeetingFilters }
  | { ok: false; error: string };

/** Bounds that keep a hostile query string from exploding the SQL. */
export const MAX_FILTER_TERMS = 20;
export const MAX_FILTER_TERM_LEN = 120;
export const MIN_Q_LEN = 2;

type ParamSource =
  | URLSearchParams
  | Record<string, string | string[] | null | undefined>;

function readParam(src: ParamSource, name: string): string | null {
  if (src instanceof URLSearchParams) {
    // Repeated params (?participant=a&participant=b) are treated like a
    // comma list — joined, so the split below sees every value.
    const all = src.getAll(name);
    return all.length === 0 ? null : all.join(',');
  }
  const v = src[name];
  if (Array.isArray(v)) return v.join(',');
  return v ?? null;
}

/** Postgres rejects a NUL byte inside a text parameter ("invalid byte
 * sequence for encoding UTF8: 0x00") — it can never match anything, so it is
 * stripped from every term instead of becoming a 500. */
function stripNul(s: string): string {
  return s.replace(/\0/g, '');
}

/**
 * Split a comma list into lower-cased, trimmed, de-duplicated terms. Empty
 * entries vanish (`participant=,,` is "no filter"); NUL bytes are stripped.
 * Does NOT enforce the MAX_FILTER_TERMS / MAX_FILTER_TERM_LEN bounds — the
 * parser rejects over-long lists explicitly (→ 400) rather than silently
 * narrowing the result set.
 */
export function splitFilterList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const term = stripNul(part).trim().toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/** Error message when a list breaks the bounds, or null when it is fine. */
function boundsError(name: string, terms: readonly string[]): string | null {
  if (terms.length > MAX_FILTER_TERMS) {
    return `Too many ${name} terms (${terms.length}) — max ${MAX_FILTER_TERMS} comma-separated values`;
  }
  const long = terms.find((t) => t.length > MAX_FILTER_TERM_LEN);
  if (long !== undefined) {
    return `${name} term too long (${long.length} chars) — max ${MAX_FILTER_TERM_LEN}`;
  }
  return null;
}

function isProvider(v: string): v is MeetingProvider {
  return (MEETING_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Parse the shared filter params off a query string. Rejections (→ 400 at
 * the route): unknown provider values, more than MAX_FILTER_TERMS OR-terms
 * in one list, a term longer than MAX_FILTER_TERM_LEN. Everything else
 * degrades to "not filtering". `q` shorter than MIN_Q_LEN is null (ignored).
 */
export function parseMeetingFilters(src: ParamSource): ParsedMeetingFilters {
  const providerTerms = splitFilterList(readParam(src, 'provider'));
  const bad = providerTerms.filter((p) => !isProvider(p));
  if (bad.length > 0) {
    return {
      ok: false,
      error: `Invalid provider value(s): ${bad.join(', ')} — expected ${MEETING_PROVIDERS.join('|')} (comma-separated for OR)`,
    };
  }
  const participant = splitFilterList(readParam(src, 'participant'));
  const organizer = splitFilterList(readParam(src, 'organizer'));
  const speaker = splitFilterList(readParam(src, 'speaker'));
  const boundsErr =
    boundsError('participant', participant) ??
    boundsError('organizer', organizer) ??
    boundsError('speaker', speaker);
  if (boundsErr) return { ok: false, error: boundsErr };
  const qRaw = stripNul(readParam(src, 'q') ?? '').trim();
  return {
    ok: true,
    filters: {
      participant,
      organizer,
      provider: providerTerms.filter(isProvider),
      speaker,
      q: qRaw.length >= MIN_Q_LEN ? qRaw : null,
    },
  };
}

/** True when any people/provider filter is set (q excluded — callers that
 * already handle q separately use this to short-circuit the extra joins). */
export function hasPeopleFilters(f: MeetingFilters): boolean {
  return (
    f.participant.length > 0 ||
    f.organizer.length > 0 ||
    f.provider.length > 0 ||
    f.speaker.length > 0
  );
}

/** Escape LIKE metacharacters (`%`, `_`, `\`) — same escaping the listing's
 * q search has always used. */
export function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, (m) => `\\${m}`);
}

/** `%term%` patterns for `ILIKE ANY(…)`. */
export function toLikePatterns(terms: readonly string[]): string[] {
  return terms.map((t) => `%${escapeLike(t)}%`);
}
