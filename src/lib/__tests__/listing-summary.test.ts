/**
 * The listing row's summary badge (2026-10-27): one state per row, one
 * badge, at most one action, viewers see the badge only; and the `?do=`
 * intent the action carries to the detail page.
 */
import { describe, expect, test } from 'bun:test';
import {
  SUMMARY_ACTION,
  SUMMARY_BADGE_LABEL,
  readDoIntent,
  resolveDoIntent,
  summaryBadgeFor,
  summaryStateOf,
  transcriptIntentHref,
  withoutDoParam,
  type SummaryRowInput,
} from '../listing-summary';

/** A completed archive row with notes — the clean row, no badge. */
const done: SummaryRowInput = {
  status: 'completed',
  deleted_at: null,
  auto_notes_status: 'completed',
  speaker_id_status: 'completed',
  has_notes: true,
};

describe('summaryStateOf — the table, in order', () => {
  test('summary running → running, whatever else is true', () => {
    expect(summaryStateOf({ ...done, auto_notes_status: 'running', has_notes: false })).toBe('running');
    expect(summaryStateOf({ ...done, auto_notes_status: 'running', speaker_id_status: 'running' })).toBe('running');
  });

  test('speakers running → speakers (before failed / missing)', () => {
    expect(summaryStateOf({ ...done, speaker_id_status: 'running', auto_notes_status: null, has_notes: false })).toBe(
      'speakers'
    );
    expect(summaryStateOf({ ...done, speaker_id_status: 'running', auto_notes_status: 'error' })).toBe('speakers');
  });

  test('failed → failed, with or without old notes', () => {
    expect(summaryStateOf({ ...done, auto_notes_status: 'error', has_notes: false })).toBe('failed');
    expect(summaryStateOf({ ...done, auto_notes_status: 'error', has_notes: true })).toBe('failed');
  });

  test('completed, no notes, nothing running or failed → missing', () => {
    expect(summaryStateOf({ ...done, auto_notes_status: null, has_notes: false })).toBe('missing');
    expect(summaryStateOf({ ...done, auto_notes_status: null, speaker_id_status: null, has_notes: false })).toBe(
      'missing'
    );
  });

  test('has notes → no badge, the row stays clean', () => {
    expect(summaryStateOf(done)).toBeNull();
    expect(summaryStateOf({ ...done, auto_notes_status: null })).toBeNull();
  });

  test('not completed / trashed → no badge (their existing status UI stays)', () => {
    for (const status of ['queued', 'processing', 'uploading', 'waiting', 'error']) {
      expect(summaryStateOf({ ...done, status, has_notes: false, auto_notes_status: null })).toBeNull();
    }
    expect(summaryStateOf({ ...done, deleted_at: '2026-10-27T00:00:00Z', has_notes: false, auto_notes_status: null })).toBeNull();
  });

  test('an auto-imported row gated by the automatic review gets no summary badge — its amber chip is the one signal', () => {
    const gated: SummaryRowInput = { ...done, auto_notes_status: null, has_notes: false, auto_state: 'gated' };
    expect(summaryStateOf(gated)).toBeNull();
    expect(summaryBadgeFor(gated, true)).toBeNull();
    // Other outcomes change nothing.
    expect(summaryStateOf({ ...gated, auto_state: 'passed' })).toBe('missing');
    expect(summaryStateOf({ ...gated, auto_state: null })).toBe('missing');
    // A failed run on a gated row still has no badge: one signal per row.
    expect(summaryStateOf({ ...gated, auto_notes_status: 'error' })).toBeNull();
  });

  test('a row that does not say whether notes exist claims nothing', () => {
    expect(summaryStateOf({ status: 'completed', auto_notes_status: null })).toBeNull();
    expect(summaryStateOf({ status: 'completed', auto_notes_status: null, has_notes: null })).toBeNull();
    // …but running / failed are still visible on such rows.
    expect(summaryStateOf({ status: 'completed', auto_notes_status: 'error' })).toBe('failed');
  });
});

