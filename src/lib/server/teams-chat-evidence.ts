import 'server-only';
import {
  getMeetingCacheByMeetings,
  upsertMeetingCache,
  type GmeetMeetingCacheRow,
} from '@/db-ops/gmeet-meeting-cache';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import { fetchTeamsChatCallEvents, isDarthTasksConfigured } from '@/lib/server/darth-tasks-client';
import { threadIdFromJoinUrl, type TeamsJoinInfo } from '@/lib/teams-link';
import {
  CHAT_MIN_AGE_MS,
  chatCallEndMs,
  chatEvidenceWindow,
  classifyChatCallEvents,
  needsChatLookup,
  type TeamsChatEvidence,
} from '@/lib/teams-chat-evidence';

/**
 * Teams chat evidence — SERVER half: one lookup via Darth Tasks (the
 * caller's delegated Microsoft link) → classify → persist on the
 * occurrence's gmeet_meeting_cache row as `raw.teamsChat`.
 *
 * Works for own-tenant AND external-tenant occurrences: the chat id is the
 * thread id embedded in the join link itself — no Graph resolution, no
 * tenant gate. External occurrences get their cache row CREATED here
 * (states null, `raw.external = true` + `raw.tenantId`) — until now they had
 * none, because the artifact probe can't touch them.
 *
 * The pure half (window calc, classification, staleness) lives in
 * lib/teams-chat-evidence.ts.
 */

export interface ChatLookupInput {
  info: TeamsJoinInfo;
  /** Own tenant (artifact probes apply) or external (chat is all we get). */
  external: boolean;
  /** Occurrence calendar window (ISO). */
  eventStart: string;
  eventEnd?: string | null;
  /** Whose Microsoft link to read the chat with (the caller / the swept
   * user's SSO email) — plagueis enforces the link. */
  email: string;
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
  /** False when the verdict only describes the CALLER (not_linked/revoked) —
   * those are never written to the shared cache row. */
  persisted: boolean;
}

/**
 * Ask Darth Tasks for the chat's call events over [start−20m, end+3h],
 * classify, persist. Failed lookups persist too (`held: null` + `reason`) so
 * the sweep's retry predicate can back off — EXCEPT not_linked/revoked,
 * which describe the asking user rather than the meeting and are returned
 * without touching the shared row. Null = nothing asked (feature off,
 * un-parseable thread id, bad start, plagueis unreachable).
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

  const resp = await fetchTeamsChatCallEvents(
    input.email,
    chatId,
    window.fromIso,
    window.toIso
  );
  if (!resp) return null;

  const verdict = classifyChatCallEvents(resp, {
    checkedAt: new Date().toISOString(),
    byEmail: input.email,
  });
  if (verdict.reason === 'not_linked' || verdict.reason === 'revoked') {
    return { verdict, persisted: false };
  }
  if (!existing && input.allowCreate === false) {
    // No row for this occurrence and the caller isn't trusted to mint one
    // (client-supplied URL that matches nothing in their calendar) — hand
    // the verdict back without touching the shared cache.
    return { verdict, persisted: false };
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
  return { verdict, persisted: true };
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
  if (cached && !needsChatLookup(cached, endMs, Date.now())) return cached;
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
