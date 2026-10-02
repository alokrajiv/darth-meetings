import { describe, expect, test } from 'bun:test';
import {
  AAI_STUCK_HOURS,
  AAI_STUCK_REASON,
  aaiJobIdOf,
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

describe('aaiJobIdOf — which job to ask AssemblyAI about (Phase 1b)', () => {
  const MINTED = '1234abcd-5678-4901-8abc-def012345678'; // a meeting id we minted

  test('the column wins whenever it is set', () => {
    expect(aaiJobIdOf({ assemblyai_id: MINTED, aai_job_id: JOB })).toBe(JOB);
    // Retry put a SECOND job on a meeting that is still called by the FIRST.
    expect(aaiJobIdOf({ assemblyai_id: JOB, aai_job_id: MINTED })).toBe(MINTED);
  });

  test('a row read WITHOUT the column (not projected / 045 missing) falls back to its own id — if it is one', () => {
    expect(aaiJobIdOf({ assemblyai_id: JOB })).toBe(JOB);
    expect(aaiJobIdOf({ assemblyai_id: JOB.toUpperCase() })).toBe(JOB.toUpperCase());
  });

  test('a NULL read from the column is final — never repaired from the meeting id', () => {
    // 045 stamped every legacy row (`SET aai_job_id = assemblyai_id`), so a
    // UUID-shaped meeting id beside a NULL job is one we minted.
    expect(aaiJobIdOf({ assemblyai_id: JOB, aai_job_id: null })).toBeNull();
    expect(aaiJobIdOf({ assemblyai_id: MINTED, aai_job_id: null })).toBeNull();
  });

  test('prod 2026-10-02: a meeting MADE EARLY from a recording has no job, whatever the projection', () => {
    // transcripts 1054: Link to meeting while the recording was transcribing —
    // status processing, minted UUID id, aai_job_id NULL, fromRecording set.
    // The listing asked AssemblyAI about the minted id, got a 404 and flipped
    // the meeting to 'error' before its text landed.
    const madeEarly = {
      assemblyai_id: '2bd949dd-c829-4cdd-a2b6-d2a86b2eefd5',
      gmeet_context: { fromRecording: { recordingId: '02af969f-ee5e-4c82-879f-5d971e568e6c', how: 'link' } },
    };
    expect(aaiJobIdOf({ ...madeEarly, aai_job_id: null })).toBeNull();
    expect(aaiJobIdOf(madeEarly)).toBeNull(); // even with the column absent from the projection
    expect(aaiJobIdOf({ assemblyai_id: MINTED, gmeet_context: { splitFrom: { assemblyaiId: JOB } } })).toBeNull();
    // Once its text lands the settle writes the RECORDING's job — that one counts.
    expect(aaiJobIdOf({ ...madeEarly, aai_job_id: JOB })).toBe(JOB);
    expect(
      waitingOnAai({ assemblyaiId: madeEarly.assemblyai_id, aaiJobId: null, status: 'processing' })
    ).toBe(false);
    expect(
      stuckAtAai(
        { assemblyaiId: madeEarly.assemblyai_id, aaiJobId: null, status: 'processing', waitingSince: ago(48) },
        NOW
      )
    ).toBe(false);
  });

  test('a row that never went to AssemblyAI has no job', () => {
    for (const id of [`up-${JOB}`, `defer-${JOB}`, `ext-${JOB}`, 'gmeet-abc', 'teams-19:x', '']) {
      expect(aaiJobIdOf({ assemblyai_id: id })).toBeNull();
      expect(aaiJobIdOf({ assemblyai_id: id, aai_job_id: null })).toBeNull();
    }
  });

  test('a minted meeting id is NEVER mistaken for a job', () => {
    // The whole point of 1b: UUID-shaped no longer means "AssemblyAI knows it".
    // A minted row that went to AssemblyAI carries its job in the column; one
    // that did not (made early from a recording, split off) carries NULL, and
    // NULL is final (minting is forced off while the column is missing).
    expect(aaiJobIdOf({ assemblyai_id: MINTED, aai_job_id: JOB })).not.toBe(MINTED);
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

  test('a minted meeting id waits on the JOB in its column, not on itself', () => {
    const minted = '1234abcd-5678-4901-8abc-def012345678';
    expect(waitingOnAai({ assemblyaiId: minted, aaiJobId: JOB, status: 'processing' })).toBe(true);
    // A `gmeet-`/`teams-` row with no job never waits, whatever its status.
    expect(waitingOnAai({ assemblyaiId: 'gmeet-abc', aaiJobId: null, status: 'processing' })).toBe(
      false
    );
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
