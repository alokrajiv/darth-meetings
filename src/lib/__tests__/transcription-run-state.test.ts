import { describe, expect, test } from 'bun:test';
import { decideRunPoll, runWaitedTooLong } from '@/lib/transcription-run-state';
import { AAI_GONE_REASON, AAI_STUCK_HOURS, AAI_STUCK_REASON } from '@/lib/aai-job-state';

/**
 * The poller's decision table (Phase 2). The property that matters in every
 * row of it: only 'activate' ever touches the MEETING — every other answer is
 * about the transcription alone.
 */

const STARTED = '2026-09-22T00:00:00.000Z';
const ms = (h: number) => Date.parse(STARTED) + h * 3600_000;

describe('decideRunPoll', () => {
  test('still queued or processing → wait', () => {
    for (const outcome of ['queued', 'processing'] as const) {
      expect(decideRunPoll({ outcome, startedAt: STARTED, now: ms(1) })).toEqual({ kind: 'wait' });
    }
  });

  test('completed → activate', () => {
    expect(decideRunPoll({ outcome: 'completed', startedAt: STARTED, now: ms(1) })).toEqual({
      kind: 'activate',
    });
  });

  test('a 404 is terminal immediately (DEC-4: AAI keeps nothing of ours)', () => {
    expect(decideRunPoll({ outcome: 'not-found', startedAt: STARTED, now: ms(0.01) })).toEqual({
      kind: 'fail',
      reason: AAI_GONE_REASON,
    });
  });

  test('AssemblyAI’s own error is quoted back', () => {
    expect(
      decideRunPoll({
        outcome: 'error',
        error: '  Audio file could not be decoded  ',
        startedAt: STARTED,
        now: ms(0.5),
      })
    ).toEqual({ kind: 'fail', reason: 'AssemblyAI could not transcribe this: Audio file could not be decoded' });
  });

  test('an error with no message still says something', () => {
    const d = decideRunPoll({ outcome: 'error', error: null, startedAt: STARTED, now: ms(0.5) });
    expect(d).toEqual({ kind: 'fail', reason: 'AssemblyAI could not transcribe this.' });
  });

  test('unreachable is a blip, not an answer', () => {
    expect(decideRunPoll({ outcome: 'unreachable', startedAt: STARTED, now: ms(1) })).toEqual({
      kind: 'wait',
    });
  });

  test(`past ${AAI_STUCK_HOURS} h we give up — whether AAI is silent or unreachable`, () => {
    for (const outcome of ['processing', 'queued', 'unreachable'] as const) {
      expect(decideRunPoll({ outcome, startedAt: STARTED, now: ms(7) })).toEqual({
        kind: 'fail',
        reason: AAI_STUCK_REASON,
      });
    }
  });

  test('a completed answer wins even after six hours', () => {
    expect(decideRunPoll({ outcome: 'completed', startedAt: STARTED, now: ms(99) })).toEqual({
      kind: 'activate',
    });
  });

  test('without a start time we never give up (an age we do not have is not an age)', () => {
    expect(decideRunPoll({ outcome: 'processing', startedAt: null, now: ms(99) })).toEqual({
      kind: 'wait',
    });
    expect(runWaitedTooLong('not a date', ms(99))).toBe(false);
  });

  test('the boundary is exclusive', () => {
    expect(runWaitedTooLong(STARTED, ms(AAI_STUCK_HOURS))).toBe(false);
    expect(runWaitedTooLong(STARTED, ms(AAI_STUCK_HOURS) + 1)).toBe(true);
  });
});
