/**
 * Several recordings, one meeting — the DISPLAY half (Phase 3b,
 * docs/recordings-phase3b-combine-spec.md §UI).
 *
 * Everything the recording card's summary line, the "Recordings" sheet, the
 * align step's two-lane timeline, the player's part chips, the transcript's
 * source tags and the listing strip need to turn `ClipEntry` / `ClipCandidate`
 * (the wire contract in `lib/clips.ts`) into words and geometry. Pure: no
 * React, no DOM, no `Date.now()`, no timezone — so every sentence on screen is
 * a unit test, exactly as `recording-strip.ts` and `recording-facts.ts` are.
 *
 * One rule runs through all of it: **a one-recording meeting must read exactly
 * as it did before this phase.** `combineSummary` returns null for it, the
 * strip says nothing new, and the source tags disappear — the extra vocabulary
 * appears only when there really is more than one capture to tell apart.
 */

import {
  clipEntryExtent,
  formatDuration,
  formatTimestamp,
  type ClipCandidate,
  type ClipEntry,
  type PendingAttach,
} from '@/lib/clips';
import type { ClipTextPolicy } from '@/lib/recording-clips';

// ---------------------------------------------------------------------------
// Policies — the three words the sheet offers
// ---------------------------------------------------------------------------

export interface PolicyChoice {
  value: ClipTextPolicy;
  label: string;
  /** One line under the label, in the sheet and in the add step. */
  hint: string;
}

/**
 * Text / Fill gaps only / Audio only (spec §UI). The order is deliberate:
 * `include` is what every clip of a one-recording meeting is, `gap_fill` is
 * what a second microphone almost always wants, and `exclude` is the escape
 * hatch that also makes a still-transcribing recording addable.
 */
export const POLICY_CHOICES: readonly PolicyChoice[] = [
  {
    value: 'include',
    label: 'Text',
    hint: 'Everything this recording heard goes into the transcript.',
  },
  {
    value: 'gap_fill',
    label: 'Fill gaps only',
    hint: 'Only what the other recordings did not catch — no double-ups.',
  },
  {
    value: 'exclude',
    label: 'Audio only',
    hint: 'Playable here, but none of its text is used.',
  },
] as const;

export function policyLabel(policy: ClipTextPolicy): string {
  return POLICY_CHOICES.find((p) => p.value === policy)?.label ?? 'Text';
}

// ---------------------------------------------------------------------------
// Source labels, shortened
// ---------------------------------------------------------------------------

/**
 * The short tag that rides beside a voice or an utterance — "Teams",
 * "Atira’s Mac", "corridor.m4a" — reconstructed from the SENTENCE.
 *
 * The FALLBACK, not the route: `ClipEntry.shortLabel` now carries the short
 * form, built server-side by `clipShortLabel` from the same facts the sentence
 * was built from, and `sourceTagOfEntry` below is what everything should call.
 * This reverses the small, closed set of shapes `clipSourceLabel` produces —
 * falling back to the sentence itself for anything it does not recognise,
 * never to a guess — and stays for the one case that still needs it: a
 * `ClipCandidate`, and an entry from a build (or a cached response) older than
 * `shortLabel`.
 */
export function shortSourceTag(sourceLabel: string): string {
  const label = (sourceLabel ?? '').trim();
  if (!label) return '';
  // "Upload · corridor.m4a" / "Atira’s upload · corridor.m4a" → the filename.
  const dot = label.indexOf(' · ');
  if (dot >= 0) return label.slice(dot + 3).trim();
  // "Recorded on your Mac" / "Recorded on Atira’s Mac" → "your Mac".
  const recorded = /^Recorded on (.+)$/.exec(label);
  if (recorded) return recorded[1]!.trim();
  // "Teams recording" / "Atira’s Teams recording" → "Teams" / "Atira’s Teams".
  const recording = /^(.+) recording$/.exec(label);
  if (recording) return recording[1]!.trim();
  // "Pasted transcript" / "Imported transcription" / a bare "Upload".
  return label;
}

/**
 * The tag for one clip — the server's `shortLabel` when it came with one, the
 * reverse-parse of the sentence when it did not.
 */
export function sourceTagOfEntry(
  entry: Pick<ClipEntry, 'shortLabel' | 'sourceLabel'>
): string {
  return (entry.shortLabel ?? '').trim() || shortSourceTag(entry.sourceLabel);
}

/** The tag for each clip's recording, keyed by recording id. */
export function sourceTagsByRecording(entries: readonly ClipEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) out.set(e.recordingId, sourceTagOfEntry(e));
  return out;
}

