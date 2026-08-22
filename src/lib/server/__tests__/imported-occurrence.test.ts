import { describe, expect, test } from 'bun:test';
import { importedOccurrenceMatches, type ImportedCandidate } from '@/lib/imported-occurrence';
import { recordMatchesOccurrence } from '@/lib/meeting-evidence';

const base: ImportedCandidate = {
  meeting_code: 'abc-defg-hij',
  join_web_url: null,
  event_id: 'ev1',
  video_file_id: 'vid1',
  drive_file_id: null,
  transcript_doc_id: 'doc1',
  teams_call_id: null,
  occurrence_start: '2026-08-21T06:00:00Z',
};

describe('importedOccurrenceMatches (Phase 3 — THE already-imported rule)', () => {
  test('meeting code + start within ±12h matches', () => {
    expect(
      importedOccurrenceMatches(base, { meetingCode: 'abc-defg-hij', startTime: '2026-08-21T11:30:00+05:30' })
    ).toBe(true);
  });
  test('meeting code + start a week apart does NOT match (recurring series reuse codes)', () => {
    expect(
      importedOccurrenceMatches(base, { meetingCode: 'abc-defg-hij', startTime: '2026-08-28T06:00:00Z' })
    ).toBe(false);
  });
  test('meeting code without startTime matches any occurrence (pasted link)', () => {
    expect(importedOccurrenceMatches(base, { meetingCode: 'abc-defg-hij' })).toBe(true);
  });
  test('eventId matches regardless of time (uploads link by eventId — D9)', () => {
    expect(importedOccurrenceMatches(base, { eventId: 'ev1', startTime: '2027-01-01T00:00:00Z' })).toBe(true);
    expect(importedOccurrenceMatches(base, { eventId: 'ev2' })).toBe(false);
  });
  test('video file id matches either stored column', () => {
    expect(importedOccurrenceMatches(base, { videoFileId: 'vid1' })).toBe(true);
    expect(importedOccurrenceMatches({ ...base, video_file_id: null, drive_file_id: 'vid1' }, { videoFileId: 'vid1' })).toBe(true);
  });
  test('transcript doc / teams callId are strong ids', () => {
    expect(importedOccurrenceMatches(base, { transcriptDocId: 'doc1' })).toBe(true);
    expect(importedOccurrenceMatches({ ...base, teams_call_id: 'call9' }, { teamsCallId: 'call9' })).toBe(true);
  });
  test('teams join URL + window', () => {
    const c = { ...base, meeting_code: null, join_web_url: 'https://teams.microsoft.com/l/meetup-join/x' };
    expect(importedOccurrenceMatches(c, { joinWebUrl: c.join_web_url, startTime: '2026-08-21T07:00:00Z' })).toBe(true);
    expect(importedOccurrenceMatches(c, { joinWebUrl: c.join_web_url, startTime: '2026-08-23T07:00:00Z' })).toBe(false);
  });
  test('unparseable query startTime falls back to code-only (never hides a dupe)', () => {
    expect(importedOccurrenceMatches(base, { meetingCode: 'abc-defg-hij', startTime: 'garbage' })).toBe(true);
  });
  test('candidate with unknown occurrence start never matches a timed code query', () => {
    expect(
      importedOccurrenceMatches({ ...base, occurrence_start: null }, { meetingCode: 'abc-defg-hij', startTime: '2026-08-21T06:00:00Z' })
    ).toBe(false);
  });
});

describe('recordMatchesOccurrence (D6 — ONE record-lookup window)', () => {
  test('record 5h before / 11h after the event start is the occurrence', () => {
    expect(recordMatchesOccurrence('2026-08-21T01:00:00Z', '2026-08-21T06:00:00Z')).toBe(true);
    expect(recordMatchesOccurrence('2026-08-21T17:00:00Z', '2026-08-21T06:00:00Z')).toBe(true);
  });
  test('record 7h before / 13h after is not', () => {
    expect(recordMatchesOccurrence('2026-08-20T23:00:00Z', '2026-08-21T06:00:00Z')).toBe(false);
    expect(recordMatchesOccurrence('2026-08-21T19:00:00Z', '2026-08-21T06:00:00Z')).toBe(false);
  });
  test('missing sides never match', () => {
    expect(recordMatchesOccurrence(null, '2026-08-21T06:00:00Z')).toBe(false);
    expect(recordMatchesOccurrence('2026-08-21T06:00:00Z', undefined)).toBe(false);
  });
});
