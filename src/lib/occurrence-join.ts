/**
 * "This occurrence already has a meeting — add my recording to it"
 * (owner, 2026-10-02; docs/recordings-meetings-series-design.md, "As built —
 * joining an occurrence's meeting").
 *
 * A MEETING is a timeline that can hold one or more recording segments, from
 * several people, possibly overlapping; the summarising AI sees all of them
 * and combines. So when Ivan links his tray recording to Teams occurrence X
 * and Ka Wen has ALREADY linked hers to X, Ivan's recording is added to Ka
 * Wen's meeting as another clip instead of becoming a second meeting.
 *
 * This module is the pure half — client-safe, no server imports: the wire
 * types, the occurrence matcher, the choice copy the link dialog renders, the
 * marker the joined meeting carries, the alignment arithmetic and the
 * annotation re-keying a re-materialise needs.
 */
import { OCCURRENCE_WINDOW_MS } from '@/lib/meeting-evidence';
import type {
  SpeakerLabel,
  SpeakerSuggestionMap,
  TranscriptEditMap,
  TranscriptResponse,
} from '@/lib/format';

// ---------------------------------------------------------------------------
// The mode
// ---------------------------------------------------------------------------

/**
 * What a link to a calendar occurrence does when the caller can already see a
 * meeting for that occurrence: `join` (the default — the recording becomes
 * another clip of that meeting) or `separate` (today's behaviour — a meeting
 * of its own, shared with the invitees).
 */
export type LinkMode = 'join' | 'separate';

export const DEFAULT_LINK_MODE: LinkMode = 'join';

/** `undefined` = not given (the server default applies), `null` = junk. */
export function parseLinkMode(raw: unknown): LinkMode | null | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw === 'join' || raw === 'separate') return raw;
  return null;
}

// ---------------------------------------------------------------------------
// The occurrence
// ---------------------------------------------------------------------------

/**
 * Everything a link knows about the occurrence it names. `eventId` is exact
 * (a calendar instance id); the provider keys (Meet code / Teams cache code,
 * Teams join URL, iCalUID) are reused across a recurring series and only
 * identify an occurrence together with its start.
 */
export interface OccurrenceKey {
  eventId: string | null;
  iCalUID: string | null;
  meetingCode: string | null;
  joinWebUrl: string | null;
  startTime: string | null;
}

