/**
 * What a promoted placeholder's MEETING id becomes (Phase 1b —
 * docs/recordings-phase1b-spec.md §3).
 *
 * A row is born as a placeholder — `up-<uuid>` while its bytes are arriving,
 * `defer-<uuid>` while Google/Microsoft prepare the artefacts — and is
 * promoted in place the moment AssemblyAI accepts the job. Until 1b the
 * promotion renamed it to the AssemblyAI job id, which made a disposable
 * provider id the identity of the document (DEC-4 reverses that).
 *
 * The minted id is the placeholder's own uuid with the prefix cut off, NOT a
 * new prefix: ~27 files (listing glyphs, the sources card, the series dialog,
 * darth-cli's uuid-or-prefix resolution) read "no known prefix" as "an
 * ordinary transcribed upload", and a bare uuid keeps every one of them right
 * with no edits. It also keeps `/m/` links free: the same uuid means
 * `repointMeeting(placeholder → minted)` and the `former_ids` self-heal work
 * exactly as they do today.
 *
 * Pure: the flag is read by the caller (db-ops/aai-job-id.ts), which also
 * forces it off while migration 045 has not been applied.
 */

/** The placeholder prefixes a promotion can strip. */
const PLACEHOLDER_PREFIX_RE = /^(?:up-|defer-)/;

export function isPlaceholderId(id: string): boolean {
  return PLACEHOLDER_PREFIX_RE.test(id);
}

/** `up-1234…` → `1234…`; anything else is returned unchanged. */
export function bareMeetingId(placeholderId: string): string {
  return placeholderId.replace(PLACEHOLDER_PREFIX_RE, '');
}

/**
 * The id the row should carry after the promote.
 *
 * - Minting on, a real placeholder → its own uuid, bare.
 * - Minting off, a real placeholder → today's behaviour, the job id.
 * - NOT a placeholder → the id it already has, whatever the flag says. Two
 *   cases reach here and both want the id kept: a minted row being re-sent by
 *   Retry (a second job on the SAME meeting), and a legacy row the sweeper
 *   gave up on being re-sent (renaming it would break its links for a second
 *   time, and rolling the flag back must never re-point a minted row at a job
 *   id).
 */
export function promotedMeetingId(
  placeholderId: string,
  jobId: string,
  minted: boolean
): string {
  if (!isPlaceholderId(placeholderId)) return placeholderId;
  return minted ? bareMeetingId(placeholderId) : jobId;
}

/**
 * The id for a row inserted with no placeholder to promote — the sweeper
 * reaped it mid-upload, or the caller never made one. A fresh uuid rather
 * than the reaped placeholder's: that one may still be aliased by a
 * `former_ids` entry pointing somewhere else, and nothing links to this row
 * yet anyway.
 */
export function newMeetingId(jobId: string, minted: boolean): string {
  return minted ? crypto.randomUUID() : jobId;
}
