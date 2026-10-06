/**
 * Auditor shares (owner, 2026-10-06): every meeting where the team talked to
 * someone OUTSIDE the company is shared read-only with the auditors. A
 * conversation with a customer or partner carries no expectation of privacy
 * inside Tramés, so the auditors see all of them without being invited.
 *
 *  - "outside" = an invitee/participant on a domain that is not internal,
 *    not a calendar resource (rooms, group calendars), and not a personal
 *    mailbox (gmail.com & co.). The personal-mail exclusion is deliberate:
 *    the only outside party on those is almost always a job candidate
 *    ("Ashraff <> Trames"), and interviews are not customer conversations.
 *  - the owner may remove an auditor's share. That is allowed and RECORDED
 *    (`auditor_share_removals`, migration 052), and an auditor removed from a
 *    meeting is never added back to it automatically.
 *
 * WHO the auditors are lives in the database since curated series v2
 * (migration 054 `auditors`, read through db-ops/auditors.ts loadAuditors —
 * server only; docs/curated-series-spec.md §11.3). Edited by hand (psql).
 *
 * Pure — shared by the server policy (lib/server/auto-share.ts), the backfill
 * (scripts/auditor-backfill.sql mirrors the domain lists) and the share
 * dialog.
 */

/** `transcript_shares.origin` of an auditor share (migration 048's column). */
export const SHARE_ORIGIN_AUDITOR = 'auditor-external';

/**
 * `transcript_shares.origin` of a follow share (docs/curated-series-spec.md
 * §5): a series follower's read share of a member meeting. The same kind of
 * automatic read share as an auditor's — same writer, same removal ledger,
 * same "never re-added once removed" rule.
 */
export const SHARE_ORIGIN_SERIES_FOLLOW = 'series-follow';

/** Personal mailboxes: an outside party ONLY on these does not count. */
export const PERSONAL_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.com.sg',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
]);

function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

/**
 * The outside parties among `emails` — the addresses that make a meeting an
 * external one. Empty = an internal meeting (or one with no invite at all).
 */
export function externalParties(
  emails: ReadonlyArray<string | null | undefined>,
  internalDomains: ReadonlySet<string>
): string[] {
  const out = new Set<string>();
  for (const raw of emails) {
    if (typeof raw !== 'string') continue;
    const email = raw.trim().toLowerCase();
    const domain = domainOf(email);
    if (!domain) continue;
    if (internalDomains.has(domain)) continue;
    if (domain === 'calendar.google.com' || domain.endsWith('.calendar.google.com')) continue;
    if (PERSONAL_MAIL_DOMAINS.has(domain)) continue;
    out.add(email);
  }
  return [...out];
}

export function isAuditorShare(share: { origin?: string | null }): boolean {
  return share.origin === SHARE_ORIGIN_AUDITOR;
}

export function isSeriesFollowShare(share: { origin?: string | null }): boolean {
  return share.origin === SHARE_ORIGIN_SERIES_FOLLOW;
}

/** An automatic read share (auditor or follow): removing one is recorded in
 * the ledger, and the automation never puts that person back. */
export function isAutoReadShare(share: { origin?: string | null }): boolean {
  return isAuditorShare(share) || isSeriesFollowShare(share);
}
