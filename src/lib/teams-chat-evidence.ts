// Teams chat evidence — PURE half (window calc, classification, staleness).
//
// Every Teams meeting has a chat thread whose system events (callStarted /
// callEnded / callRecording / …) say whether an occurrence was actually HELD,
// for how long, and whether anyone recorded it — even for meetings organized
// by EXTERNAL tenants, where the app-only artifact probe is blind. Darth
// Tasks (plagueis) reads those events with the caller's delegated Microsoft
// link and serves them via /api/ms/internal/chat-call-events; this module
// turns that response into the verdict we persist on the occurrence's
// gmeet_meeting_cache row as `raw.teamsChat`.
//
// Isomorphic on purpose (no fetch, no DB, no server-only): the poller, the
// evidence route, the client copy helpers and bun tests all import from
// here. The fetch lives in lib/server/darth-tasks-client.ts, the persistence
// in lib/server/teams-chat-evidence.ts.

/** The persisted verdict — `gmeet_meeting_cache.raw.teamsChat`, and (flat,
 * `chat*`-prefixed) the norec listing rows. A failed lookup persists too —
 * `held`/`recorded` null with `reason` set — so the UI can say "Teams chat
 * not visible to you" instead of silently re-asking forever. */
export interface TeamsChatEvidence {
  /** When WE asked plagueis (not when the call happened). */
  checkedAt: string;
  /** Whose Microsoft link answered (the SSO email we asked for). */
  byEmail: string | null;
  /** Was the call actually held? null = unknown (lookup failed, see reason). */
  held: boolean | null;
  callStart: string | null;
  callEnd: string | null;
  durationMs: number | null;
  recorded: boolean;
  transcribed: boolean;
  humanMessages: number | null;
  /** Set when no verdict could be formed:
   * not_linked | revoked | forbidden | not_found | throttled | graph_error. */
  reason?: string;
  /** How many linked readers' chat copies answered ok and were UNIONED into
   * this verdict (D3, 2026-09-18). Absent on verdicts taken before the
   * union existed — those came from ONE reader, and for an external-tenant
   * meeting one reader's empty copy proves nothing (see needsChatLookup). */
  readerCount?: number;
}

/** Wire shape of plagueis GET /api/ms/internal/chat-call-events (contract). */
export interface ChatCallEventsResponse {
  ok: boolean;
  email?: string;
  chat?: string;
  from?: string;
  to?: string;
  pages?: number;
  events?: Array<{ at: string; type: string }>;
  summary?: {
    held: boolean;
    callStart: string | null;
    callEnd: string | null;
    durationMs: number | null;
    recorded: boolean;
    transcribed: boolean;
    humanMessages: number;
  };
  reason?: string;
  status?: number;
  retryAfterS?: number;
}

/** Chat events lag/lead the calendar slot: people join early, recap events
 * (callRecording etc.) can land well after the call — ask for
 * [start − 20 min, end + 3 h]. `endIso` falls back to start + 1 h. */
export const CHAT_WINDOW_BEFORE_MS = 20 * 60_000;
export const CHAT_WINDOW_AFTER_MS = 3 * 3600_000;

export function chatEvidenceWindow(
  startIso: string,
  endIso?: string | null
): { fromIso: string; toIso: string } | null {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  let end = endIso ? Date.parse(endIso) : NaN;
  if (Number.isNaN(end) || end < start) end = start + 3600_000;
  return {
    fromIso: new Date(start - CHAT_WINDOW_BEFORE_MS).toISOString(),
    toIso: new Date(end + CHAT_WINDOW_AFTER_MS).toISOString(),
  };
}

/**
 * Plagueis response → the verdict we persist. Defensive: a malformed 200
 * (ok:true without a summary) classifies as a `graph_error`-style unknown
 * rather than "not held" — never turn transport noise into a confident
 * "nobody joined".
 *
 * One-reader form of classifyChatCallEventsUnion (below) — kept for the
 * tests and any caller holding a single response.
 */
export function classifyChatCallEvents(
  resp: ChatCallEventsResponse,
  meta: { checkedAt: string; byEmail: string | null }
): TeamsChatEvidence {
  return classifyChatCallEventsUnion([{ email: meta.byEmail ?? '', resp }], meta);
}

/** Chat system events that prove a call took place. callRecording /
 * callTranscript count too: long workshops whose callStarted fell outside
 * the window still carry the recap events (2026-09-02 APP inventory). */
export const CALL_EVENT_TYPES = new Set(['callStarted', 'callEnded', 'callRecording', 'callTranscript']);

export type ChatCallEvent = { at: string; type: string };

/** One reader's answer for the union: their SSO email and the plagueis body
 * (null = transport failure / feature off — nothing came back). */
export interface ChatReaderResponse {
  email: string;
  resp: ChatCallEventsResponse | null;
}

