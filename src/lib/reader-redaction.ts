import type { GmeetContext } from '@/lib/format';

/**
 * What a READ-ONLY sharer of a meeting must not be told (P3, finding F4 of
 * docs/recordings-meetings-series-design.md).
 *
 * Only meetings are shared; recordings never are. A share therefore says
 * "read this meeting" — it does not say "see what the owner's calendar
 * looks like" or "see what app the owner takes their calls in". Two keys on
 * `gmeet_context` say exactly that:
 *
 *  - `suggestedEvent` — an occurrence out of the OWNER's calendar (title,
 *    time, meeting code, the matcher's numbers), parked on the row because
 *    a matcher thought this recording might be it. A reader can neither
 *    link nor dismiss it, and it is not a fact about this meeting; it is a
 *    guess about somebody else's diary. The listing has gated it to
 *    owner/edit since D2 (db-ops/transcripts, `CASE WHEN b.__access IN
 *    ('owner','edit')`) and the page hides the strip for readers — the
 *    detail payload did not, so `darth-cli meetings get` printed
 *    "suggested event:" to anyone with read access.
 *
 *  - `recorder.app` / `recorder.kind` — what the tray saw the owner doing,
 *    frozen at upload open ("Slack", a DM window). The page spends them on
 *    one sentence ("no video, during a Slack call"); a reader loses that
 *    sentence and learns nothing about how the owner takes their calls.
 *
 * `recorder.recordingId` stays. A recording IS reachable through a meeting
 * that holds a clip on it, and a share is precisely that reachability —
 * rule 3, and the header of migration 044.
 *
 * Owner and editor payloads are returned untouched (the object is returned
 * by identity, so nothing downstream can tell a redaction happened when
 * none did).
 */
export function redactForReader<T extends { gmeet_context: GmeetContext | null; access: string }>(
  row: T
): T {
  if (row.access !== 'read') return row;
  const ctx = row.gmeet_context;
  if (!ctx) return row;
  const { suggestedEvent: _guess, recorder, ...rest } = ctx;
  void _guess;
  return {
    ...row,
    gmeet_context: {
      ...rest,
      ...(recorder ? { recorder: { recordingId: recorder.recordingId } } : {}),
    },
  };
}