// ---------------------------------------------------------------------------
// The recording card's summary line
// ---------------------------------------------------------------------------

export interface CombinePart {
  ord: number;
  recordingId: string;
  /** "Teams recording" — the full sentence, owner already inside it. */
  label: string;
  /** "10m 00s" — null when the recording's length is unknown. */
  duration: string | null;
  /** "from 1:50" — null for a clip that starts the meeting. */
  from: string | null;
  /** The whole thing: "Teams recording (10m 00s from 1:50)". */
  text: string;
  policy: ClipTextPolicy;
  mine: boolean;
  primary: boolean;
}

export interface CombineSummary {
  /** "2 recordings". */
  heading: string;
  recordingCount: number;
  parts: CombinePart[];
  /** The parts joined with " · " — the card's one line. */
  text: string;
}

function partOf(entry: ClipEntry): CombinePart {
  const duration = entry.durationMs != null ? formatDuration(entry.durationMs) : null;
  const from = entry.offsetMs > 0 ? `from ${formatTimestamp(entry.offsetMs)}` : null;
  const inner = [duration, from].filter(Boolean).join(' ');
  return {
    ord: entry.ord,
    recordingId: entry.recordingId,
    label: entry.sourceLabel,
    duration,
    from,
    text: inner ? `${entry.sourceLabel} (${inner})` : entry.sourceLabel,
    policy: entry.textPolicy,
    mine: entry.mine,
    primary: entry.primary,
  };
}

/**
 * "2 recordings — Teams recording (4h 55m) · Atira’s upload · corridor.m4a
 * (1h 55m from 1:50:00)" (spec §UI).
 *
 * **null for one recording**, which is every meeting on prod: the card then
 * renders exactly what it rendered before this phase. Clips are ordered the
 * way they sit on the meeting's timeline (`offsetMs`, then `ord` — `ord` is
 * identity, never position).
 */
export function combineSummary(entries: readonly ClipEntry[] | null | undefined): CombineSummary | null {
  if (!entries || entries.length === 0) return null;
  const recordingCount = new Set(entries.map((e) => e.recordingId)).size;
  if (recordingCount < 2) return null;
  const ordered = [...entries].sort((a, b) => a.offsetMs - b.offsetMs || a.ord - b.ord);
  const parts = ordered.map(partOf);
  return {
    heading: `${recordingCount} recordings`,
    recordingCount,
    parts,
    text: parts.map((p) => p.text).join(' · '),
  };
}

// ---------------------------------------------------------------------------
// The sheet's clip rows
// ---------------------------------------------------------------------------

export interface ClipRow extends CombinePart {
  entry: ClipEntry;
  /** "you" / "Atira Sarat" / "atira@trames.sg" — a clip is somebody's bytes. */
  owner: string;
  /** Null = the row may be removed; a sentence = why not (the last clip). */
  removeBlockedReason: string | null;
  /** Null = the policy may be changed; a sentence = why not (still
   * transcribing, so `exclude` is the only legal answer). */
  policyBlockedReason: string | null;
}

export function ownerDisplay(entry: Pick<ClipEntry, 'mine' | 'ownerName' | 'ownerEmail'>): string {
  if (entry.mine) return 'you';
  return (entry.ownerName ?? '').trim() || (entry.ownerEmail ?? '').trim() || 'someone else';
}

/**
 * The sheet's list, in timeline order, each row already knowing why it cannot
 * be removed or re-policied — the same two reasons `validateDeleteClip` and
 * `validatePatchClip` refuse for, so nothing is offered that the route would
 * turn down (and nothing hidden that it would accept).
 */
export function clipRows(entries: readonly ClipEntry[]): ClipRow[] {
  const ordered = [...entries].sort((a, b) => a.offsetMs - b.offsetMs || a.ord - b.ord);
  const last = ordered.length <= 1;
  return ordered.map((entry) => ({
    ...partOf(entry),
    entry,
    owner: ownerDisplay(entry),
    removeBlockedReason: last
      ? 'This is the meeting’s only recording — removing it would leave nothing to play.'
      : null,
    policyBlockedReason: entry.transcribed
      ? null
      : 'This recording is still being transcribed, so only “Audio only” is possible for now.',
  }));
}

// ---------------------------------------------------------------------------
// "Add a recording…" — the candidate list
// ---------------------------------------------------------------------------

export interface CandidateGroup {
  key: 'meeting' | 'unlinked';
  title: string;
  candidates: ClipCandidate[];
}

