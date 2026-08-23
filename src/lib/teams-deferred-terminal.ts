// Pure rule: when is a DEFERRED Teams import hopeless? Isomorphic (no fetch,
// no DB) so the deferred-import poller, the import core (refuse to queue) and
// tests share it.
//
// Teams recap artifacts lag the call end by minutes, occasionally an hour.
// Once the occurrence ended more than STALE_AFTER_MS ago and Graph lists NO
// transcript AND NO recording for its window, nothing is coming — the call
// was not recorded. Before that, or while anything at all is listed (a
// transcript with the recording still processing), keep waiting.

export const TEAMS_STALE_AFTER_MS = 24 * 3600 * 1000;
/** Calendar end unknown → assume a one-hour call. */
export const TEAMS_DEFAULT_DURATION_MS = 3600 * 1000;

export const TEAMS_NEVER_RECORDED_ERROR =
  'No recording or transcript at Microsoft for this call — it was probably not recorded.';

/** The occurrence's end instant (ms) from the frozen calendar times:
 * `endTime`, else `startTime + 1h`, else null when neither parses. */
export function teamsOccurrenceEndMs(
  startTime: string | null | undefined,
  endTime: string | null | undefined
): number | null {
  const end = endTime ? Date.parse(endTime) : NaN;
  if (!Number.isNaN(end)) return end;
  const start = startTime ? Date.parse(startTime) : NaN;
  if (!Number.isNaN(start)) return start + TEAMS_DEFAULT_DURATION_MS;
  return null;
}

/** True when the occurrence ended more than TEAMS_STALE_AFTER_MS before `now`.
 * Unknown times are never stale (we can't prove anything). */
export function isTeamsOccurrenceStale(
  times: { startTime?: string | null; endTime?: string | null },
  now: number = Date.now()
): boolean {
  const end = teamsOccurrenceEndMs(times.startTime, times.endTime);
  return end !== null && now - end > TEAMS_STALE_AFTER_MS;
}

/**
 * Terminal verdict for a Teams occurrence the import needs artifacts for:
 * stale AND Graph listed neither a transcript nor a recording in its window
 * → `TEAMS_NEVER_RECORDED_ERROR`; otherwise null (keep waiting / retry).
 */
export function teamsDeferredTerminalError(
  input: {
    startTime?: string | null;
    endTime?: string | null;
    transcriptListed: boolean;
    recordingListed: boolean;
  },
  now: number = Date.now()
): string | null {
  if (input.transcriptListed || input.recordingListed) return null;
  return isTeamsOccurrenceStale(input, now) ? TEAMS_NEVER_RECORDED_ERROR : null;
}
