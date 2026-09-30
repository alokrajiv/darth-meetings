/**
 * The matcher's two D3 rules (docs/recorder-link-confirm-spec.md), with the
 * numbers of the incident that produced them.
 *
 * 2026-09-22, row 935: a Slack DM huddle (`call.kind = "slack"`, title
 * "Swaralee (DM) - Slack", 15:48:48–15:56 SGT) was matched to the Google Meet
 * invite "Triton next steps!" (15:30–16:30 SGT, code `bgs-zqvv-dby`) at
 * score 0.7 — time overlap 1 × 0.7 + title 0 × 0.3 — which cleared the
 * old confidence bar of 0.6 and auto-linked, auto-sharing a private call with
 * 8 people. Two rules now stand in the way:
 *
 *   1. a KNOWN product mismatch (slack call vs meet invite) caps the
 *      candidate at PROVIDER_MISMATCH_CAP and can never be confident;
 *   2. time overlap ALONE is never confidence — the titles must agree at all,
 *      or the two must at least be the same product.
 *
 * `scoreOccurrences` is the pure half of `matchRecording` (no database), and
 * `recorderMatchIsConfident` is the one confidence definition every client
 * inherits. D1's birth title (`recorderCallTitle`) is here too: it is what an
 * unlinked recording is named instead of the event's title.
 */
import { describe, expect, mock, test } from 'bun:test';
import { callProvider, recorderCallTitle } from '@/lib/recorder';
import type { CalendarOverlapRow } from '@/db-ops/calendar-event-cache';

mock.module('server-only', () => ({}));

const { occurrenceProvider, scoreOccurrences, PROVIDER_MISMATCH_CAP, suggestedEventFromMatch } = await import(
  '@/lib/server/recorder-match'
);
const { recorderMatchIsConfident } = await import('@/lib/server/upload-pipeline');

// --- The incident, to the minute (SGT +08:00). ---
const CALL_START = Date.parse('2026-09-22T15:48:48+08:00');
const CALL_END = Date.parse('2026-09-22T15:56:48+08:00');
const SLACK_CALL = {
  app: 'Slack',
  bundle_id: 'com.tinyspeck.slackmacgap',
  kind: 'slack',
  title: 'Swaralee (DM) - Slack',
};

function occ(over: Partial<CalendarOverlapRow> = {}): CalendarOverlapRow {
  return {
    event_key: 'ev-triton|2026-09-22T07:30:00.000Z',
    event_id: 'ev-triton',
    title: 'Triton next steps!',
    event_start: '2026-09-22T07:30:00.000Z', // 15:30 SGT
    event_end: '2026-09-22T08:30:00.000Z', // 16:30 SGT
    meeting_code: 'bgs-zqvv-dby',
    conference_hint: 'https://meet.google.com/bgs-zqvv-dby',
    ...over,
  };
}

const score = (rows: CalendarOverlapRow[], call: Record<string, unknown> | null = SLACK_CALL) =>
  scoreOccurrences({ startMs: CALL_START, endMs: CALL_END, call }, rows, '2026-09-22T07:56:48.000Z');

describe('occurrenceProvider — the invite has no provider column, so it is derived', () => {
  test('a Google Meet code', () => {
    expect(occurrenceProvider({ meeting_code: 'bgs-zqvv-dby', conference_hint: null })).toBe('meet');
  });
  test('our synthetic Teams code, and a Teams join URL in the invite text', () => {
    expect(occurrenceProvider({ meeting_code: 'teams-abc', conference_hint: null })).toBe('teams');
    expect(
      occurrenceProvider({
        meeting_code: null,
        conference_hint: 'Join here https://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
      })
    ).toBe('teams');
  });
  test('Zoom and Webex', () => {
    expect(occurrenceProvider({ meeting_code: null, conference_hint: 'https://trames.zoom.us/j/1' })).toBe('zoom');
    expect(occurrenceProvider({ meeting_code: null, conference_hint: 'https://x.webex.com/meet/y' })).toBe('webex');
  });
  test('an invite that says nothing is unknown, and unknown vetoes nothing', () => {
    expect(occurrenceProvider({ meeting_code: null, conference_hint: 'Level 3, meeting room 2' })).toBe(null);
    expect(occurrenceProvider({ meeting_code: '', conference_hint: null })).toBe(null);
  });
});