/**
 * The two groups the spec names: "from another meeting I can edit" and "my
 * unlinked recordings" (spec §UI). A group with nothing in it is dropped
 * rather than shown empty, and the order is stable — meetings first, because
 * a recording with a meeting behind it is the one a person can recognise.
 *
 * Nothing is filtered here: `addable: false` rows stay, greyed, with the
 * route's own `blockedReason`. Hiding them would make somebody else's
 * recording look absent rather than not-yours.
 */
export function groupCandidates(candidates: readonly ClipCandidate[]): CandidateGroup[] {
  const fromMeeting = candidates.filter((c) => !c.unlinked);
  const unlinked = candidates.filter((c) => c.unlinked);
  const groups: CandidateGroup[] = [];
  if (fromMeeting.length > 0) {
    groups.push({ key: 'meeting', title: 'From another meeting you can edit', candidates: fromMeeting });
  }
  if (unlinked.length > 0) {
    groups.push({ key: 'unlinked', title: 'Your recordings that are not in a meeting', candidates: unlinked });
  }
  return groups;
}

/** "10m 00s · transcribed" / "5m 00s · still transcribing" — the row's facts. */
export function candidateFacts(c: ClipCandidate): string {
  const bits: string[] = [];
  if (c.durationMs != null) bits.push(formatDuration(c.durationMs));
  bits.push(c.transcribed ? 'transcribed' : 'still transcribing');
  if (!c.mine) bits.push(ownerDisplay(c));
  return bits.join(' · ');
}

/**
 * How many more recordings may be added, in words — "4 more can be added",
 * "1 more can be added", "this meeting is full".
 */
export function slotsLeftText(slotsLeft: number): string {
  if (slotsLeft <= 0) return 'This meeting is full — 6 recordings is the limit.';
  return `${slotsLeft} more ${slotsLeft === 1 ? 'recording' : 'recordings'} can be added.`;
}

// ---------------------------------------------------------------------------
// "Line them up" — the two-lane timeline
// ---------------------------------------------------------------------------

export interface TimelineLane {
  key: string;
  label: string;
  /** 0–100, of the drawing's full width. */
  leftPct: number;
  widthPct: number;
  /** `existing` = a clip the meeting already holds; `new` = the one being
   * placed, which is the only lane that moves as the offset changes. */
  kind: 'existing' | 'new';
  /** Open-ended: the recording's length is not known, so the bar is drawn to
   * the end and flagged rather than pretending to a width. */
  openEnded: boolean;
}

export interface TimelineModel {
  /** How long the drawing spans on the MEETING timeline, ms. */
  spanMs: number;
  lanes: TimelineLane[];
  /** True when the new recording does not touch any existing one at this
   * offset — almost always a wrong number, and worth saying so. */
  noOverlap: boolean;
  /** How much meeting time the new recording shares with the existing ones. */
  overlapMs: number;
}

const MIN_SPAN_MS = 1_000;

/**
 * The picture the align step draws: every clip the meeting already holds on
 * one row, and the recording being added on another, at the offset the person
 * is looking at right now.
 *
 * `POST /api/recordings/:id/align` answers with a number, NOT with envelopes
 * (`AlignOk` has no waveform in it), so this is a timeline of extents rather
 * than the overlaid envelopes the spec pictures — honest about what the server
 * actually knows, and enough to see at a glance that a 5-minute phone clip
 * lands inside a 10-minute meeting rather than past its end.
 */
export function alignTimeline(input: {
  entries: readonly ClipEntry[];
  /** The candidate's label and length; null length = open-ended. */
  candidate: { label: string; durationMs: number | null };
  offsetMs: number;
}): TimelineModel {
  const offset = Math.max(0, Math.round(input.offsetMs));
  const existing = input.entries.map((e) => {
    const [lo, hi] = clipEntryExtent(e);
    return { label: e.sourceLabel, lo, hi };
  });
  const newEnd = input.candidate.durationMs != null ? offset + input.candidate.durationMs : null;
  const ends = [
    ...existing.map((e) => e.hi ?? e.lo),
    newEnd ?? offset,
  ];
  const spanMs = Math.max(MIN_SPAN_MS, ...ends);
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / spanMs) * 100));

  const lanes: TimelineLane[] = existing.map((e, i) => ({
    key: `existing-${i}`,
    label: e.label,
    leftPct: pct(e.lo),
    widthPct: Math.max(0.5, pct(e.hi ?? spanMs) - pct(e.lo)),
    kind: 'existing' as const,
    openEnded: e.hi === null,
  }));
  lanes.push({
    key: 'new',
    label: input.candidate.label,
    leftPct: pct(offset),
    widthPct: Math.max(0.5, pct(newEnd ?? spanMs) - pct(offset)),
    kind: 'new',
    openEnded: newEnd === null,
  });

  const newLo = offset;
  const newHi = newEnd ?? spanMs;
  let overlapMs = 0;
  for (const e of existing) {
    const hi = e.hi ?? spanMs;
    overlapMs = Math.max(overlapMs, Math.min(hi, newHi) - Math.max(e.lo, newLo));
  }
  overlapMs = Math.max(0, overlapMs);
  return { spanMs, lanes, noOverlap: overlapMs <= 0, overlapMs };
}

