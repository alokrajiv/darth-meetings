import 'server-only';
import {
  getMeetingCacheByMeetings,
  upsertMeetingCache,
  type GmeetMeetingCacheRow,
} from '@/db-ops/gmeet-meeting-cache';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import {
  fetchMsLinkStatus,
  fetchTeamsChatCallEvents,
  isDarthTasksConfigured,
} from '@/lib/server/darth-tasks-client';
import { AUTO_SHARE_DOMAINS } from '@/lib/server/auto-share';
import { mergedCalendarOccurrence } from '@/db-ops/calendar-event-cache';
import { threadIdFromJoinUrl, type TeamsJoinInfo } from '@/lib/teams-link';
import {
  CHAT_MIN_AGE_MS,
  chatCallEndMs,
  chatEvidenceWindow,
  classifyChatCallEventsUnion,
  needsChatLookup,
  type ChatReaderResponse,
  type TeamsChatEvidence,
} from '@/lib/teams-chat-evidence';

/**
 * Teams chat evidence — SERVER half: lookups via Darth Tasks (delegated
 * Microsoft links) → classify → persist on the occurrence's
 * gmeet_meeting_cache row as `raw.teamsChat`.
 *
 * Works for own-tenant AND external-tenant occurrences: the chat id is the
 * thread id embedded in the join link itself — no Graph resolution, no
 * tenant gate. External occurrences get their cache row CREATED here
 * (states null, `raw.external = true` + `raw.tenantId`) — until now they had
 * none, because the artifact probe can't touch them.
 *
 * UNION ACROSS LINKED READERS (D3, 2026-09-18): an external participant's
 * copy of a host-tenant meeting chat holds ONLY the occurrences they
 * personally joined, so one reader's "ok, no events" proves nothing. The
 * verdict is computed from EVERY linked attendee's copy (organiser + invite
 * list, internal domains, capped) and merged. Privacy: this is compute
 * only — the persisted/served verdict is meta (held / recorded / duration /
 * reader count), never another reader's chat content, and every surface
 * that serves it is already gated by callerInvolvedCodes /
 * unimportedVisibleTo (the caller is on the same invite as the readers).
 *
 * The pure half (window calc, classification, staleness) lives in
 * lib/teams-chat-evidence.ts.
 */

/** Most linked copies read per occurrence (each is one plagueis call). */
export const MAX_CHAT_READERS = 6;
/** Most emails per link-status call (~100 → 414 at plagueis). */
const LINK_STATUS_BATCH = 40;

/** Per-sweep memo of "is this SSO email Microsoft-linked at Darth Tasks" —
 * pass the same Map through a whole sweep so N occurrences with the same
 * attendees cost one link-status call. */
export type LinkStatusCache = Map<string, boolean>;

export interface ChatLookupInput {
  info: TeamsJoinInfo;
  /** Own tenant (artifact probes apply) or external (chat is all we get). */
  external: boolean;
  /** Occurrence calendar window (ISO). */
  eventStart: string;
  eventEnd?: string | null;
  /** The asking user's SSO email (the caller / the swept user) — always the
   * first reader tried; plagueis enforces the link. */
  email: string;
  /** Invite emails (any case) known to the caller — unioned with the
   * organiser and with every user's cached copy of the occurrence
   * (mergedCalendarOccurrence) to find the other linked readers. */
  attendees?: readonly string[] | null;
  /** Link-status memo shared across a sweep (see LinkStatusCache). */
  linkCache?: LinkStatusCache;
  /** Display metadata for a row created here. */
  event?: {
    recurringEventId?: string | null;
    iCalUID?: string | null;
    organizerEmail?: string | null;
  } | null;
  capturedBy?: string | null;
  /** Pre-fetched cache row (the sweep batches these); looked up when
   * undefined so the verdict lands on the existing ±12h row, not a
   * tz-duplicate key. */
  existing?: GmeetMeetingCacheRow | null;
  /** May this lookup CREATE a cache row when none exists (default true)?
   * The sweep's candidates come from the user's own calendar, so creation
   * is always fine there — but /api/teams/evidence takes a raw join URL
   * from the browser, and rows keyed on unverified client input would let
   * any caller mint unbounded junk rows: the route passes false unless the
   * occurrence exists in the caller's calendar cache. Updating an existing
   * row is always allowed. */
  allowCreate?: boolean;
}

