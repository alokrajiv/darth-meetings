import type { DuplicateMatch } from '@/lib/same-file';
import { dayLabelCompact, safeDate } from '@/lib/when';

/**
 * "You already have this recording" — what the upload dialog says when the
 * server recognises the bytes (docs/recordings-same-file-spec.md §Clients).
 *
 * Pure: no React, no fetch, no db. Everything the dialog renders is decided
 * here so it can be read as English in one place and tested without a browser.
 *
 * Two rules the copy exists to keep:
 *  - **A filename is never a title** (docs/listing-ui-redesign.md). The match
 *    may genuinely have no title; it is then "an untitled recording" — never
 *    the name of the file the reader just picked, which would make two
 *    different things look like the same thing.
 *  - **Nothing happened.** A duplicate answer means no row, no session, no
 *    bytes. Say so, or the reader spends the next minute looking for a half
 *    upload to clean up.
 */

/** A match with no title of its own. Never the picked file's name. */
export const UNTITLED_MATCH = 'an untitled recording';

export const DUPLICATE_HEADLINE = 'You already have this recording';

/** The meeting is in a state where its text is still being produced. */
export function stillTranscribing(status: string): boolean {
  return status !== 'completed' && status !== 'error';
}

/** "Weekly sync", or "an untitled recording". */
export function matchTitle(match: Pick<DuplicateMatch, 'title'>): string {
  const t = match.title?.trim();
  return t ? t : UNTITLED_MATCH;
}

/** "Wed 17 Sep" (this year) / "Wed 17 Sep 2025". null when we have no date. */
export function matchDay(when: string | null, now: Date = new Date()): string | null {
  const d = safeDate(when);
  return d ? dayLabelCompact(d, now) : null;
}

/**
 * "1h 09m" / "47m" / "38s". Zero-padded minutes inside an hour so a column of
 * these lines up and "1h 9m" never reads as nine of something.
 */
export function matchLength(durationSec: number | null | undefined): string | null {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec < 1) return null;
  const total = Math.floor(durationSec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/**
 * The facts line: "Weekly sync · Wed 17 Sep · 1h 09m". Missing parts are left
 * out rather than filled with a dash — an empty slot is not a fact.
 */
export function matchFacts(match: DuplicateMatch, now: Date = new Date()): string {
  return [matchTitle(match), matchDay(match.when, now), matchLength(match.durationSec)]
    .filter((p): p is string => !!p)
    .join(' · ');
}

/**
 * The one extra sentence, if there is one to say. Trash first: it is the case
 * where the reader would otherwise conclude the match is a ghost.
 */
export function matchNote(match: DuplicateMatch): string | null {
  if (match.trashed) return 'It is in your trash — putting it back is quicker than transcribing it again.';
  if (stillTranscribing(match.status)) return 'It is still being transcribed.';
  return null;
}

/** Said in every case: the upload has not started, so there is nothing to undo. */
export const NOTHING_UPLOADED = 'Nothing has been uploaded.';

export interface MatchAction {
  kind: 'open' | 'restore';
  label: string;
  href: string;
}

export function matchAction(match: DuplicateMatch): MatchAction {
  const href = `/transcript/${match.meetingId}`;
  return match.trashed
    ? { kind: 'restore', label: 'Restore it', href }
    : { kind: 'open', label: 'Open it', href };
}

/** Everything the dialog (and the upload row) renders, in one object. */
export interface DuplicateCopy {
  headline: string;
  facts: string;
  note: string | null;
  reassurance: string;
  action: MatchAction;
}

export function duplicateCopy(match: DuplicateMatch, now: Date = new Date()): DuplicateCopy {
  return {
    headline: DUPLICATE_HEADLINE,
    facts: matchFacts(match, now),
    note: matchNote(match),
    reassurance: NOTHING_UPLOADED,
    action: matchAction(match),
  };
}
