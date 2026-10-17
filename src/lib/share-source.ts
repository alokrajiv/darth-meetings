/**
 * Where a share of a meeting came from — the `source` field that
 * `GET /api/transcripts/:id/shares` adds to every share row, so a caller
 * (the CLI's `meetings share <id>` / `meetings get <id>`) can answer "who has
 * access to this, and why".
 *
 * `transcript_shares.origin` (migration 048) stamps the automatic kinds
 * (event-link, auditor, series follow). A NULL origin covers two kinds the
 * table itself does not tell apart: a share a person made with Share (the web
 * dialog or `darth-cli meetings share` — both go through
 * `POST /api/transcripts/:id/shares`, which logs `share_add` in
 * transcript_activity), and an internal invitee shared by a Meet/Teams import
 * (no activity row). The activity log has recorded `share_add` since sharing
 * shipped (2026-04-28), so "has a share_add for this email" = manual. The old
 * owner kept on as editor after an ownership transfer is the actor of an
 * `owner_transfer` row.
 *
 * Pure: the route passes the activity sets in.
 */
import { SHARE_ORIGIN_AUDITOR, SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';

/** `'event-link'` is `SHARE_ORIGIN_EVENT_LINK` (db-ops/share-origin.ts — server-only, so spelled here). */
const ORIGIN_EVENT_LINK = 'event-link';

export type ShareSource =
  /** Added by a person with Share (web dialog or CLI). */
  | 'manual'
  /** No manual share recorded: an internal invitee of the meeting's Meet/Teams calendar invite (import). */
  | 'invite'
  /** An internal invitee of a calendar event someone linked the meeting to (origin 'event-link'). */
  | 'event-link'
  /** An auditor, added because an outside party was on the invite (origin 'auditor-external'). */
  | 'auditor'
  /** A follower of a curated series the meeting is in (origin 'series-follow'). */
  | 'series-follow'
  /** The previous owner, kept on as an editor by an ownership transfer. */
  | 'previous-owner';

export interface ShareProvenance {
  /** Lower-cased emails a `share_add` activity row names (details.withEmail). */
  manual: ReadonlySet<string>;
  /** Lower-cased emails of the actors of `owner_transfer` rows. */
  previousOwners: ReadonlySet<string>;
}

export function shareSource(
  share: { shared_with_email: string; origin?: string | null },
  prov: ShareProvenance
): ShareSource {
  if (share.origin === ORIGIN_EVENT_LINK) return 'event-link';
  if (share.origin === SHARE_ORIGIN_AUDITOR) return 'auditor';
  if (share.origin === SHARE_ORIGIN_SERIES_FOLLOW) return 'series-follow';
  const email = share.shared_with_email.trim().toLowerCase();
  if (prov.previousOwners.has(email)) return 'previous-owner';
  if (prov.manual.has(email)) return 'manual';
  return 'invite';
}
