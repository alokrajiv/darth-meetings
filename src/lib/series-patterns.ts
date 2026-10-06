/**
 * Curated-series patterns — the "grepper" that decides which meetings belong
 * to a series (docs/curated-series-spec.md §2, owner 2026-10-06).
 *
 * A series carries a list of patterns; it matches a meeting when ANY of them
 * matches. Two kinds:
 *
 *  - `title`: a JavaScript RegExp source, evaluated case-insensitively on the
 *    calendar event's title (gmeet_context.eventTitle), falling back to the
 *    meeting's own title. That is the field humans name recurring calls by.
 *  - `invite`: who is on the invite — every address in `all`, at least one in
 *    `any`, optionally "nobody from outside the company", "a recurring
 *    event", "at most N people". For 1:1s whose titles drift.
 *
 * Empty patterns match nothing: such a series has manual members only.
 *
 * Evaluated in JS ONLY, never as Postgres `~*`: the two regex dialects differ
 * (`\b`, `\d` inside a cooked template string, lookarounds…), and the same
 * function must judge a stored meeting, a calendar row and the browser's
 * preview identically.
 *
 * Several series match → the lowest `priority` wins, then the lowest id
 * (`pickSeries`). A meeting is in at most one series.
 *
 * Pure + client-safe (unit-tested in src/lib/__tests__/series-patterns.test.ts).
 */

import { INTERNAL_DOMAINS } from '@/lib/internal-domains';

export interface TitlePattern {
  kind: 'title';
  /** JS RegExp source, flags 'i'. */
  regex: string;
}

export interface InvitePattern {
  kind: 'invite';
  /** Every one of these emails is on the invite. */
  all: string[];
  /** At least one of these (optional). */
  any?: string[];
  /** No attendee outside the internal domains (lib/internal-domains). */
  internalOnly?: boolean;
  /** The occurrence is part of a recurring calendar event. */
  recurringOnly?: boolean;
  /** At most this many people on the invite (organizer included). */
  maxPeople?: number;
}

export type SeriesPattern = TitlePattern | InvitePattern;

/** What a pattern is evaluated against — built by the adapters below from a
 * stored meeting (`factsFromContext`) or a calendar row
 * (`factsFromCalendarRow`). */
export interface SeriesFacts {
  /** gmeet_context.eventTitle ?? transcripts.title (calendar: title). */
  title: string | null;
  /** Attendees + organizer, lower-cased, de-duplicated, calendar resources
   * (rooms, group calendars) dropped. */
  emails: string[];
  /** gmeet_context.recurringEventId / calendar recurring_event_id present. */
  recurring: boolean;
}

export const MAX_PATTERNS = 20;
export const MAX_REGEX_LENGTH = 300;
/** Titles are matched on their first N characters — a defence-in-depth cap on
 * regex cost; no real meeting title comes near it. */
const MAX_MATCHED_TITLE = 400;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A group that contains a quantifier and is itself quantified — `(a+)+`,
 * `(x*y)*`, `(\w{2,})+` — the classic catastrophic-backtracking shape. Any
 * person may write a pattern and the server runs it over every meeting, so
 * such a pattern is refused rather than trusted (spec deviation: an extra
 * rejection beyond the length cap). Conservative on purpose: a false refusal
 * costs a rewrite, a false accept can wedge the event loop.
 */
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

function normEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e || null;
}

/** Calendar resources are not people: rooms, group/holiday calendars. */
function isCalendarResource(email: string): boolean {
  const domain = email.split('@')[1] ?? '';
  return domain === 'calendar.google.com' || domain.endsWith('.calendar.google.com');
}

function cleanEmails(list: ReadonlyArray<unknown>): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const e = normEmail(raw);
    if (!e || !e.includes('@') || isCalendarResource(e)) continue;
    out.add(e);
  }
  return [...out];
}

export type ValidatePatternsResult =
  | { ok: true; patterns: SeriesPattern[] }
  | { ok: false; error: string };

