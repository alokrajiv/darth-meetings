import type { MeetTranscriptEntry, MeetUtterance } from '@/lib/format';

/**
 * Build display utterances from structured transcript entries (Meet API
 * entries or Teams VTT cues — both map to `MeetTranscriptEntry`). Consecutive
 * same-speaker entries with small gaps are merged so the transcript reads as
 * turns, not sentences.
 *
 * Lives outside `server/` so unit tests can import it without tripping the
 * `server-only` guard; `gmeet.ts` re-exports it for its existing callers.
 */
export function utterancesFromEntries(entries: MeetTranscriptEntry[]): MeetUtterance[] {
  const out: MeetUtterance[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.speaker === e.speaker &&
      e.start - prev.end <= 2000 &&
      prev.text.length < 600
    ) {
      prev.text += ` ${e.text}`;
      prev.end = e.end;
    } else {
      out.push({ speaker: e.speaker, text: e.text, start: e.start, end: e.end });
    }
  }
  return out;
}
