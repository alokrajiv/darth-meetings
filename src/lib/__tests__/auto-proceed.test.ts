/**
 * The grace-window auto-proceed eligibility rule (2026-10-27) — the ONE
 * pure helper behind the detail page's `autoProceedAt`, the listing's
 * `auto_proceed_at` and the server's re-check; `listAutoProceedBacklog` is
 * its SQL twin (pinned in lib/server/__tests__/auto-proceed-wiring.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import {
  AUTO_PROCEED_GRACE_MIN,
  AUTO_PROCEED_WINDOW_HOURS,
  autoProceedAt,
  autoProceedDue,
  autoProceedFactsOf,
  type AutoProceedFacts,
} from '../auto-proceed';
import type { StoredTranscript } from '../format';

const NOW = new Date('2026-10-27T03:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** A tray upload, speakers identified 3 minutes ago, nobody has acted. */
const eligible: AutoProceedFacts = {
  status: 'completed',
  deleted_at: null,
  speaker_id_status: 'completed',
  speaker_id_at: minutesAgo(3),
  hasNotes: false,
  auto_notes_status: null,
  auto_report_status: null,
  autoReviewed: false,
  reportPref: null,
  autoMarked: false,
};

describe('autoProceedAt', () => {
  test('eligible → speaker_id_at + grace, as ISO', () => {
    expect(AUTO_PROCEED_GRACE_MIN).toBe(10);
    expect(AUTO_PROCEED_WINDOW_HOURS).toBe(48);
    expect(autoProceedAt(eligible, NOW)).toBe(new Date(NOW.getTime() + 7 * 60_000).toISOString());
    expect(autoProceedAt(eligible, NOW, { graceMin: 2 })).toBe(new Date(NOW.getTime() - 60_000).toISOString());
  });

  test('each condition flipped on its own excludes the row', () => {
    const flips: Array<[string, Partial<AutoProceedFacts>]> = [
      ['not completed', { status: 'processing' }],
      ['errored transcription', { status: 'error' }],
      ['trashed', { deleted_at: '2026-10-27T02:00:00.000Z' }],
      ['speaker pass running', { speaker_id_status: 'running' }],
      ['speaker pass never ran', { speaker_id_status: null }],
      ['speaker pass errored', { speaker_id_status: 'error' }],
      ['no speaker_id_at', { speaker_id_at: null }],
      ['unparseable speaker_id_at', { speaker_id_at: 'soon' }],
      ['notes exist', { hasNotes: true }],
      ['a notes run is in flight', { auto_notes_status: 'running' }],
      ['the notes run failed', { auto_notes_status: 'error' }],
      ['a report run exists', { auto_report_status: 'completed' }],
      ['evaluated or held already', { autoReviewed: true }],
      ["upload asked for 'later'", { reportPref: 'later' }],
      ['automation owns the row', { autoMarked: true }],
      ['pass finished longer ago than the window', { speaker_id_at: minutesAgo(48 * 60 + 1) }],
    ];
    for (const [why, over] of flips) {
      expect(autoProceedAt({ ...eligible, ...over }, NOW), why).toBeNull();
    }
  });

  test('inside the window but past the grace is still eligible (the sweeper is late, not the row)', () => {
    const late = { ...eligible, speaker_id_at: minutesAgo(90) };
    expect(autoProceedAt(late, NOW)).toBe(new Date(NOW.getTime() - 80 * 60_000).toISOString());
    expect(autoProceedAt({ ...eligible, speaker_id_at: minutesAgo(47 * 60) }, NOW)).not.toBeNull();
  });

  test('report prefs: the retired summary and both detailed flavours are eligible, later is not', () => {
    for (const pref of [null, undefined, 'summary', 'detailed-text', 'detailed-video', 'bogus']) {
      expect(autoProceedAt({ ...eligible, reportPref: pref }, NOW), String(pref)).not.toBeNull();
    }
    expect(autoProceedAt({ ...eligible, reportPref: 'later' }, NOW)).toBeNull();
  });

  test('temporary (scratch) rows are not excluded — the facts carry no scratch flag at all', () => {
    expect('scratch' in eligible).toBe(false);
  });
});

describe('autoProceedDue — eligible AND the grace is over', () => {
  test('3 min after the pass: eligible, not due; 11 min after: due', () => {
    expect(autoProceedDue(eligible, NOW)).toBe(false);
    expect(autoProceedDue({ ...eligible, speaker_id_at: minutesAgo(11) }, NOW)).toBe(true);
    expect(autoProceedDue({ ...eligible, speaker_id_at: minutesAgo(10) }, NOW)).toBe(true);
    expect(autoProceedDue({ ...eligible, speaker_id_at: minutesAgo(11), hasNotes: true }, NOW)).toBe(false);
  });
});

describe('autoProceedFactsOf — a full row to the facts', () => {
  const row = {
    status: 'completed',
    deleted_at: null,
    speaker_id_status: 'completed',
    speaker_id_at: minutesAgo(12),
    auto_notes: null,
    auto_notes_status: null,
    auto_report_status: null,
    gmeet_context: null,
  } as unknown as StoredTranscript;

  test('a manual upload with no context is eligible and due', () => {
    expect(autoProceedFactsOf(row)).toEqual({ ...eligible, speaker_id_at: minutesAgo(12) });
    expect(autoProceedDue(autoProceedFactsOf(row), NOW)).toBe(true);
  });

  test('a split half / make-meeting inherits speaker_id_status completed from its source and is eligible too (task 01)', () => {
    const half = {
      ...row,
      gmeet_context: { splitFrom: { meetingId: 'up-src', fromMs: 0, toMs: 60_000, at: minutesAgo(12), by: { email: null, name: null } } },
    } as unknown as StoredTranscript;
    const facts = autoProceedFactsOf(half);
    expect(facts.autoMarked).toBe(false);
    expect(facts.autoReviewed).toBe(false);
    expect(autoProceedAt(facts, NOW)).not.toBeNull();
  });

  test('context flags: autoReview (any outcome, incl. held) and automation markers exclude; uploadPrefs.report is read', () => {
    const ctx = (c: Record<string, unknown>) => ({ ...row, gmeet_context: c }) as unknown as StoredTranscript;
    expect(autoProceedFactsOf(ctx({ autoReview: { evaluatedAt: 'x', passed: false, mode: 'held' } })).autoReviewed).toBe(true);
    expect(autoProceedFactsOf(ctx({ autoReview: { evaluatedAt: 'x', passed: false, mode: 'grace', reason: 'r' } })).autoReviewed).toBe(true);
    expect(autoProceedFactsOf(ctx({ autoReview: null })).autoReviewed).toBe(false);
    expect(autoProceedFactsOf(ctx({ autoImport: { seriesId: 1, occKey: 'k', byUserId: 'u', byEmail: 'test-a@example.com', at: 'x' } })).autoMarked).toBe(true);
    expect(autoProceedFactsOf(ctx({ autoSync: { occKey: 'k', byUserId: 'u', byEmail: 'test-a@example.com', watchers: [], at: 'x' } })).autoMarked).toBe(true);
    expect(autoProceedFactsOf(ctx({ autoImport: null, autoSync: null })).autoMarked).toBe(false);
    expect(autoProceedFactsOf(ctx({ uploadPrefs: { report: 'later' } })).reportPref).toBe('later');
    expect(autoProceedFactsOf({ ...row, auto_notes: 'Notes' } as unknown as StoredTranscript).hasNotes).toBe(true);
    expect(autoProceedFactsOf({ ...row, auto_notes: '' } as unknown as StoredTranscript).hasNotes).toBe(false);
  });
});
