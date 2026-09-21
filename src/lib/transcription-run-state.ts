/**
 * What one poll of a running re-transcription means (Phase 2,
 * docs/recordings-phase2-spec.md Flow 3) — the decision table, pure.
 *
 * The rule the whole phase rests on: **the MEETING is never touched until a
 * new version is ready to take over.** Every unhappy answer here therefore
 * ends in `fail`, which marks the TRANSCRIPTION and clears the marker and
 * does nothing else. Only `activate` moves the meeting.
 *
 * The clock is passed in, never read, so the six-hour give-up is testable.
 */

import { AAI_GONE_REASON, AAI_STUCK_MS, AAI_STUCK_REASON } from '@/lib/aai-job-state';

export interface RunPollObservation {
  /** What AssemblyAI answered, or 'not-found' / 'unreachable' when it did not. */
  outcome: 'queued' | 'processing' | 'completed' | 'error' | 'not-found' | 'unreachable';
  /** AssemblyAI's own message, when `outcome` is 'error'. */
  error?: string | null;
  /** When the run was started, ISO. Null = unknown, and then we never give up. */
  startedAt: string | null;
  now: number;
}

export type RunPollDecision =
  /** Nothing to do; ask again next tick. */
  | { kind: 'wait' }
  /** Store the payload and make this version live. */
  | { kind: 'activate' }
  /** Mark the version failed with this reason; the meeting stays as it is. */
  | { kind: 'fail'; reason: string };

/** Has the run been waiting longer than a job is ever allowed to? */
export function runWaitedTooLong(startedAt: string | null, now: number): boolean {
  if (!startedAt) return false;
  const since = Date.parse(startedAt);
  return Number.isFinite(since) && now - since > AAI_STUCK_MS;
}

export function decideRunPoll(obs: RunPollObservation): RunPollDecision {
  switch (obs.outcome) {
    // Terminal under DEC-4: AssemblyAI keeps nothing of ours, so "I do not
    // have that job" cannot improve by asking again.
    case 'not-found':
      return { kind: 'fail', reason: AAI_GONE_REASON };
    case 'completed':
      return { kind: 'activate' };
    case 'error': {
      const why = obs.error?.trim();
      return {
        kind: 'fail',
        reason: why
          ? `AssemblyAI could not transcribe this: ${why}`
          : 'AssemblyAI could not transcribe this.',
      };
    }
    // A blip (5xx, network, auth) is not an answer — unless the run has been
    // going long enough that no answer is ever coming.
    case 'unreachable':
    case 'queued':
    case 'processing':
      return runWaitedTooLong(obs.startedAt, obs.now)
        ? { kind: 'fail', reason: AAI_STUCK_REASON }
        : { kind: 'wait' };
  }
}