/**
 * Held / duration / recorded from the raw `events[]` — NOT from plagueis'
 * `summary`: its durationMs is the LAST callStarted→callEnded pair (a
 * 5-second reconnect at the end reads as 0 min) and its `held` misses
 * calls whose callStarted fell outside the window. Duration = the SUM of
 * every started→ended pair in order; a lone callEnded (start outside the
 * window) contributes nothing, so a verdict with call events but no
 * complete pair has held=true and durationMs=null (unknown), never 0.
 */
export function summarizeCallEvents(events: readonly ChatCallEvent[]): {
  held: boolean;
  callStart: string | null;
  callEnd: string | null;
  durationMs: number | null;
  recorded: boolean;
  transcribed: boolean;
} {
  const calls = events
    .filter((e) => CALL_EVENT_TYPES.has(e.type) && !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (calls.length === 0) {
    return { held: false, callStart: null, callEnd: null, durationMs: null, recorded: false, transcribed: false };
  }
  let total = 0;
  let pairs = 0;
  let open: number | null = null;
  for (const e of calls) {
    const t = Date.parse(e.at);
    if (e.type === 'callStarted') {
      if (open === null) open = t;
    } else if (e.type === 'callEnded' && open !== null) {
      if (t > open) {
        total += t - open;
        pairs++;
      }
      open = null;
    }
  }
  const starts = calls.filter((e) => e.type === 'callStarted');
  const ends = calls.filter((e) => e.type === 'callEnded');
  return {
    held: true,
    callStart: (starts[0] ?? calls[0])!.at,
    callEnd: (ends.length ? ends[ends.length - 1] : calls[calls.length - 1])!.at,
    durationMs: pairs > 0 ? total : null,
    recorded: calls.some((e) => e.type === 'callRecording'),
    transcribed: calls.some((e) => e.type === 'callTranscript'),
  };
}

/** Which failure to persist when NO reader could read the chat: a transient
 * reason (retry soon) beats a settled one; link problems describe the
 * readers, not the meeting, and only win when nothing else was seen. */
const FAILURE_RANK: Record<string, number> = {
  throttled: 0,
  graph_error: 1,
  forbidden: 2,
  not_found: 3,
  revoked: 4,
  not_linked: 5,
};

/**
 * THE verdict: the UNION of every linked reader's copy of the meeting chat.
 * An external participant's copy of a host-tenant chat holds ONLY the
 * occurrences they personally joined (proven 2026-09-02: alok saw 10
 * Hypercare days that aniq/atira/kawen could not), so "ok but no events"
 * from one reader is not evidence of not-held — every ok copy's events are
 * merged (deduped by at|type) before summarizeCallEvents runs.
 *
 *  - ≥1 ok response carrying `events[]` → events-based verdict.
 *  - ok responses WITHOUT `events[]` (older plagueis) → the summaries,
 *    OR-ed: held/recorded/transcribed if any says so; durationMs from the
 *    first held summary (the only figure available then).
 *  - no ok response → the highest-ranked failure reason, held unknown.
 *
 * `byEmail` names the readers whose copies contributed call events ('+'
 * joined), else every reader that answered ok; `readerCount` = ok copies.
 */
export function classifyChatCallEventsUnion(
  readers: readonly ChatReaderResponse[],
  meta: { checkedAt: string; byEmail?: string | null }
): TeamsChatEvidence {
  const base: TeamsChatEvidence = {
    checkedAt: meta.checkedAt,
    byEmail: meta.byEmail ?? null,
    held: null,
    callStart: null,
    callEnd: null,
    durationMs: null,
    recorded: false,
    transcribed: false,
    humanMessages: null,
  };
  const ok: Array<{ email: string; resp: ChatCallEventsResponse }> = [];
  const failures: string[] = [];
  for (const r of readers) {
    if (!r.resp) continue;
    if (!r.resp.ok) {
      failures.push(r.resp.reason || 'graph_error');
      continue;
    }
    const s = r.resp.summary;
    const hasEvents = Array.isArray(r.resp.events);
    if (!hasEvents && (!s || typeof s.held !== 'boolean')) {
      // Malformed 200 — neither events nor a usable summary.
      failures.push('graph_error');
      continue;
    }
    ok.push({ email: r.email, resp: r.resp });
  }
  if (ok.length === 0) {
    const reason = failures.sort((a, b) => (FAILURE_RANK[a] ?? 1) - (FAILURE_RANK[b] ?? 1))[0];
    return { ...base, reason: reason ?? 'graph_error' };
  }

  const humanMessages = ok
    .map((o) => o.resp.summary?.humanMessages)
    .filter((n): n is number => typeof n === 'number');
  const okEmails = ok.map((o) => o.email).filter(Boolean);
  const withEvents = ok.filter((o) => Array.isArray(o.resp.events));

  if (withEvents.length > 0) {
    const seen = new Set<string>();
    const merged: ChatCallEvent[] = [];
    const contributors: string[] = [];
    for (const o of withEvents) {
      let contributed = false;
      for (const e of o.resp.events ?? []) {
        if (!e || typeof e.at !== 'string' || typeof e.type !== 'string') continue;
        if (CALL_EVENT_TYPES.has(e.type)) contributed = true;
        const k = `${e.at}|${e.type}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(e);
      }
      if (contributed && o.email) contributors.push(o.email);
    }
    const s = summarizeCallEvents(merged);
    return {
      ...base,
      byEmail: (contributors.length ? contributors : okEmails).join('+') || base.byEmail,
      held: s.held,
      callStart: s.callStart,
      callEnd: s.callEnd,
      durationMs: s.durationMs,
      recorded: s.recorded,
      transcribed: s.transcribed,
      humanMessages: humanMessages.length ? Math.max(...humanMessages) : null,
      readerCount: ok.length,
    };
  }

  // Legacy shape: summaries only.
  const summaries = ok.map((o) => o.resp.summary!);
  const heldOne = summaries.find((s) => s.held);
  const contributors = ok.filter((o) => o.resp.summary?.held).map((o) => o.email).filter(Boolean);
  return {
    ...base,
    byEmail: (contributors.length ? contributors : okEmails).join('+') || base.byEmail,
    held: !!heldOne,
    callStart: heldOne?.callStart ?? null,
    callEnd: heldOne?.callEnd ?? null,
    durationMs: typeof heldOne?.durationMs === 'number' ? heldOne.durationMs : null,
    recorded: summaries.some((s) => s.recorded === true),
    transcribed: summaries.some((s) => s.transcribed === true),
    humanMessages: humanMessages.length ? Math.max(...humanMessages) : null,
    readerCount: ok.length,
  };
}

/** Accept whatever jsonb held and keep only a usable TeamsChatEvidence. */
export function asTeamsChatEvidence(v: unknown): TeamsChatEvidence | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<TeamsChatEvidence>;
  if (typeof o.checkedAt !== 'string') return null;
  return {
    checkedAt: o.checkedAt,
    byEmail: typeof o.byEmail === 'string' ? o.byEmail : null,
    held: typeof o.held === 'boolean' ? o.held : null,
    callStart: typeof o.callStart === 'string' ? o.callStart : null,
    callEnd: typeof o.callEnd === 'string' ? o.callEnd : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    recorded: o.recorded === true,
    transcribed: o.transcribed === true,
    humanMessages: typeof o.humanMessages === 'number' ? o.humanMessages : null,
    ...(typeof o.reason === 'string' && o.reason ? { reason: o.reason } : {}),
    ...(typeof o.readerCount === 'number' ? { readerCount: o.readerCount } : {}),
  };
}

/** Chat events for a call can trail it (recap lag) — never take a verdict
 * for a meeting that ended less than this long ago (a lookup mid-meeting
 * would confidently persist "not held" for a call that's still going). The
 * sweep AND the on-demand routes both honour this. */
export const CHAT_MIN_AGE_MS = 30 * 60_000;

/** Recap events (callRecording, sometimes callEnded itself) lag the call end
 * — a verdict taken sooner than this after the call may have missed them. */
export const RECAP_SETTLE_MS = 90 * 60_000;
/** Failed lookups worth retrying eventually (visibility can change). */
export const FAILED_RETRY_MS = 7 * 86_400_000;
/** not_linked / revoked: the sweep only runs when link-status says linked,
 * so a stored not-linked verdict is stale almost immediately. */
export const LINK_RETRY_MS = 3600_000;

/**
 * THE staleness/retry predicate: should a sweep spend one of its capped
 * lookups on this occurrence? `callEndMs` = the best known end of the call
 * (max of the calendar end and the verdict's own callEnd). `opts.external`
 * = organised outside our tenant: a pre-union "not held" there came from
 * ONE reader's partial copy and is re-asked once (the union stamps
 * readerCount, so this fires at most once per occurrence).
 */
export function needsChatLookup(
  existing: TeamsChatEvidence | null | undefined,
  callEndMs: number,
  nowMs: number,
  opts?: { external?: boolean | null }
): boolean {
  if (!existing) return true;
  const checked = Date.parse(existing.checkedAt);
  if (Number.isNaN(checked)) return true;
  if (existing.reason) {
    const wait =
      existing.reason === 'not_linked' || existing.reason === 'revoked'
        ? LINK_RETRY_MS
        : FAILED_RETRY_MS;
    return nowMs - checked >= wait;
  }
  if (opts?.external === true && existing.held === false && existing.readerCount === undefined) {
    return true;
  }
  // Solid verdict — only re-ask when it was taken before the recap events
  // could have landed (and enough time has passed for them to land now).
  const settled = callEndMs + RECAP_SETTLE_MS;
  return checked < settled && nowMs >= settled;
}

/** Best known end of the call for the staleness check. */
export function chatCallEndMs(
  eventEndIso: string | null | undefined,
  existing: TeamsChatEvidence | null | undefined
): number {
  const a = eventEndIso ? Date.parse(eventEndIso) : NaN;
  const b = existing?.callEnd ? Date.parse(existing.callEnd) : NaN;
  const vals = [a, b].filter((v) => !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : 0;
}
