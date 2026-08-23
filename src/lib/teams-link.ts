import { config } from '@/config';

/**
 * Microsoft Teams join-link parsing + artifact/occurrence matching.
 *
 * Pure helpers (no Graph calls) — kept outside `server/` so the poller, the
 * import routes AND unit tests can share them. The Graph client itself lives
 * in `server/ms-graph.ts`.
 *
 * Background (verified 2026-08-10, docs/teams-integration-spec.md §4):
 * Trames schedules Teams meetings from Google Calendar via the GSuite add-on,
 * so every event's join URL embeds the organizer's AAD object id (`Oid`) and
 * tenant (`Tid`) in the encoded `context` query param — no directory lookup
 * is ever needed. Graph stores the CANONICAL join URL (up to and including
 * the encoded `}` closing the context JSON); the raw calendar link carries
 * extra params (`launchAgent`, `correlationId`) that make `$filter=JoinWebUrl
 * eq …` match nothing unless stripped.
 */

const MEETUP_JOIN_RE = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>\\]+/;

export interface TeamsJoinInfo {
  /** Canonical join URL — what Graph stores and what `$filter` must use. */
  joinWebUrl: string;
  tenantId: string;
  organizerOid: string;
}

/** Find a Teams meetup-join link anywhere in a blob of text (event location,
 * description, conference entry points). Returns the raw match or null. */
export function findTeamsJoinUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  return MEETUP_JOIN_RE.exec(text)?.[0] ?? null;
}

/**
 * Parse (and canonicalize) a Teams meetup-join URL. Returns null when the
 * string isn't one, or when the context param / Tid / Oid can't be extracted.
 */
export function parseTeamsJoinLink(raw: string): TeamsJoinInfo | null {
  const match = MEETUP_JOIN_RE.exec(raw)?.[0];
  if (!match) return null;

  const ctxKey = 'context=';
  const ctxStart = match.indexOf(ctxKey);
  if (ctxStart < 0) return null;
  const encoded = match.slice(ctxStart + ctxKey.length);

  // Walk the percent-encoded JSON counting brace depth so a nested object
  // inside context can't truncate the canonical URL early.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < encoded.length - 2; i++) {
    if (encoded[i] !== '%') continue;
    const hex = encoded.slice(i + 1, i + 3).toLowerCase();
    if (hex === '7b') depth++;
    else if (hex === '7d') {
      depth--;
      if (depth === 0) {
        end = i + 3;
        break;
      }
    }
  }
  if (end < 0) return null;

  const joinWebUrl = match.slice(0, ctxStart + ctxKey.length + end);
  let ctx: { Tid?: string; Oid?: string };
  try {
    ctx = JSON.parse(decodeURIComponent(encoded.slice(0, end)));
  } catch {
    return null;
  }
  if (!ctx.Tid || !ctx.Oid) return null;
  return { joinWebUrl, tenantId: ctx.Tid, organizerOid: ctx.Oid };
}

/**
 * The meeting's Teams chat/thread id — the percent-decoded path segment right
 * after `/l/meetup-join/` (`19:meeting_<base64>@thread.v2`, or
 * `19:…@thread.tacv2` for channel meetings). Works for own-tenant AND
 * external-tenant links: the chat id needs no Graph resolution, it IS the
 * join link's first path segment. Null when the string isn't a meetup-join
 * link or the segment doesn't decode to a `19:…` thread id.
 */
export function threadIdFromJoinUrl(raw: string): string | null {
  const match = MEETUP_JOIN_RE.exec(raw)?.[0];
  if (!match) return null;
  const marker = '/l/meetup-join/';
  const start = match.indexOf(marker) + marker.length;
  const rest = match.slice(start);
  const seg = rest.split(/[/?]/, 1)[0] ?? '';
  if (!seg) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    return null;
  }
  return decoded.startsWith('19:') ? decoded : null;
}

/** True when the meeting was organized inside OUR tenant — the only case
 * where app-only Graph can reach its artifacts (spec §4.5). */
export function isOwnTenant(info: TeamsJoinInfo): boolean {
  const own = config.microsoft.tenantId;
  return Boolean(own) && info.tenantId.toLowerCase() === own.toLowerCase();
}

// ---------------------------------------------------------------------------
// Artifact → occurrence matching.
//
// One recurring series = ONE onlineMeeting object; /transcripts and
// /recordings return artifacts for ALL occurrences. Each artifact carries a
// `callId` (occurrence key — a transcript and recording from the same
// occurrence share it) plus created/end times.

export interface GraphTranscript {
  id: string;
  callId?: string;
  contentCorrelationId?: string;
  createdDateTime?: string;
  endDateTime?: string;
}

export interface GraphRecording {
  id: string;
  callId?: string;
  contentCorrelationId?: string;
  createdDateTime?: string;
  endDateTime?: string;
}

/** Artifact window intersects [eventStart − 15 min, eventEnd + 6 h].
 * `createdDateTime` lags meeting start by minutes (transcription start), and
 * meetings routinely overrun — hence the generous, asymmetric margins. */
const BEFORE_MS = 15 * 60 * 1000;
const AFTER_MS = 6 * 60 * 60 * 1000;

function inWindow(
  artifact: { createdDateTime?: string; endDateTime?: string },
  startMs: number,
  endMs: number
): boolean {
  const aStart = artifact.createdDateTime ? Date.parse(artifact.createdDateTime) : NaN;
  const aEnd = artifact.endDateTime ? Date.parse(artifact.endDateTime) : aStart;
  if (Number.isNaN(aStart)) return false;
  return aStart <= endMs + AFTER_MS && (Number.isNaN(aEnd) ? aStart : aEnd) >= startMs - BEFORE_MS;
}

function closestToStart<T extends { createdDateTime?: string }>(list: T[], startMs: number): T {
  return [...list].sort(
    (a, b) =>
      Math.abs(Date.parse(a.createdDateTime ?? '') - startMs) -
      Math.abs(Date.parse(b.createdDateTime ?? '') - startMs)
  )[0]!;
}

/**
 * Pick the transcript + recording belonging to ONE occurrence of a (possibly
 * recurring) meeting, given the Google Calendar event instance's window.
 * Prefers callId pairing: once a transcript is chosen, its callId selects the
 * recording (and vice versa when only a recording exists).
 */
export function pickOccurrenceArtifacts(
  transcripts: GraphTranscript[],
  recordings: GraphRecording[],
  eventStartIso: string,
  eventEndIso: string
): { transcript?: GraphTranscript; recording?: GraphRecording } {
  const startMs = Date.parse(eventStartIso);
  const endMs = Date.parse(eventEndIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return {};

  const tCandidates = transcripts.filter((t) => inWindow(t, startMs, endMs));
  const rCandidates = recordings.filter((r) => inWindow(r, startMs, endMs));

  const transcript = tCandidates.length > 0 ? closestToStart(tCandidates, startMs) : undefined;

  let recording: GraphRecording | undefined;
  if (transcript?.callId) {
    recording = recordings.find((r) => r.callId === transcript.callId);
  }
  if (!recording && rCandidates.length > 0) {
    recording = closestToStart(rCandidates, startMs);
  }
  return { transcript, recording };
}