function validateEmailList(
  raw: unknown,
  label: string,
  where: string
): { ok: true; emails: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${where}: ${label} must be a list of emails` };
  const emails: string[] = [];
  for (const v of raw) {
    const e = normEmail(v);
    if (!e || !EMAIL_RE.test(e)) {
      return { ok: false, error: `${where}: "${String(v)}" is not a valid email` };
    }
    if (!emails.includes(e)) emails.push(e);
  }
  return { ok: true, emails };
}

/**
 * THE gate every write route runs (create, edit, preview, seed). Returns the
 * normalised patterns (emails lower-cased, booleans only when true) or the
 * first problem in plain words. Rejects: a non-array, more than MAX_PATTERNS,
 * an unknown kind, a regex that does not compile / is longer than
 * MAX_REGEX_LENGTH / nests quantifiers, an invite rule with an empty `all`,
 * an invalid email, a non-positive or non-integer `maxPeople`.
 */
export function validatePatterns(input: unknown): ValidatePatternsResult {
  if (!Array.isArray(input)) return { ok: false, error: 'patterns must be a list' };
  if (input.length > MAX_PATTERNS) {
    return { ok: false, error: `at most ${MAX_PATTERNS} patterns per series` };
  }
  const out: SeriesPattern[] = [];
  for (let i = 0; i < input.length; i++) {
    const where = `pattern ${i + 1}`;
    const p = input[i] as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return { ok: false, error: `${where}: not an object` };
    if (p.kind === 'title') {
      if (typeof p.regex !== 'string' || !p.regex.trim()) {
        return { ok: false, error: `${where}: the title pattern is empty` };
      }
      const regex = p.regex.trim();
      if (regex.length > MAX_REGEX_LENGTH) {
        return { ok: false, error: `${where}: longer than ${MAX_REGEX_LENGTH} characters` };
      }
      try {
        new RegExp(regex, 'i');
      } catch (err) {
        return {
          ok: false,
          error: `${where}: not a valid regex (${err instanceof Error ? err.message : String(err)})`,
        };
      }
      if (NESTED_QUANTIFIER_RE.test(regex)) {
        return {
          ok: false,
          error: `${where}: a quantified group containing a quantifier (like "(a+)+") is not allowed — it can take forever to evaluate`,
        };
      }
      out.push({ kind: 'title', regex });
      continue;
    }
    if (p.kind === 'invite') {
      const all = validateEmailList(p.all, '"all"', where);
      if (!all.ok) return all;
      if (all.emails.length === 0) {
        return { ok: false, error: `${where}: an invite rule needs at least one email in "all"` };
      }
      const pattern: InvitePattern = { kind: 'invite', all: all.emails };
      if (p.any !== undefined && p.any !== null) {
        const any = validateEmailList(p.any, '"any"', where);
        if (!any.ok) return any;
        if (any.emails.length > 0) pattern.any = any.emails;
      }
      if (p.internalOnly !== undefined && typeof p.internalOnly !== 'boolean') {
        return { ok: false, error: `${where}: internalOnly must be true or false` };
      }
      if (p.recurringOnly !== undefined && typeof p.recurringOnly !== 'boolean') {
        return { ok: false, error: `${where}: recurringOnly must be true or false` };
      }
      if (p.internalOnly) pattern.internalOnly = true;
      if (p.recurringOnly) pattern.recurringOnly = true;
      if (p.maxPeople !== undefined && p.maxPeople !== null) {
        const n = p.maxPeople;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
          return { ok: false, error: `${where}: maxPeople must be a whole number ≥ 1` };
        }
        pattern.maxPeople = n;
      }
      out.push(pattern);
      continue;
    }
    return { ok: false, error: `${where}: unknown kind "${String(p.kind)}" (title or invite)` };
  }
  return { ok: true, patterns: out };
}

/**
 * Read side: `series.patterns` as stored. Never throws — a row that somehow
 * holds an invalid entry (hand-edited SQL) keeps its valid patterns and the
 * bad one simply matches nothing.
 */
export function parseStoredPatterns(raw: unknown): SeriesPattern[] {
  if (!Array.isArray(raw)) return [];
  const out: SeriesPattern[] = [];
  for (const p of raw.slice(0, MAX_PATTERNS)) {
    const v = validatePatterns([p]);
    if (v.ok) out.push(...v.patterns);
  }
  return out;
}

const compiled = new Map<string, RegExp | null>();

function compile(regex: string): RegExp | null {
  let re = compiled.get(regex);
  if (re === undefined) {
    try {
      re = new RegExp(regex, 'i');
    } catch {
      re = null;
    }
    if (compiled.size > 2000) compiled.clear();
    compiled.set(regex, re);
  }
  return re;
}

function domainOf(email: string): string {
  return email.split('@')[1] ?? '';
}

/** One pattern against one meeting's facts. */
export function patternMatches(
  p: SeriesPattern,
  facts: SeriesFacts,
  internalDomains: ReadonlySet<string> = INTERNAL_DOMAINS
): boolean {
  if (p.kind === 'title') {
    if (!facts.title) return false;
    const re = compile(p.regex);
    return !!re && re.test(facts.title.slice(0, MAX_MATCHED_TITLE));
  }
  const present = new Set(facts.emails);
  if (p.all.length === 0) return false;
  if (!p.all.every((e) => present.has(e))) return false;
  if (p.any && p.any.length > 0 && !p.any.some((e) => present.has(e))) return false;
  if (p.internalOnly && facts.emails.some((e) => !internalDomains.has(domainOf(e)))) return false;
  if (p.recurringOnly && !facts.recurring) return false;
  if (p.maxPeople !== undefined && facts.emails.length > p.maxPeople) return false;
  return true;
}

/** A series matches when ANY of its patterns does; none = nothing. */
export function seriesMatches(
  patterns: readonly SeriesPattern[],
  facts: SeriesFacts,
  internalDomains: ReadonlySet<string> = INTERNAL_DOMAINS
): boolean {
  return patterns.some((p) => patternMatches(p, facts, internalDomains));
}

export interface MatchableSeries {
  id: number;
  priority: number;
  patterns: readonly SeriesPattern[];
}

/** Lowest priority wins, then the lowest id — one total order, so every
 * caller (membership, calendar chips, auto-import) picks the same series. */
export function compareSeriesPrecedence(a: MatchableSeries, b: MatchableSeries): number {
  return a.priority - b.priority || a.id - b.id;
}

/**
 * The series a meeting belongs to by its patterns: the winner among every
 * matching series, skipping the ones it was excluded from ("not this
 * series" — a human answer that beats the patterns). null = none.
 */
export function pickSeries<T extends MatchableSeries>(
  series: readonly T[],
  facts: SeriesFacts,
  excluded?: ReadonlySet<number>
): T | null {
  let best: T | null = null;
  for (const s of series) {
    if (excluded?.has(s.id)) continue;
    if (!seriesMatches(s.patterns, facts)) continue;
    if (!best || compareSeriesPrecedence(s, best) < 0) best = s;
  }
  return best;
}

/** The slice of gmeet_context the matcher reads. */
export interface SeriesContextFields {
  eventTitle?: string | null;
  organizerEmail?: string | null;
  recurringEventId?: string | null;
  attendees?: ReadonlyArray<{ email?: string | null } | null> | null;
}

/** Facts of a stored meeting: event title (else the row's own title), the
 * invite's attendees + organizer, recurring = a recurringEventId exists. */
export function factsFromContext(row: {
  title?: string | null;
  gmeet_context?: SeriesContextFields | null;
}): SeriesFacts {
  const ctx = row.gmeet_context ?? null;
  const eventTitle = typeof ctx?.eventTitle === 'string' ? ctx.eventTitle.trim() : '';
  const own = typeof row.title === 'string' ? row.title.trim() : '';
  const attendees = Array.isArray(ctx?.attendees) ? ctx!.attendees! : [];
  return {
    title: eventTitle || own || null,
    emails: cleanEmails([...attendees.map((a) => a?.email), ctx?.organizerEmail]),
    recurring: typeof ctx?.recurringEventId === 'string' && ctx.recurringEventId.length > 0,
  };
}

/** Facts of a calendar_event_cache row (or anything shaped like one). */
export function factsFromCalendarRow(row: {
  title?: string | null;
  organizer_email?: string | null;
  recurring_event_id?: string | null;
  attendees?: ReadonlyArray<{ email?: string | null } | null> | null;
}): SeriesFacts {
  const attendees = Array.isArray(row.attendees) ? row.attendees : [];
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  return {
    title: title || null,
    emails: cleanEmails([...attendees.map((a) => a?.email), row.organizer_email]),
    recurring: typeof row.recurring_event_id === 'string' && row.recurring_event_id.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Editor shape (series dialog): one title regex per line + one invite rule.
// ---------------------------------------------------------------------------

export interface PatternEditorState {
  /** One title regex per line. */
  titles: string;
  invite: {
    enabled: boolean;
    all: string;
    any: string;
    internalOnly: boolean;
    recurringOnly: boolean;
    maxPeople: string;
  };
  /** Invite rules beyond the first (written through the API) — kept as-is so
   * a dialog save never drops what it cannot show. */
  extraInvites: InvitePattern[];
}

const splitList = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function patternsToEditor(patterns: readonly SeriesPattern[]): PatternEditorState {
  const titles = patterns.filter((p): p is TitlePattern => p.kind === 'title').map((p) => p.regex);
  const invites = patterns.filter((p): p is InvitePattern => p.kind === 'invite');
  const first = invites[0];
  return {
    titles: titles.join('\n'),
    invite: {
      enabled: !!first,
      all: first?.all.join(', ') ?? '',
      any: first?.any?.join(', ') ?? '',
      internalOnly: !!first?.internalOnly,
      recurringOnly: !!first?.recurringOnly,
      maxPeople: first?.maxPeople !== undefined ? String(first.maxPeople) : '',
    },
    extraInvites: invites.slice(1),
  };
}

/** The editor's raw input as patterns — NOT validated; run validatePatterns
 * on the result (the server does, always). */
export function editorToPatterns(state: PatternEditorState): unknown[] {
  const out: unknown[] = state.titles
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((regex) => ({ kind: 'title', regex }));
  if (state.invite.enabled) {
    const max = state.invite.maxPeople.trim();
    out.push({
      kind: 'invite',
      all: splitList(state.invite.all),
      ...(splitList(state.invite.any).length > 0 ? { any: splitList(state.invite.any) } : {}),
      ...(state.invite.internalOnly ? { internalOnly: true } : {}),
      ...(state.invite.recurringOnly ? { recurringOnly: true } : {}),
      ...(max ? { maxPeople: Number(max) } : {}),
    });
  }
  out.push(...state.extraInvites);
  return out;
}

/** One-line human summary of a pattern (index + CLI). */
export function describePattern(p: SeriesPattern): string {
  if (p.kind === 'title') return `title ~ /${p.regex}/i`;
  const bits = [`invite has ${p.all.join(' + ')}`];
  if (p.any?.length) bits.push(`and one of ${p.any.join(' / ')}`);
  if (p.internalOnly) bits.push('internal only');
  if (p.recurringOnly) bits.push('recurring');
  if (p.maxPeople !== undefined) bits.push(`≤ ${p.maxPeople} people`);
  return bits.join(', ');
}
