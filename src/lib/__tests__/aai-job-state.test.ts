import { describe, expect, test } from 'bun:test';
import {
  AAI_STUCK_HOURS,
  AAI_STUCK_REASON,
  awaitingAai,
  isAaiJobId,
  stuckAtAai,
  waitingOnAai,
} from '@/lib/aai-job-state';

const NOW = Date.parse('2026-09-21T15:00:00Z');
const H = 3600_000;
const JOB = '9137f1c7-6979-4f38-a711-e1ecf343c6a9'; // prod row 770
const ago = (hours: number) => new Date(NOW - hours * H).toISOString();
/** One millisecond past the window — the first instant that counts as stuck. */
const JUST_OVER = AAI_STUCK_HOURS * H + 1;

describe('isAaiJobId — only a real AAI job is AAI’s problem', () => {
  test('a plain UUID is a job id, in either case', () => {
    expect(isAaiJobId(JOB)).toBe(true);
    expect(isAaiJobId(JOB.toUpperCase())).toBe(true);
  });

  test('every id we mint ourselves is not', () => {
    for (const id of [
      `up-${JOB}`,
      `defer-${JOB}`,
      `ext-${JOB}`,
      'gmeet-abc-def',
      'teams-19:meeting_abc',
      '',
      `${JOB} `,
    ]) {
      expect(isAaiJobId(id)).toBe(false);
    }
  });
});

describe('awaitingAai / waitingOnAai', () => {
  test('only queued and processing mean AssemblyAI owes us an answer', () => {
    expect(awaitingAai('queued')).toBe(true);
    expect(awaitingAai('processing')).toBe(true);
    for (const s of ['completed', 'error', 'uploading', 'waiting', '']) {
      expect(awaitingAai(s)).toBe(false);
    }
  });

  test('a pending status on OUR OWN placeholder is not waiting on AAI', () => {
    // `ext-…` text imports sit in 'processing' while the LLM normalises them.
    expect(waitingOnAai({ assemblyaiId: `ext-${JOB}`, status: 'processing' })).toBe(false);
    expect(waitingOnAai({ assemblyaiId: `up-${JOB}`, status: 'processing' })).toBe(false);
    expect(waitingOnAai({ assemblyaiId: JOB, status: 'processing' })).toBe(true);
  });
});

describe('stuckAtAai — the give-up rule', () => {
  const row = (over: Partial<Parameters<typeof stuckAtAai>[0]> = {}) => ({
    assemblyaiId: JOB,
    status: 'processing',
    waitingSince: ago(AAI_STUCK_HOURS + 1),
    ...over,
  });

  test('the 19 prod rows stuck since 2026-09-15 are caught', () => {
    expect(stuckAtAai(row({ waitingSince: '2026-09-15T08:00:20.711Z' }), NOW)).toBe(true);
  });

  test('a job still inside the window is left alone', () => {
    // prod row 922 — 4.1 h old at the time of the check.
    expect(stuckAtAai(row({ waitingSince: ago(4.1) }), NOW)).toBe(false);
  });

  test('the boundary is exclusive — exactly 6 h is not yet stuck', () => {
    expect(stuckAtAai(row({ waitingSince: ago(AAI_STUCK_HOURS) }), NOW)).toBe(false);
    expect(stuckAtAai(row({ waitingSince: new Date(NOW - JUST_OVER) }), NOW)).toBe(true);
  });

  test('rows waiting in OUR pipeline are never given up on, however old', () => {
    const old = ago(1000);
    expect(stuckAtAai(row({ status: 'uploading', waitingSince: old }), NOW)).toBe(false);
    expect(stuckAtAai(row({ status: 'waiting', waitingSince: old }), NOW)).toBe(false);
    expect(stuckAtAai(row({ assemblyaiId: `defer-${JOB}`, waitingSince: old }), NOW)).toBe(false);
    expect(stuckAtAai(row({ assemblyaiId: `ext-${JOB}`, waitingSince: old }), NOW)).toBe(false);
    expect(stuckAtAai(row({ assemblyaiId: `up-${JOB}`, waitingSince: old }), NOW)).toBe(false);
  });

  test('terminal rows are never re-flipped', () => {
    const old = ago(1000);
    expect(stuckAtAai(row({ status: 'completed', waitingSince: old }), NOW)).toBe(false);
    expect(stuckAtAai(row({ status: 'error', waitingSince: old }), NOW)).toBe(false);
  });

  test('no usable age → never give up', () => {
    expect(stuckAtAai(row({ waitingSince: null }), NOW)).toBe(false);
    expect(stuckAtAai(row({ waitingSince: 'not a date' }), NOW)).toBe(false);
  });

  test('a Date is accepted as well as an ISO string', () => {
    expect(stuckAtAai(row({ waitingSince: new Date(NOW - 7 * H) }), NOW)).toBe(true);
  });
});

describe('AAI_STUCK_REASON', () => {
  test('is the copy the row carries, with the window spelled out', () => {
    expect(AAI_STUCK_REASON).toBe(
      'Stuck at AssemblyAI for over 6 hours — gave up. Retry re-sends the stored recording.'
    );
  });
});
