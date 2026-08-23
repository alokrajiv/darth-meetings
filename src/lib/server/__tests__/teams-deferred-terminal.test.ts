import { describe, expect, test } from 'bun:test';
import {
  TEAMS_NEVER_RECORDED_ERROR,
  isTeamsOccurrenceStale,
  teamsDeferredTerminalError,
  teamsOccurrenceEndMs,
} from '@/lib/teams-deferred-terminal';

const H = 3600_000;
const NOW = Date.parse('2026-08-23T10:00:00Z');

describe('teamsOccurrenceEndMs', () => {
  test('prefers the calendar end', () => {
    expect(teamsOccurrenceEndMs('2026-08-17T07:30:00Z', '2026-08-17T08:30:00Z')).toBe(
      Date.parse('2026-08-17T08:30:00Z')
    );
  });
  test('falls back to start + 1h', () => {
    expect(teamsOccurrenceEndMs('2026-08-17T07:30:00Z', null)).toBe(
      Date.parse('2026-08-17T08:30:00Z')
    );
  });
  test('unknown when neither parses', () => {
    expect(teamsOccurrenceEndMs(null, undefined)).toBeNull();
    expect(teamsOccurrenceEndMs('garbage', 'also')).toBeNull();
  });
});

describe('isTeamsOccurrenceStale', () => {
  test('ended 6 days ago → stale', () => {
    expect(
      isTeamsOccurrenceStale(
        { startTime: '2026-08-17T07:30:00Z', endTime: '2026-08-17T08:30:00Z' },
        NOW
      )
    ).toBe(true);
  });
  test('ended 23h ago → not stale (artifacts may still land)', () => {
    const end = new Date(NOW - 23 * H).toISOString();
    expect(isTeamsOccurrenceStale({ startTime: null, endTime: end }, NOW)).toBe(false);
  });
  test('ended 25h ago → stale', () => {
    const end = new Date(NOW - 25 * H).toISOString();
    expect(isTeamsOccurrenceStale({ endTime: end }, NOW)).toBe(true);
  });
  test('no end: start + 1h rule (started 24.5h ago → 23.5h since end → fresh)', () => {
    const start = new Date(NOW - 24.5 * H).toISOString();
    expect(isTeamsOccurrenceStale({ startTime: start }, NOW)).toBe(false);
  });
  test('unknown times are never stale', () => {
    expect(isTeamsOccurrenceStale({}, NOW)).toBe(false);
  });
});

describe('teamsDeferredTerminalError', () => {
  const lp17 = { startTime: '2026-08-17T07:30:00Z', endTime: '2026-08-17T08:30:00Z' };
  test('row 444 shape: stale + nothing listed → never-recorded terminal', () => {
    expect(
      teamsDeferredTerminalError(
        { ...lp17, transcriptListed: false, recordingListed: false },
        NOW
      )
    ).toBe(TEAMS_NEVER_RECORDED_ERROR);
  });
  test('anything listed → keep waiting even when stale', () => {
    expect(
      teamsDeferredTerminalError({ ...lp17, transcriptListed: true, recordingListed: false }, NOW)
    ).toBeNull();
    expect(
      teamsDeferredTerminalError({ ...lp17, transcriptListed: false, recordingListed: true }, NOW)
    ).toBeNull();
  });
  test('fresh call with nothing listed → keep waiting', () => {
    const end = new Date(NOW - 2 * H).toISOString();
    expect(
      teamsDeferredTerminalError(
        { startTime: null, endTime: end, transcriptListed: false, recordingListed: false },
        NOW
      )
    ).toBeNull();
  });
});