/** ±1 s and ±10 s, the two nudges the spec asks for. */
export const NUDGE_STEPS_MS = [-10_000, -1_000, 1_000, 10_000] as const;

/** "−10s" / "+1s" — the nudge buttons' faces (a real minus sign, not a hyphen). */
export function nudgeLabel(ms: number): string {
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms);
  return `${sign}${abs >= 60_000 ? `${Math.round(abs / 60_000)}m` : `${Math.round(abs / 1000)}s`}`;
}

/** Nudge an offset, never below zero (an offset is a time from the start of
 * the MEETING — `validateClipWindowShape` refuses a negative one). */
export function nudgeOffset(offsetMs: number, deltaMs: number): number {
  return Math.max(0, Math.round(offsetMs + deltaMs));
}

// ---------------------------------------------------------------------------
// The align answer, in words
// ---------------------------------------------------------------------------

export interface AlignVerdictLine {
  /** 'ok' = use it; 'warn' = a weak match, look before you leap; 'none' =
   * nothing was found and NO number is applied. */
  tone: 'ok' | 'warn' | 'none';
  /** The sentence. */
  text: string;
  /** May the offset be filled in from this answer? False for 'none' — the
   * spec is explicit that a sub-0.4 answer applies no number (§"The offset"). */
  applies: boolean;
  /** "1:50 · 82% sure · 47 ppm drift" — the facts under the sentence. */
  facts: string;
}

/**
 * What the align step prints under the Guess button. `verdict` and `advice`
 * are `alignVerdict` / `alignAdvice` from the contract — the SAME two
 * functions the server uses to fill `AlignOk.advice`, so the page and the
 * route can never disagree about what 0.39 means.
 */
