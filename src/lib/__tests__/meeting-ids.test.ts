import { describe, expect, test } from 'bun:test';
import {
  bareMeetingId,
  isPlaceholderId,
  newMeetingId,
  promotedMeetingId,
} from '@/lib/meeting-ids';

/**
 * Phase 1b's one identity rule: what a promoted placeholder is called
 * afterwards. Everything downstream — the media file name, the `/m/` repoint,
 * whether the recording graph migrates — follows from this function, so its
 * truth table is the thing to guard.
 */

const UUID = '12121212-1212-4121-8121-121212121212';
const JOB = '9137f1c7-6979-4f38-a711-e1ecf343c6a9';

describe('placeholders', () => {
  test('only up- and defer- are placeholders', () => {
    expect(isPlaceholderId(`up-${UUID}`)).toBe(true);
    expect(isPlaceholderId(`defer-${UUID}`)).toBe(true);
    for (const id of [UUID, JOB, `ext-${UUID}`, 'gmeet-abc', 'teams-19:x', '']) {
      expect(isPlaceholderId(id)).toBe(false);
    }
  });

  test('the bare id is the placeholder without its prefix', () => {
    expect(bareMeetingId(`up-${UUID}`)).toBe(UUID);
    expect(bareMeetingId(`defer-${UUID}`)).toBe(UUID);
    // Only the leading prefix goes, and only once.
    expect(bareMeetingId(`up-up-${UUID}`)).toBe(`up-${UUID}`);
    expect(bareMeetingId(UUID)).toBe(UUID);
  });
});

describe('promotedMeetingId', () => {
  test('minting off is today: the placeholder takes the AssemblyAI job id', () => {
    expect(promotedMeetingId(`up-${UUID}`, JOB, false)).toBe(JOB);
    expect(promotedMeetingId(`defer-${UUID}`, JOB, false)).toBe(JOB);
  });

  test('minting on: the placeholder keeps its own uuid, bare', () => {
    expect(promotedMeetingId(`up-${UUID}`, JOB, true)).toBe(UUID);
    expect(promotedMeetingId(`defer-${UUID}`, JOB, true)).toBe(UUID);
  });

  test('a row that is NOT a placeholder keeps its id, whatever the flag says', () => {
    // A minted row re-sent by Retry: a SECOND job on the SAME meeting.
    expect(promotedMeetingId(UUID, JOB, true)).toBe(UUID);
    expect(promotedMeetingId(UUID, JOB, false)).toBe(UUID);
    // A legacy row the sweeper gave up on, re-sent: renaming it would break
    // its links a second time, and rolling the flag back must never re-point
    // a minted row at a job id.
    const OLD_JOB = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    expect(promotedMeetingId(OLD_JOB, JOB, false)).toBe(OLD_JOB);
    expect(promotedMeetingId(OLD_JOB, JOB, true)).toBe(OLD_JOB);
  });
});

describe('newMeetingId — the no-placeholder insert', () => {
  test('minting off hands the row the job id, as today', () => {
    expect(newMeetingId(JOB, false)).toBe(JOB);
  });

  test('minting on gives a fresh uuid that is not the job', () => {
    const a = newMeetingId(JOB, true);
    const b = newMeetingId(JOB, true);
    expect(a).not.toBe(JOB);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
