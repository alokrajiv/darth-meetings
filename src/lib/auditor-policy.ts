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
 * Pure — shared by the server policy (lib/server/auto-share.ts), the backfill
 * (scripts/auditor-backfill.sql mirrors these lists) and the share dialog.
 */

/** Who is auto-added (email lower-cased; the name is what the share row shows). */
export const AUDITORS: ReadonlyArray<{ email: string; name: string }> = [
  { email: 'alok@trames.sg', name: 'Alok Rajiv' },
  { email: 'ivan@trames.sg', name: 'Ivan Seow' },
];

/** `transcript_shares.origin` of an auditor share (migration 048's column). */
export const SHARE_ORIGIN_AUDITOR = 'auditor-external';

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