function clean(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The key of a linked-event payload, a calendar-cache event or a meeting's
 * `gmeet_context` — the three shapes the link paths carry. */
export function occurrenceKeyOf(e: {
  id?: unknown;
  eventId?: unknown;
  iCalUID?: unknown;
  meetingCode?: unknown;
  teamsUrl?: unknown;
  joinWebUrl?: unknown;
  teams?: { joinWebUrl?: unknown } | null;
  startTime?: unknown;
} | null | undefined): OccurrenceKey {
  const start = clean(e?.startTime);
  return {
    eventId: clean(e?.eventId) ?? clean(e?.id),
    iCalUID: clean(e?.iCalUID),
    meetingCode: clean(e?.meetingCode),
    joinWebUrl: clean(e?.joinWebUrl) ?? clean(e?.teams?.joinWebUrl) ?? null,
    startTime: start && !Number.isNaN(Date.parse(start)) ? new Date(start).toISOString() : null,
  };
}

/** Is there anything to look an occurrence up by? A provider key without a
 * start names a whole series, which is not an occurrence. */
export function hasOccurrenceKey(k: OccurrenceKey): boolean {
  if (k.eventId) return true;
  return !!k.startTime && !!(k.meetingCode || k.joinWebUrl || k.iCalUID);
}

/** What a stored meeting says about the occurrence it is linked to. */
export interface OccurrenceMeetingFacts {
  event_id: string | null;
  ical_uid: string | null;
  meeting_code: string | null;
  join_web_url: string | null;
  /** COALESCE(startTime, actuals.conferenceStart, recorded_at) — the ONE chain
   * (`IMPORTED_OCCURRENCE_START`). */
  occurrence_start: string | null;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return Math.abs(x - y) <= OCCURRENCE_WINDOW_MS;
}

/**
 * Is this stored meeting the SAME occurrence the link names?
 *
 * The rule `importedOccurrenceMatches` applies ("already imported?"), made
 * stricter in one place on purpose: a provider key WITHOUT a start never
 * matches. "Already imported" may err towards yes (a dupe import costs a
 * click); a join that erred would put somebody's recording into the wrong
 * week's meeting. An exact event id still matches alone — and, when both
 * sides carry a start, only if they agree (a series-master id must not pull
 * in every occurrence).
 */
export function sameOccurrence(c: OccurrenceMeetingFacts, k: OccurrenceKey): boolean {
  if (k.eventId && c.event_id && c.event_id === k.eventId) {
    if (!k.startTime || !c.occurrence_start) return true;
    return sameInstant(c.occurrence_start, k.startTime);
  }
  if (!k.startTime) return false;
  const keyHit =
    (!!k.meetingCode && c.meeting_code === k.meetingCode) ||
    (!!k.joinWebUrl && c.join_web_url === k.joinWebUrl) ||
    (!!k.iCalUID && c.ical_uid === k.iCalUID);
  return keyHit && sameInstant(c.occurrence_start, k.startTime);
}

// ---------------------------------------------------------------------------
// Candidates — what the dialog asks before it links
// ---------------------------------------------------------------------------

export type CandidateAccess = 'owner' | 'edit' | 'read';

/** Why a visible meeting for the occurrence cannot take this recording. */
export type JoinBlockCode =
  | 'disabled'
  | 'no-recording'
  | 'full'
  | 'already-in'
  | 'not-owner-of-recording'
  | 'read-only'
  | 'has-notes'
  | 'not-movable';

const JOIN_BLOCK_TEXT: Record<JoinBlockCode, string> = {
  disabled: 'Adding a recording to a meeting is not available on this server yet.',
  'no-recording': 'That meeting has no recording of its own to add yours to.',
  full: 'That meeting already holds as many recordings as it can.',
  'already-in': 'Your recording is already part of that meeting.',
  'not-owner-of-recording': 'Only the person who recorded this can add it to another meeting.',
  'read-only': 'You can only read that meeting, so your recording cannot be added to it.',
  'has-notes':
    'This meeting already has notes of its own — keep it separate, or delete its notes first.',
  'not-movable': 'Only a meeting made from one of your own recordings can be folded into another.',
};

export function joinBlockedReason(code: JoinBlockCode): string {
  return JOIN_BLOCK_TEXT[code];
}

/** One meeting the CALLER can open that is linked to the same occurrence. */
export interface OccurrenceMeetingCandidate {
  meetingId: string;
  url: string;
  title: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  /** The caller owns that meeting. */
  mine: boolean;
  access: CandidateAccess;
  /** Distinct recordings the meeting already holds. */
  recordingCount: number;
  joinable: boolean;
  blockedCode: JoinBlockCode | null;
  blockedReason: string | null;
}

/** `GET /api/recordings/:id/link-candidates` and its meeting twin. */
export interface LinkCandidatesResponse {
  /** The meeting a default (`join`) link would add to — null = none, and the
   * link makes a meeting of its own exactly as before. */
  candidate: OccurrenceMeetingCandidate | null;
  /** Every visible meeting of the occurrence, joinable or not (the dialog
   * may say "…but it cannot take yours: <reason>"). */
  candidates: OccurrenceMeetingCandidate[];
  defaultMode: LinkMode;
}

/** The first joinable candidate, in the order the server ranked them. */
export function pickJoinCandidate(
  candidates: OccurrenceMeetingCandidate[]
): OccurrenceMeetingCandidate | null {
  return candidates.find((c) => c.joinable) ?? null;
}

/** "Ka Wen Koh" / "you" / "a colleague" — never a bare email when a name is known. */
export function candidateOwnerLabel(c: Pick<OccurrenceMeetingCandidate, 'mine' | 'ownerName' | 'ownerEmail'>): string {
  if (c.mine) return 'you';
  return c.ownerName?.trim() || c.ownerEmail?.trim() || 'a colleague';
}

/** The copy of the link dialog's choice — one definition, rendered by the
 * web dialog and asserted by the tests. */
export function joinChoiceCopy(c: OccurrenceMeetingCandidate): {
  headline: string;
  title: string | null;
  join: string;
  joinHint: string;
  separate: string;
  separateHint: string;
} {
  return {
    headline: `This occurrence already has a meeting by ${candidateOwnerLabel(c)}`,
    title: c.title?.trim() || null,
    join: 'Add my recording to it',
    joinHint:
      'One meeting for the call: your recording becomes another part of it, and its notes can use both.',
    separate: 'Keep mine separate',
    separateHint: 'A meeting of its own, shared with the invite’s Trames colleagues.',
  };
}

// ---------------------------------------------------------------------------
// The marker a joined meeting carries
// ---------------------------------------------------------------------------

/**
 * Where the joined recording's TEXT is:
 *  - `merged`: in the meeting's text.
 *  - `pending`: the recording is still uploading/transcribing; it is in the
 *    meeting as an audio-only clip and its text is merged when it lands.
 *  - `merging`: claimed by the settle that is merging it right now.
 *  - `failed`: its transcription failed; it stays audio-only until a retry.
 *  - `waiting-combine`: `MW_COMBINE` is off on this server — the recording
 *    is reserved for this meeting (no second meeting can be made of it) and
 *    nothing about the meeting changes until the flag is on, when the sweep
 *    adds it.
 */
export type JoinTextState = 'merged' | 'pending' | 'merging' | 'failed' | 'waiting-combine';

/** `aligned` = placed by the cross-correlation; `unaligned` = at 0 (no media
 * to correlate, or no confident match) — the sheet offers "line them up";
 * `aligning` = the correlation is running. */
export type JoinAlignment = 'aligned' | 'unaligned' | 'aligning';

export interface OccurrenceJoinMarker {
  at: string;
  /** The recording's owner — the person who joined it. */
  byUserId: string;
  by: string;
  how: 'link' | 'upload' | 'link-event';
  text: JoinTextState;
  alignment: JoinAlignment;
  confidence?: number | null;
  /** What the correlation measured, even when it was not applied. */
  measuredOffsetMs?: number | null;
}

/** `gmeet_context.occurrenceJoins`, keyed by recording id. */
export function occurrenceJoinsOf(ctx: { occurrenceJoins?: unknown } | null | undefined): Record<
  string,
  OccurrenceJoinMarker
> {
  const raw = ctx?.occurrenceJoins;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, OccurrenceJoinMarker>;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * The joined clip's offset, from the correlation against the meeting's
 * primary recording.
 *
 * `alignOffsetMs` is how far the joined recording starts AFTER the primary
 * (`AlignOk.offsetMs`); the primary's recording-time zero sits at meeting
 * time `primary.offsetMs - primary.fromMs`. A result before the meeting's
 * zero cannot be a clip offset (they are ≥ 0) and is not applied — the
 * meeting would have to move, which is the person's call in the sheet.
 */
export function joinedOffsetFromAlign(
  primary: { offsetMs: number; fromMs: number },
  alignOffsetMs: number
): number | null {
  if (!Number.isFinite(alignOffsetMs)) return null;
  const at = Math.round(primary.offsetMs - primary.fromMs + alignOffsetMs);
  return at >= 0 ? at : null;
}

// ---------------------------------------------------------------------------
// Annotations across a re-materialise
// ---------------------------------------------------------------------------

type Utterance = NonNullable<TranscriptResponse['utterances']>[number];

const LABEL_NS_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:(.+)$/;
const bare = (s: string | undefined) => {
  if (!s) return '';
  const m = LABEL_NS_RE.exec(s);
  return m ? m[1]! : s;
};

export interface AnnotationRekey {
  /** Old utterance index (the row's position key) → new one. */
  index: Map<string, string>;
  /** Old speaker label → new one, only where it changed (`A` → `<rid>:A`). */
  labels: Map<string, string>;
}

/**
 * How a meeting's annotations move when its text is re-materialised with
 * another recording in it.
 *
 * Edits are keyed by an utterance's POSITION in the row's list and speaker
 * names by its LABEL. Adding a second recording interleaves new utterances
 * (positions move) and starts the `<recordingId>:<label>` namespace (labels
 * change), while the meeting-time start, end and text of every utterance
 * already there stay exactly what they were. So an old utterance is found in
 * the new list by (start, end, text, bare speaker), and its label change is
 * read off the pair — no knowledge of the resolver needed, and nothing is
 * guessed: an utterance without an exact partner keeps no mapping.
 */
export function annotationRekey(before: Utterance[], after: Utterance[]): AnnotationRekey {
  const slots = new Map<string, number[]>();
  after.forEach((u, j) => {
    const key = `${u.start}|${u.end}|${bare(u.speaker)}|${u.text}`;
    const list = slots.get(key);
    if (list) list.push(j);
    else slots.set(key, [j]);
  });
  const index = new Map<string, string>();
  const labels = new Map<string, string>();
  before.forEach((u, i) => {
    const key = `${u.start}|${u.end}|${bare(u.speaker)}|${u.text}`;
    const j = slots.get(key)?.shift();
    if (j === undefined) return;
    index.set(String(i), String(j));
    const next = after[j]!.speaker;
    if (u.speaker && next && next !== u.speaker && !labels.has(u.speaker)) labels.set(u.speaker, next);
  });
  return { index, labels };
}

/** True when the re-key would change nothing. */
export function isIdentityRekey(r: AnnotationRekey): boolean {
  if (r.labels.size > 0) return false;
  for (const [a, b] of r.index) if (a !== b) return false;
  return true;
}

/** One user's edit map, re-keyed. An edit whose utterance has no partner is
 * dropped rather than left on somebody else's sentence. */
export function rekeyEdits(edits: TranscriptEditMap | null | undefined, r: AnnotationRekey): TranscriptEditMap {
  const out: TranscriptEditMap = {};
  for (const [key, edit] of Object.entries(edits ?? {})) {
    // A namespaced key (`<recordingId>:<n>`) names the utterance by its own
    // recording, not by its position, so it survives as it is.
    const next = /^\d+$/.test(key) ? r.index.get(key) : key;
    if (next === undefined) continue;
    out[next] =
      edit.speaker && r.labels.has(edit.speaker) ? { ...edit, speaker: r.labels.get(edit.speaker)! } : edit;
  }
  return out;
}

export function rekeySpeakerLabels(labels: SpeakerLabel[] | null | undefined, r: AnnotationRekey): SpeakerLabel[] {
  return (labels ?? []).map((l) =>
    r.labels.has(l.originalSpeaker) ? { ...l, originalSpeaker: r.labels.get(l.originalSpeaker)! } : l
  );
}

export function rekeySuggestions(
  s: SpeakerSuggestionMap | null | undefined,
  r: AnnotationRekey
): SpeakerSuggestionMap | null {
  if (!s) return null;
  const out: SpeakerSuggestionMap = {};
  for (const [label, v] of Object.entries(s)) out[r.labels.get(label) ?? label] = v;
  return out;
}
