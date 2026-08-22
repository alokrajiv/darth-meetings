import 'server-only';
import {
  findImportedOccurrences,
  type ImportedMeetingInfo,
} from '@/db-ops/imported-occurrences';

// Cross-user "did anyone already import this Teams meeting?" lookups —
// thin adapters over THE single lookup (db-ops/imported-occurrences,
// Phase 3). Identity facts live in gmeet_context->'teams' (indexed by
// migration 019).

/**
 * Which of these Teams meeting occurrences has ANYONE already imported?
 * Matched by canonical join URL + the shared ±12h occurrence window — the
 * identity available straight from the calendar event, before any Graph
 * call. Returns one entry per query, aligned by index (null = not imported).
 */
export async function findImportedByTeamsMeetings(
  queries: Array<{ joinWebUrl: string; startTime?: string | null }>,
  caller: { userId: string; email: string }
): Promise<(ImportedMeetingInfo | null)[]> {
  return findImportedOccurrences(
    queries.map((q) => ({ joinWebUrl: q.joinWebUrl, startTime: q.startTime ?? null })),
    caller
  );
}

/**
 * Exact-occurrence dedupe by Graph callId — used at import time, after
 * artifact resolution pinned the occurrence. Strongest identity there is:
 * transcript + recording of one occurrence share it, and it never repeats
 * across occurrences.
 */
export async function findImportedByTeamsCallId(
  callId: string,
  caller: { userId: string; email: string }
): Promise<ImportedMeetingInfo | null> {
  const [hit] = await findImportedOccurrences([{ teamsCallId: callId }], caller);
  return hit ?? null;
}