describe('callProvider — the tray half', () => {
  test('known kinds', () => {
    expect(callProvider({ kind: 'slack' })).toBe('slack');
    expect(callProvider({ kind: 'Teams' })).toBe('teams');
  });
  test("'browser' and 'other' mean UNKNOWN, not 'something else'", () => {
    expect(callProvider({ kind: 'browser' })).toBe(null);
    expect(callProvider({ kind: 'other' })).toBe(null);
    expect(callProvider(null)).toBe(null);
  });
});

describe('D3 rule 1 — a provider mismatch caps the candidate', () => {
  test('the incident: a Slack huddle over a Meet invite is capped at 0.3, not 0.7', () => {
    const m = score([occ()]);
    expect(m).not.toBe(null);
    expect(m!.overlap).toBe(1); // the clocks really do overlap
    expect(m!.title_score).toBe(0);
    expect(m!.provider).toBe('meet');
    expect(m!.call_provider).toBe('slack');
    expect(m!.provider_mismatch).toBe(true);
    expect(m!.score).toBe(PROVIDER_MISMATCH_CAP);
    // …and nothing about it is confident any more.
    expect(recorderMatchIsConfident(m)).toBe(false);
  });

  test('a same-product candidate outranks the vetoed one even with less overlap', () => {
    const meetCall = { ...SLACK_CALL, app: 'Google Chrome', kind: 'meet', title: 'Meet - other call' };
    const m = score(
      [
        occ(),
        occ({
          event_key: 'ev-other|2026-09-22T07:50:00.000Z',
          event_id: 'ev-other',
          title: 'Something else',
          event_start: '2026-09-22T07:50:00.000Z',
          event_end: '2026-09-22T07:55:00.000Z',
          meeting_code: 'zzz-zzzz-zzz',
          conference_hint: 'https://meet.google.com/zzz-zzzz-zzz',
        }),
      ],
      meetCall
    );
    // Both are Meet now, so nothing is vetoed — the wider overlap wins.
    expect(m!.event_id).toBe('ev-triton');
    expect(m!.provider_mismatch).toBeUndefined();

    // With the Slack call, the Meet invites are both vetoed and capped…
    const slack = score([occ()]);
    expect(slack!.score).toBe(PROVIDER_MISMATCH_CAP);
    // …so a Slack-shaped occurrence (no product in the invite at all) with
    // the same overlap now outranks it.
    const mixed = score([
      occ(),
      occ({
        event_key: 'ev-noprov|2026-09-22T07:30:00.000Z',
        event_id: 'ev-noprov',
        title: 'Swaralee 1:1',
        meeting_code: null,
        conference_hint: 'Level 3',
      }),
    ]);
    expect(mixed!.event_id).toBe('ev-noprov');
    expect(mixed!.provider_mismatch).toBeUndefined();
  });

  test('an unknown call kind (browser/other) vetoes nothing — the old score stands', () => {
    const m = score([occ()], { ...SLACK_CALL, kind: 'browser' });
    expect(m!.score).toBe(0.7);
    expect(m!.provider_mismatch).toBeUndefined();
  });

  test('a vetoed candidate is still LISTED (the human may know better)', () => {
    const m = score([
      occ({
        event_key: 'ev-noprov|2026-09-22T07:30:00.000Z',
        event_id: 'ev-noprov',
        meeting_code: null,
        conference_hint: null,
      }),
      occ(),
    ]);
    expect(m!.event_id).toBe('ev-noprov');
    expect(m!.candidates.map((c) => c.event_id)).toContain('ev-triton');
    expect(m!.candidates[0]!.provider_mismatch).toBe(true);
  });
});

describe('D3 rule 2 — time overlap alone is never confidence', () => {
  const base = {
    event_key: 'k|2026-09-22T07:30:00.000Z',
    score: 0.7,
    overlap: 1,
    title_score: 0,
  };

  test('overlap 1 + title 0 is a suggestion, not a confident match', () => {
    expect(recorderMatchIsConfident(base)).toBe(false);
  });

  test('…the same numbers ARE confident when the products agree', () => {
    expect(recorderMatchIsConfident({ ...base, provider: 'meet', call_provider: 'meet' })).toBe(true);
  });

  test('…or when the titles agree at all', () => {
    expect(recorderMatchIsConfident({ ...base, title_score: 0.34 })).toBe(true);
  });

  test('agreeing titles do not rescue a product mismatch', () => {
    expect(
      recorderMatchIsConfident({ ...base, title_score: 1, score: 1, provider: 'meet', call_provider: 'slack' })
    ).toBe(false);
  });
});