export interface ChatLookupResult {
  verdict: TeamsChatEvidence;
  /** False when the verdict only describes the READERS (not_linked/revoked)
   * — those are never written to the shared cache row. */
  persisted: boolean;
  /** Plagueis chat-call-events calls spent (one per reader asked) — the
   * sweep charges its budget by this, not per occurrence. */
  lookups: number;
}

function internalEmail(e: string | null | undefined): string | null {
  const v = (e ?? '').trim().toLowerCase();
  if (!v) return null;
  const domain = v.split('@')[1] ?? '';
  return AUTO_SHARE_DOMAINS.has(domain) ? v : null;
}

/**
 * The linked readers for an occurrence, in the order to ask: the caller,
 * the organiser, then the invite (caller-supplied attendees ∪ every user's
 * cached copy). Internal SSO domains only (a link is an SSO-account
 * property); unknown link states resolved in one batched call and memoised
 * in `cache`. When plagueis can't answer link-status at all, only the caller
 * remains (the pre-union behaviour) — never a guess.
 */
export async function resolveChatReaders(
  input: Pick<ChatLookupInput, 'email' | 'attendees' | 'event' | 'linkCache' | 'info' | 'eventStart'>,
  opts: { max?: number } = {}
): Promise<string[]> {
  const cache = input.linkCache ?? new Map<string, boolean>();
  const max = opts.max ?? MAX_CHAT_READERS;
  const caller = input.email.trim().toLowerCase();
  const ordered: string[] = [caller];
  const push = (e: string | null | undefined) => {
    const v = internalEmail(e);
    if (v && !ordered.includes(v)) ordered.push(v);
  };
  push(input.event?.organizerEmail);
  for (const a of input.attendees ?? []) push(a);
  // Other users' calendar copies can list invitees the caller's copy lacks
  // (forwarded invites). Compute-only read of the global cache — gated at
  // the surfaces, not here (see module doc).
  const merged = await mergedCalendarOccurrence(
    teamsCacheCode(input.info.joinWebUrl),
    input.eventStart
  ).catch(() => null);
  if (merged) {
    push(merged.organizerEmail);
    for (const a of merged.attendees) push(a);
  }

  const unknown = ordered.filter((e) => !cache.has(e)).slice(0, LINK_STATUS_BATCH);
  if (unknown.length > 0) {
    const map = await fetchMsLinkStatus(unknown);
    if (map) {
      const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
      for (const e of unknown) {
        const s = lower.get(e);
        cache.set(e, !!s && s.linked && (s.status === null || s.status === 'active'));
      }
    } else if (!cache.has(caller)) {
      // Link-status unreachable: fall back to the caller alone, unmemoised.
      return [caller];
    }
  }
  return ordered.filter((e) => cache.get(e) === true).slice(0, max);
}

/**
 * Ask Darth Tasks for the chat's call events over [start−20m, end+3h]
 * through every linked reader (union), classify, persist. Failed lookups
 * persist too (`held: null` + `reason`) so the sweep's retry predicate can
 * back off — EXCEPT not_linked/revoked, which describe the readers rather
 * than the meeting and are returned without touching the shared row. Null
 * = nothing asked (feature off, un-parseable thread id, bad start,
 * plagueis unreachable for every reader).
 *
 * Own-tenant occurrences stop at the first reader that answers ok: the
 * host tenant's copy is complete, so one ok copy IS the union. External
 * ones read every linked copy (capped at MAX_CHAT_READERS).
 */