describe('summaryBadgeFor — one badge, at most one action', () => {
  const missing: SummaryRowInput = { ...done, auto_notes_status: null, has_notes: false };

  test('owner / editor: label + the action for the state', () => {
    expect(summaryBadgeFor(missing, true)).toEqual({
      state: 'missing',
      label: 'No summary yet',
      action: { label: 'Generate', intent: 'generate' },
    });
    expect(summaryBadgeFor({ ...done, auto_notes_status: 'error' }, true)).toEqual({
      state: 'failed',
      label: 'Summary failed',
      action: { label: 'Retry', intent: 'generate' },
    });
    expect(summaryBadgeFor({ ...missing, speaker_id_status: 'running' }, true)).toEqual({
      state: 'speakers',
      label: 'Identifying speakers…',
      action: { label: 'Review speakers', intent: 'review' },
    });
    expect(summaryBadgeFor({ ...missing, auto_notes_status: 'running' }, true)).toEqual({
      state: 'running',
      label: 'Writing summary…',
      action: null,
    });
  });

  test('a viewer sees the badge and no action', () => {
    for (const row of [missing, { ...done, auto_notes_status: 'error' }, { ...missing, speaker_id_status: 'running' }]) {
      const badge = summaryBadgeFor(row, false)!;
      expect(badge).not.toBeNull();
      expect(badge.action).toBeNull();
      expect(badge.label).toBe(SUMMARY_BADGE_LABEL[badge.state]);
    }
  });

  test('no state → no badge for anyone', () => {
    expect(summaryBadgeFor(done, true)).toBeNull();
    expect(summaryBadgeFor(done, false)).toBeNull();
  });

  test('every state has a label; running is the one with no action', () => {
    for (const state of ['running', 'speakers', 'failed', 'missing'] as const) {
      expect(SUMMARY_BADGE_LABEL[state].length).toBeGreaterThan(3);
    }
    expect(SUMMARY_ACTION.running).toBeNull();
    expect(SUMMARY_ACTION.failed?.intent).toBe('generate');
  });
});

describe('the ?do= intent', () => {
  test('the href carries the intent to the meeting', () => {
    expect(transcriptIntentHref('up-aaa', 'generate')).toBe('/transcript/up-aaa?do=generate');
    expect(transcriptIntentHref('up-aaa', 'review')).toBe('/transcript/up-aaa?do=review');
    expect(transcriptIntentHref('a b', 'review')).toBe('/transcript/a%20b?do=review');
  });

  test('readDoIntent: only the two intents, anything else is null', () => {
    expect(readDoIntent('?do=generate')).toBe('generate');
    expect(readDoIntent('?tab=report&do=review')).toBe('review');
    expect(readDoIntent('?do=delete')).toBeNull();
    expect(readDoIntent('')).toBeNull();
    expect(readDoIntent('?tab=report')).toBeNull();
  });

  test('generate with unconfirmed speakers opens the review first (the "No notes yet" rule)', () => {
    expect(resolveDoIntent('generate', 0)).toBe('generate');
    expect(resolveDoIntent('generate', 2)).toBe('review');
    expect(resolveDoIntent('review', 0)).toBe('review');
    expect(resolveDoIntent('review', 2)).toBe('review');
  });

  test('withoutDoParam strips only `do`, so a reload does not reopen the dialog', () => {
    expect(withoutDoParam('https://x.test/transcript/up-aaa?do=generate')).toBe('https://x.test/transcript/up-aaa');
    expect(withoutDoParam('https://x.test/transcript/up-aaa?tab=report&do=review#t=12')).toBe(
      'https://x.test/transcript/up-aaa?tab=report#t=12'
    );
    expect(withoutDoParam('https://x.test/transcript/up-aaa?tab=report')).toBe('https://x.test/transcript/up-aaa?tab=report');
  });
});
