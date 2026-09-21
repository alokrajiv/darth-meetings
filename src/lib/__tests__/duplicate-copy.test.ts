import { describe, expect, test } from 'bun:test';
import type { DuplicateMatch } from '@/lib/same-file';
import {
  DUPLICATE_HEADLINE,
  NOTHING_UPLOADED,
  UNTITLED_MATCH,
  duplicateCopy,
  matchAction,
  matchDay,
  matchFacts,
  matchLength,
  matchNote,
  matchTitle,
  stillTranscribing,
} from '@/lib/duplicate-copy';
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
  test('the spec example: 4182 s is 1h 09m', () => {
    expect(matchLength(4182)).toBe('1h 09m');
  });
  test('minutes inside an hour are zero padded', () => {
    expect(matchLength(3 * 3600 + 5 * 60)).toBe('3h 05m');
    expect(matchLength(2 * 3600 + 59 * 60 + 59)).toBe('2h 59m');
  });
  test('under an hour is plain minutes', () => {
    expect(matchLength(47 * 60)).toBe('47m');
    expect(matchLength(60)).toBe('1m');
  });
  test('under a minute is seconds', () => {
    expect(matchLength(38)).toBe('38s');
    expect(matchLength(1)).toBe('1s');
  });
  test('nothing usable is null, never "0m"', () => {
    expect(matchLength(null)).toBeNull();
    expect(matchLength(undefined)).toBeNull();
    expect(matchLength(0)).toBeNull();
    expect(matchLength(0.4)).toBeNull();
    expect(matchLength(Number.NaN)).toBeNull();
    expect(matchLength(Number.POSITIVE_INFINITY)).toBeNull();
  });
  test('an exact hour has no stray minutes', () => {
    expect(matchLength(3600)).toBe('1h 00m');
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
    expect(facts).toBe(`Weekly sync · ${dayLabelCompact(WED_17_SEP, NOW_2026)} · 1h 09m`);
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

describe('duplicateCopy', () => {
  test('carries the headline, the facts and the reassurance', () => {
    const copy = duplicateCopy(match(), NOW_2026);
    expect(copy.headline).toBe(DUPLICATE_HEADLINE);
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

