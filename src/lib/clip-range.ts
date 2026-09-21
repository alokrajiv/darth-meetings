/**
 * Choosing the window — the arithmetic behind the split dialog's two handles
 * (docs/recordings-phase3-clips-spec.md §UI).
 *
 * "From when Paola joined until she left is its own meeting." A person drags
 * two handles over the player's timeline; what they mean is a pair of
 * UTTERANCE boundaries, not a pair of pixels. So a handle snaps to the
 * nearest boundary it is already near, and the dialog says in words what the
 * range currently is: "12:40 – 33:20 · 13m 20s · 3 voices".
 *
 * Pure: no React, no DOM. Everything is milliseconds on the MEETING timeline
 * — the same numbers `POST …/split` takes.
 */

import { formatDuration, formatTimestamp, type ClipHole } from '@/lib/clips';

/** The minimum an utterance needs to take part in a range. */
export interface RangeUtterance {
  speaker: string;
  start: number;
  end: number;
}

/** How far a handle may be from a boundary and still be pulled onto it. */
export const SNAP_MS = 4_000;

/**
 * Where a handle is allowed to land: every utterance edge, plus 0, the end of
 * the meeting, and both sides of every hole (a hole's edges are real
 * boundaries — they are where a previous split cut).
 *
 * Sorted and de-duplicated, because `snapMs` walks them and a dialog that
 * snapped to the same millisecond twice would feel like it was stuck.
 */
export function rangeBoundaries(
  utterances: readonly RangeUtterance[] | null | undefined,
  spanMs: number,
  holes: readonly ClipHole[] = []
): number[] {
  const set = new Set<number>([0, Math.max(0, Math.round(spanMs))]);
  for (const u of utterances ?? []) {
    if (Number.isFinite(u.start)) set.add(Math.round(u.start));
    if (Number.isFinite(u.end)) set.add(Math.round(u.end));
  }
  for (const h of holes) {
    set.add(h.fromMs);
    set.add(h.toMs);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Pull a handle onto the nearest boundary within `tolerance`, or leave it
 * exactly where it was dropped.
 *
 * Deliberately NOT "always snap to the nearest": on a meeting with long
 * monologues the nearest boundary can be minutes away, and a handle that
 * jumps half the recording feels broken.
 */
export function snapMs(value: number, boundaries: readonly number[], tolerance = SNAP_MS): number {
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const b of boundaries) {
    const gap = Math.abs(b - value);
    if (gap < bestGap) {
      bestGap = gap;
      best = b;
    }
  }
  return best !== null && bestGap <= tolerance ? best : Math.round(value);
}

/** How many different voices speak inside `[fromMs, toMs)`. */
export function voicesIn(
  utterances: readonly RangeUtterance[] | null | undefined,
  fromMs: number,
  toMs: number
): number {
  const seen = new Set<string>();
  for (const u of utterances ?? []) {
    // An utterance counts when it OVERLAPS the range, not only when it is
    // wholly inside it — the sentence someone is halfway through when the
    // window opens is still their voice in this meeting.
    if (u.start < toMs && u.end > fromMs) seen.add(u.speaker);
  }
  return seen.size;
}

/** How many utterances the window would take with it. */
export function utterancesIn(
  utterances: readonly RangeUtterance[] | null | undefined,
  fromMs: number,
  toMs: number
): number {
  let n = 0;
  for (const u of utterances ?? []) if (u.start >= fromMs && u.start < toMs) n += 1;
  return n;
}

/**
 * The live line under the handles: "12:40 – 33:20 · 13m 20s · 3 voices".
 *
 * Plain sentence, 24-hour-style clock times, no filenames
 * (docs/transcript-page-redesign.md). "1 voice" is singular; a window nobody
 * speaks in says so rather than printing "0 voices".
 */
export function rangeSummary(input: { fromMs: number; toMs: number; voices: number }): string {
  const parts = [
    `${formatTimestamp(input.fromMs)} – ${formatTimestamp(input.toMs)}`,
    formatDuration(Math.max(0, input.toMs - input.fromMs)),
  ];
  parts.push(
    input.voices === 0 ? 'nobody speaks' : input.voices === 1 ? '1 voice' : `${input.voices} voices`
  );
  return parts.join(' · ');
}

/**
 * Does a calendar event overlap the stretch of wall-clock the window covers?
 *
 * The picker in the split dialog is pre-filtered with this, so "link this
 * part to a calendar event" offers the three invites that were actually
 * running while it was recorded instead of the whole day.
 */
export function eventOverlapsWindow(
  event: { start: string; end: string | null },
  windowStartMs: number,
  windowEndMs: number
): boolean {
  const start = Date.parse(event.start);
  if (!Number.isFinite(start)) return false;
  const end = event.end ? Date.parse(event.end) : start + 60 * 60 * 1000;
  return start < windowEndMs && (Number.isFinite(end) ? end : start) > windowStartMs;
}