export async function lookupAndPersistTeamsChat(
  input: ChatLookupInput
): Promise<ChatLookupResult | null> {
  if (!isDarthTasksConfigured()) return null;
  const chatId = threadIdFromJoinUrl(input.info.joinWebUrl);
  if (!chatId) return null;
  const window = chatEvidenceWindow(input.eventStart, input.eventEnd);
  if (!window) return null;

  const code = teamsCacheCode(input.info.joinWebUrl);
  let existing = input.existing;
  if (existing === undefined) {
    const [row] = await getMeetingCacheByMeetings(
      [{ code, startTime: input.eventStart }],
      { preferChat: true }
    ).catch(() => [null]);
    existing = row;
  }

  let readers = await resolveChatReaders(input);
  // No linked reader at all (or link-status said the caller isn't linked):
  // still ask as the caller so plagueis' own not_linked/revoked answer is
  // what comes back — the pre-union contract the sweep and route rely on.
  if (readers.length === 0) readers = [input.email.trim().toLowerCase()];

  const answers: ChatReaderResponse[] = [];
  let lookups = 0;
  for (const email of readers) {
    const resp = await fetchTeamsChatCallEvents(email, chatId, window.fromIso, window.toIso);
    lookups++;
    answers.push({ email, resp });
    if (!input.external && resp?.ok) break; // host copy is complete
  }
  if (answers.every((a) => a.resp === null)) return null;

  const verdict = classifyChatCallEventsUnion(answers, {
    checkedAt: new Date().toISOString(),
    byEmail: input.email,
  });
  if (verdict.reason === 'not_linked' || verdict.reason === 'revoked') {
    return { verdict, persisted: false, lookups };
  }
  if (!existing && input.allowCreate === false) {
    // No row for this occurrence and the caller isn't trusted to mint one
    // (client-supplied URL that matches nothing in their calendar) — hand
    // the verdict back without touching the shared cache.
    return { verdict, persisted: false, lookups };
  }

  // Land on the existing ±12h row when there is one (avoids a second
  // tz-duplicate key for the same occurrence); else create `code|start`.
  const eventKey = existing?.event_key ?? `${code}|${input.eventStart}`;
  await upsertMeetingCache({
    eventKey,
    meetingCode: code,
    eventStart: existing?.event_start ?? input.eventStart,
    conferenceRecord: null,
    recurringEventId: input.event?.recurringEventId ?? null,
    iCalUID: input.event?.iCalUID ?? null,
    organizerEmail: input.event?.organizerEmail ?? null,
    raw: {
      teamsChat: verdict,
      ...(input.external ? { external: true, tenantId: input.info.tenantId } : {}),
    },
    capturedBy: input.capturedBy ?? null,
  });
  return { verdict, persisted: true, lookups };
}

/**
 * Cache-first verdict for the on-demand routes (/api/teams/evidence): the
 * existing row's raw.teamsChat when it's still fresh (needsChatLookup says
 * no), else ONE live lookup persisted through lookupAndPersistTeamsChat.
 * Null = never checked and couldn't check now.
 */
export async function chatVerdictFor(input: ChatLookupInput): Promise<TeamsChatEvidence | null> {
  let existing = input.existing;
  if (existing === undefined) {
    const code = teamsCacheCode(input.info.joinWebUrl);
    const [row] = await getMeetingCacheByMeetings(
      [{ code, startTime: input.eventStart }],
      { preferChat: true }
    ).catch(() => [null]);
    existing = row;
  }
  const cached = existing?.teams_chat ?? null;
  const endMs = chatCallEndMs(input.eventEnd ?? input.eventStart, cached);
  if (cached && !needsChatLookup(cached, endMs, Date.now(), { external: input.external })) {
    return cached;
  }
  // Same settle gate as the sweep: chat events for a call trail it, and a
  // lookup DURING the meeting would persist a confident "not held" for a
  // call that's still going (the retry predicate then keeps it on screen
  // for hours). Until the slot is 30 min past its end, serve the cache.
  const slotEnd = (() => {
    const e = input.eventEnd ? Date.parse(input.eventEnd) : NaN;
    if (!Number.isNaN(e)) return e;
    const s = Date.parse(input.eventStart);
    return Number.isNaN(s) ? NaN : s + 3600_000;
  })();
  if (!Number.isNaN(slotEnd) && Date.now() < slotEnd + CHAT_MIN_AGE_MS) return cached;
  const live = await lookupAndPersistTeamsChat({ ...input, existing });
  return live?.verdict ?? cached;
}
