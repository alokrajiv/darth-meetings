/**
 * The suggestion's words (docs/recorder-link-confirm-spec.md D4) and the
 * "no video" note (D6). Both are pure, and both exist so a human sees the
 * mismatch that the 2026-09-22 auto-link never showed anyone.
 */
import { describe, expect, test } from 'bun:test';
import {
  noVideoNote,
  occurrenceTimeRange,
  providerLabel,
  suggestedEventLine,
  suggestedEventWhy,
} from '@/lib/suggested-event';
import type { SuggestedEvent } from '@/lib/format';

// The incident, in UTC (bun test runs with TZ=UTC): 07:30–08:30Z = 15:30–16:30 SGT.
const TRITON: SuggestedEvent = {
  key: 'ev-triton|2026-09-22T07:30:00.000Z',
  eventId: 'ev-triton',
  title: 'Triton next steps!',
  startIso: '2026-09-22T07:30:00.000Z',
  endIso: '2026-09-22T08:30:00.000Z',
  provider: 'meet',
  meetingCode: 'bgs-zqvv-dby',
  score: 0.3,
  overlap: 1,
  titleScore: 0,
  callKind: 'slack',
};

describe('the strip’s sentence', () => {
  test('title, time range and product', () => {
    expect(suggestedEventLine(TRITON, 'en-GB')).toBe(
      'Looks like “Triton next steps!” · 07:30–08:30 · Google Meet'
    );
  });
  test('an invite with no end shows one time', () => {
    expect(occurrenceTimeRange({ startIso: TRITON.startIso, endIso: null }, 'en-GB')).toBe('07:30');
  });
  test('a nameless occurrence still reads as a sentence', () => {
    expect(suggestedEventLine({ ...TRITON, title: null, provider: null }, 'en-GB')).toBe(
      'Looks like “a meeting on your calendar” · 07:30–08:30'
    );
  });
  test('products have human names; anything else has none', () => {
    expect(providerLabel('teams')).toBe('Microsoft Teams');
    expect(providerLabel('browser')).toBe(null);
    expect(providerLabel(null)).toBe(null);
  });
});

describe('the tooltip names BOTH halves', () => {
  test('a Slack call against a Meet invite says so', () => {
    const why = suggestedEventWhy(TRITON);
    expect(why).toContain('overlap 100%');
    expect(why).toContain('title match 0%');
    expect(why).toContain('This recording is a Slack call and that invite is Google Meet');
    expect(why).toContain('Nothing is linked or shared until you say so.');
  });
  test('same product → no warning', () => {
    expect(suggestedEventWhy({ ...TRITON, callKind: 'meet' })).not.toContain('check before linking');
  });
});

describe('D6 — no video', () => {
  test('a Slack call says why it is audio only', () => {
    expect(noVideoNote({ app: 'Slack', kind: 'slack' })).toBe(
      'This recording has no video — the recorder captured audio only, during a Slack call; screen shares in Slack are not captured yet.'
    );
  });
  test('another app is named', () => {
    expect(noVideoNote({ app: 'Microsoft Teams', kind: 'teams' })).toBe(
      'This recording has no video — the recorder captured audio only, during a Microsoft Teams call.'
    );
  });
  test('an unknown call still explains itself', () => {
    expect(noVideoNote(null)).toBe('This recording has no video — the recorder captured audio only.');
  });
});
