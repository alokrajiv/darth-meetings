import 'server-only';
import { createHash } from 'node:crypto';

/**
 * Stable identifiers for Teams meetings (spec §7.2/§7.4). Server-only: the
 * client never computes these — check/import responses carry whatever it
 * needs.
 */

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Synthetic assemblyai_id for an imported Teams occurrence:
 * `teams-<12 hex of sha256(graphMeetingId)>-<callId first 8>`. Unique per
 * occurrence, identical for every importer → the same-id dedupe used by
 * `gmeet-…` rows works unchanged. Graph meeting ids are long base64ish
 * strings — hashing keeps the id filename-safe (media lands as
 * `<assemblyai_id>.mp4`).
 */
export function teamsSourceId(graphMeetingId: string, callId: string): string {
  return `teams-${sha256Hex(graphMeetingId).slice(0, 12)}-${callId.slice(0, 8)}`;
}

/**
 * `meeting_code` component for gmeet_meeting_cache rows of Teams meetings —
 * derived from the CANONICAL join URL so the check route and the poller
 * agree on identity without any Graph call. (The real numeric Graph
 * meetingCode is only known post-resolution; it lives in the row's `raw`.)
 */
export function teamsCacheCode(canonicalJoinUrl: string): string {
  return `teams-${sha256Hex(canonicalJoinUrl).slice(0, 12)}`;
}
