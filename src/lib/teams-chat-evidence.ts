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
 */
export function classifyChatCallEvents(
  resp: ChatCallEventsResponse,
  meta: { checkedAt: string; byEmail: string | null }
): TeamsChatEvidence {
  const base: TeamsChatEvidence = {
    checkedAt: meta.checkedAt,
    byEmail: meta.byEmail,
    held: null,
    callStart: null,
    callEnd: null,
    durationMs: null,
    recorded: false,
    transcribed: false,
    humanMessages: null,
  };
  if (!resp.ok) {
    return { ...base, reason: resp.reason || 'graph_error' };
  }
  const s = resp.summary;
  if (!s || typeof s.held !== 'boolean') {
    return { ...base, reason: 'graph_error' };
  }
  return {
    ...base,
    held: s.held,
    callStart: s.callStart ?? null,
    callEnd: s.callEnd ?? null,
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : null,
    recorded: s.recorded === true,
    transcribed: s.transcribed === true,
    humanMessages: typeof s.humanMessages === 'number' ? s.humanMessages : null,
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
 * (max of the calendar end and the verdict's own callEnd).
 */
export function needsChatLookup(
  existing: TeamsChatEvidence | null | undefined,
  callEndMs: number,
  nowMs: number
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
