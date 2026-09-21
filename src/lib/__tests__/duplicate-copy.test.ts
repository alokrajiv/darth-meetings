import { describe, expect, test } from 'bun:test';
import type { DuplicateMatch } from '@/lib/same-file';
import {
  DUPLICATE_HEADLINE,
  NOTHING_UPLOADED,
  UNTITLED_MATCH,
  duplicateCopy,
  duplicateRowLine,
  matchAction,
  matchDay,
  matchFacts,
  matchLength,
  matchNote,
  matchTitle,
  stillTranscribing,
} from '@/lib/duplicate-copy';
import { formatDuration } from '@/lib/format';
import { dayLabelCompact } from '@/lib/when';

/**
 * TZ-independent on purpose: every date that has to format to an exact string
 * is built with the LOCAL constructor (`new Date(y, m, d, …)`), which means the
 * local calendar day is the one we wrote down whatever TZ the runner is in.
 * The one ISO input is asserted against the same formatter, not a literal.
 */

/** 2026-09-17 was a Thursday; 2026-09-16 a Wednesday. Local, not UTC. */
const WED_17_SEP = new Date(2026, 8, 17, 14, 30);
const NOW_2026 = new Date(2026, 8, 22, 9, 0);

const iso = (d: Date) => d.toISOString();

function match(over: Partial<DuplicateMatch> = {}): DuplicateMatch {
  return {
    meetingId: 'abc-123',
    title: 'Weekly sync',
    when: iso(WED_17_SEP),
    status: 'completed',
    durationSec: 4182,
    trashed: false,
    ...over,
  };
}

describe('matchTitle', () => {
  test('uses the meeting title', () => {
    expect(matchTitle({ title: 'Weekly sync' })).toBe('Weekly sync');
  });
  test('a null title is never a filename', () => {
    expect(matchTitle({ title: null })).toBe(UNTITLED_MATCH);
  });
  test('whitespace is not a title', () => {
    expect(matchTitle({ title: '   ' })).toBe(UNTITLED_MATCH);
  });
  test('a title is trimmed but otherwise untouched', () => {
    expect(matchTitle({ title: '  SI-BL re-alignment  ' })).toBe('SI-BL re-alignment');
  });
});

describe('matchLength', () => {
  /** The listing, the Recording card and this dialog are one number: whatever
   * `formatDuration` says, and never a second opinion. */
  test('is the listing formatter, seconds and all', () => {
    for (const secs of [4182, 3 * 3600 + 5 * 60, 47 * 60 + 45, 60, 38]) {
      expect(matchLength(secs)).toBe(formatDuration(secs));
    }
  });
  test('the "56m" bug: a 56m 45s meeting says 56m 45s here too', () => {
    expect(matchLength(56 * 60 + 45)).toBe('56m 45s');
  });
  test('over an hour, under a minute', () => {
    expect(matchLength(4182)).toBe('1h 9m');
    expect(matchLength(38)).toBe('38s');
  });
  test('a fractional second is floored, not rounded up past the mark', () => {
    expect(matchLength(45.9)).toBe('45s');
  });
  test('nothing usable is null, never "0s"', () => {
    expect(matchLength(null)).toBeNull();
    expect(matchLength(undefined)).toBeNull();
    expect(matchLength(0)).toBeNull();
    expect(matchLength(0.4)).toBeNull();
    expect(matchLength(Number.NaN)).toBeNull();
    expect(matchLength(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('matchDay', () => {
  test('this year: no year', () => {
    expect(matchDay(iso(WED_17_SEP), NOW_2026)).toBe(dayLabelCompact(WED_17_SEP, NOW_2026));
    expect(matchDay(iso(WED_17_SEP), NOW_2026)).not.toMatch(/2026/);
  });
  test('another year: the year comes back', () => {
    const lastYear = new Date(2025, 8, 17, 14, 30);
    expect(matchDay(iso(lastYear), NOW_2026)).toMatch(/2025$/);
  });
  test('no date, or a broken one, is null', () => {
    expect(matchDay(null, NOW_2026)).toBeNull();
    expect(matchDay('not a date', NOW_2026)).toBeNull();
  });
});

describe('matchFacts', () => {
  test('title · day · length', () => {
    const facts = matchFacts(match(), NOW_2026);
    expect(facts).toBe(`Weekly sync · ${dayLabelCompact(WED_17_SEP, NOW_2026)} · 1h 9m`);
  });
  test('missing parts are dropped, not dashed', () => {
    expect(matchFacts(match({ when: null, durationSec: null }), NOW_2026)).toBe('Weekly sync');
    expect(matchFacts(match({ title: null, when: null, durationSec: null }), NOW_2026)).toBe(
      UNTITLED_MATCH
    );
  });
  test('a title always survives, so the line is never empty', () => {
    expect(matchFacts(match({ title: '', when: null, durationSec: null }), NOW_2026).length).toBeGreaterThan(0);
  });
});

describe('matchNote and the action', () => {
  test('a finished match just offers itself', () => {
    expect(matchNote(match())).toBeNull();
    expect(matchAction(match())).toEqual({
      kind: 'open',
      label: 'Open it',
      href: '/transcript/abc-123',
    });
  });
  test('still running says so and still opens', () => {
    for (const status of ['processing', 'queued', 'waiting']) {
      expect(stillTranscribing(status)).toBe(true);
      expect(matchNote(match({ status }))).toBe('It is still being transcribed.');
      expect(matchAction(match({ status })).kind).toBe('open');
    }
  });
  test('completed and error are not "still being transcribed"', () => {
    expect(stillTranscribing('completed')).toBe(false);
    expect(stillTranscribing('error')).toBe(false);
  });
  test('trashed offers Restore it, and wins over the running note', () => {
    expect(matchAction(match({ trashed: true })).label).toBe('Restore it');
    expect(matchNote(match({ trashed: true, status: 'processing' }))).toMatch(/trash/);
  });
});

describe('duplicateRowLine', () => {
  test('headline, colon, then the match', () => {
    expect(duplicateRowLine(match(), NOW_2026)).toBe(
      `${DUPLICATE_HEADLINE}: ${matchFacts(match(), NOW_2026)}`
    );
  });
  test('an em dash in the title does not collide with the join', () => {
    const line = duplicateRowLine(match({ title: 'Kerner — Q3 close' }), NOW_2026);
    // The only em dash on the line is the one the title brought.
    expect(line.split('—').length - 1).toBe(1);
    expect(line.startsWith(`${DUPLICATE_HEADLINE}: Kerner — Q3 close ·`)).toBe(true);
  });
  test('an untitled match still reads as a sentence', () => {
    expect(duplicateRowLine(match({ title: null }), NOW_2026)).toContain(
      `${DUPLICATE_HEADLINE}: ${UNTITLED_MATCH}`
    );
  });
});

describe('duplicateCopy', () => {
  test('carries the headline, the facts and the reassurance', () => {
    const copy = duplicateCopy(match(), NOW_2026);
    expect(copy.headline).toBe(DUPLICATE_HEADLINE);
    expect(copy.rowLine).toBe(duplicateRowLine(match(), NOW_2026));
    expect(copy.facts).toContain('Weekly sync');
    expect(copy.reassurance).toBe(NOTHING_UPLOADED);
    expect(copy.note).toBeNull();
    expect(copy.action.href).toBe('/transcript/abc-123');
  });
  test('never leaks a filename into the title slot', () => {
    const copy = duplicateCopy(match({ title: null }), NOW_2026);
    expect(copy.facts.startsWith(UNTITLED_MATCH)).toBe(true);
  });
});