export function alignVerdictLine(input: {
  verdict: 'good' | 'weak' | 'none';
  offsetMs: number;
  confidence: number;
  driftPpm: number | null;
  overlapMs: number | null;
  advice: string | null;
}): AlignVerdictLine {
  const facts = [
    formatTimestamp(input.offsetMs),
    `${Math.round(Math.max(0, Math.min(1, input.confidence)) * 100)}% sure`,
    input.driftPpm != null ? `${Math.round(input.driftPpm)} ppm drift` : null,
    input.overlapMs != null ? `${formatDuration(input.overlapMs)} of shared audio` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (input.verdict === 'none') {
    return {
      tone: 'none',
      text: input.advice ?? 'Could not line these up — set the offset by ear.',
      applies: false,
      facts,
    };
  }
  if (input.verdict === 'weak') {
    return {
      tone: 'warn',
      text: input.advice ?? 'A weak match — check the two waveforms line up before you use it.',
      applies: true,
      facts,
    };
  }
  return {
    tone: 'ok',
    text: `These line up at ${formatTimestamp(input.offsetMs)}.`,
    applies: true,
    facts,
  };
}

// ---------------------------------------------------------------------------
// The player's parts
// ---------------------------------------------------------------------------

export interface PlayerPart {
  /** The clip's `ord` — its identity, and the part's key. */
  ord: number;
  recordingId: string;
  /**
   * The `?part=N` that plays this clip's file — 1 is the canonical, which the
   * plain `/audio` route serves.
   *
   * SERVED (`ClipEntry.mediaPart`), not derived: the numbering walks FILES,
   * not recordings, so only the server — which holds the media rows — knows
   * that a stop/restart recording swallowed two numbers. A clip whose
   * recording has no playable file gets no chip at all rather than a number
   * that 404s.
   */
  part: number;
  /** Every playable file of this clip's recording, canonical first
   * (`ClipEntry.mediaParts`). One entry for all but a stop/restart capture. */
  parts: number[];
  /** "Teams" / "corridor.m4a" — the chip's face. */
  label: string;
  /** Where this part starts on the MEETING timeline. */
  offsetMs: number;
  /** Where in the RECORDING the part starts (the clip's window). */
  fromMs: number;
  toMs: number | null;
  primary: boolean;
  policy: ClipTextPolicy;
}

/**
 * Parts = clips (spec §UI). One chip per clip, in timeline order, labelled by
 * source — and NOT offered at all for a one-recording meeting, which keeps
 * today's single-file player exactly as it is.
 *
 * The number each chip asks for is the SERVED `mediaPart`
 * (`combineView` → `mediaPartsByRecording`), because the `?part=N` numbering
 * walks playable FILES: a Meet recording that stopped and restarted holds two
 * of them, so a client counting recordings would send the phone that came
 * after it to the wrong file. A clip with no `mediaPart` has no playable file
 * on this meeting (bytes not held, or `scopeMediaToRow` withheld them) and is
 * dropped rather than given a number that 404s.
 *
 * The one fallback: when NOT ONE entry carries a `mediaPart` — a response
 * cached from a build before this field — the old
 * one-file-per-recording derivation is used, which is right for every meeting
 * whose recordings each hold a single file.
 */
export function playerParts(entries: readonly ClipEntry[] | null | undefined): PlayerPart[] {
  if (!entries || new Set(entries.map((e) => e.recordingId)).size < 2) return [];
  const ordered = [...entries].sort((a, b) => a.offsetMs - b.offsetMs || a.ord - b.ord);
  const served = ordered.some((e) => e.mediaPart != null);

  const derived = new Map<string, number>();
  if (!served) {
    for (const e of ordered) {
      if (!derived.has(e.recordingId)) derived.set(e.recordingId, derived.size + 1);
    }
  }

  const out: PlayerPart[] = [];
  for (const e of ordered) {
    const parts = served ? (e.mediaParts ?? []) : [derived.get(e.recordingId)!];
    const part = served ? e.mediaPart : (parts[0] ?? null);
    if (part == null) continue;
    out.push({
      ord: e.ord,
      recordingId: e.recordingId,
      part,
      parts: parts.length > 0 ? parts : [part],
      label: sourceTagOfEntry(e),
      offsetMs: e.offsetMs,
      fromMs: e.fromMs,
      toMs: e.toMs,
      primary: e.primary,
      policy: e.textPolicy,
    });
  }
  return out;
}

/**
 * Meeting ms → a position inside ONE clip's recording, and back.
 *
 * Switching part keeps the meeting time (spec §UI): the player asks for the
 * same instant on the new part's own clock, which is `meetingMs - offsetMs`
 * inside the clip's window. Clamped into the window, because the answer is
 * fed to a media element and a negative currentTime is a silent no-op.
 */
export function localMsInPart(part: PlayerPart, meetingMs: number): number {
  const raw = meetingMs - part.offsetMs;
  const lo = 0;
  const hi = part.toMs != null ? part.toMs - part.fromMs : null;
  const clamped = Math.max(lo, hi != null ? Math.min(raw, hi) : raw);
  return clamped;
}

/** The inverse: where a position inside a part sits on the meeting timeline. */
export function meetingMsOfPart(part: PlayerPart, localMs: number): number {
  return Math.max(0, part.offsetMs + Math.max(0, localMs));
}

// ---------------------------------------------------------------------------
// Uploads on their way in
// ---------------------------------------------------------------------------

export interface PendingAttachLine {
  /** "A recording is being added: Upload · transcribing…" */
  text: string;
  /** 'busy' = still on its way; 'err' = it failed and nothing will arrive. */
  tone: 'busy' | 'err';
  busy: boolean;
}

/**
 * The recording card's line for an upload that named this meeting and has not
 * landed yet (`ClipsResponse.pendingAttach`).
 *
 * `sourceLabel` is filename-free by construction on the server — the meeting's
 * readers have not been given these bytes yet — and nothing here adds one
 * back. "someone" rather than a name is deliberate too: who is uploading is
 * already in the label when it matters.
 */
export function pendingAttachLine(p: PendingAttach): PendingAttachLine {
  const where = p.offsetMs > 0 ? ` at ${formatTimestamp(p.offsetMs)}` : '';
  if (p.state === 'failed') {
    return {
      text: `${p.sourceLabel} was going to be added${where}, but the upload failed — nothing was added.`,
      tone: 'err',
      busy: false,
    };
  }
  const verb = p.state === 'uploading' ? 'uploading' : 'transcribing';
  return {
    text: `A recording is being added: ${p.sourceLabel}${where} · ${verb}…`,
    tone: 'busy',
    busy: true,
  };
}