describe('D1 — an unlinked recording is born with the CALL’s own name', () => {
  test('the app suffix comes off', () => {
    // A Slack window is titled after the DM/channel in VIEW, not the huddle
    // (2026-09-30: Ameya's huddle was born "radhika.rungta (DM)").
    expect(recorderCallTitle(SLACK_CALL)).toBe('Slack huddle');
    expect(recorderCallTitle({ ...SLACK_CALL, kind: 'browser' })).toBe('Swaralee (DM)');
    expect(recorderCallTitle({ title: 'MSC Contract review | Microsoft Teams' })).toBe(
      'MSC Contract review'
    );
    expect(recorderCallTitle({ title: 'Triton next steps! – Google Chrome' })).toBe(
      'Triton next steps!'
    );
  });

  test('Slack window chrome — workspace, unread counter, tag, emoji — comes off too (the two real titles of 2026-09-22)', () => {
    expect(
      recorderCallTitle({ app: 'Slack', title: 'Swaralee (DM) - Trames Pte Ltd - 1 new item - Slack [Main] 🏠🔊' })
    ).toBe('Swaralee (DM)');
    expect(
      recorderCallTitle({
        app: 'Slack',
        title: 'harshil, ivan, Swaralee, Umang (DM) - Trames Pte Ltd - 2 new items - Slack [Main] 🏠',
      })
    ).toBe('harshil, ivan, Swaralee, Umang (DM)');
    // a title that is nothing but chrome → null (caller falls back to the filename)
    expect(recorderCallTitle({ app: 'Slack', title: 'Trames Pte Ltd - 3 new items - Slack' })).toBeNull();
  });

  test('a hyphenated meeting name survives (only known app names are cut)', () => {
    expect(recorderCallTitle({ title: 'Alok <> Paola - weekly' })).toBe('Alok <> Paola - weekly');
  });

  test('nothing usable → null, so the caller falls back to the filename', () => {
    expect(recorderCallTitle({ title: '   ' })).toBe(null);
    expect(recorderCallTitle({ title: 'Slack', app: 'Slack' })).toBe(null);
    expect(recorderCallTitle(null)).toBe(null);
  });
});

describe('D2 — only a CONFIDENT match becomes a suggestion (17:03 SGT 2026-09-22)', () => {
  const incidentLike = {
    event_key: 'k|2026-09-22T16:30:00+08:00',
    event_id: 'ev',
    meeting_code: null,
    occ_start: '2026-09-22T08:30:00.000Z',
    occ_end: '2026-09-22T09:30:00.000Z',
    title: 'Hypercare - PGLS Trames Go Live Support OKI - Perawang',
    overlap: 1,
    title_score: 0.143,
    score: 0.3,
    provider: 'teams' as const,
    provider_mismatch: true as const,
    candidates: [],
    matched_at: '2026-09-22T08:58:50.000Z',
    call_provider: 'slack' as const,
  };
  test('a Slack DM call offered a Teams invite at 0.3 is NOT a suggestion', () => {
    expect(suggestedEventFromMatch(incidentLike, SLACK_CALL)).toBeNull();
  });
  test('time overlap alone (the 15:56 incident numbers) is NOT a suggestion either', () => {
    expect(
      suggestedEventFromMatch(
        { ...incidentLike, score: 0.7, title_score: 0, provider: 'meet', provider_mismatch: undefined },
        SLACK_CALL
      )
    ).toBeNull();
  });
  test('a confident match is', () => {
    const s = suggestedEventFromMatch(
      { ...incidentLike, score: 0.85, title_score: 0.5, provider: 'slack', provider_mismatch: undefined },
      SLACK_CALL
    );
    expect(s).not.toBeNull();
    expect(s!.title).toBe(incidentLike.title);
    expect(s!.callKind).toBe('slack');
  });
});
