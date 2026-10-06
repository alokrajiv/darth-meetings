import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { publishEvent } from '@/lib/server/event-bus';
import { SHARE_ORIGIN_AUDITOR, SHARE_ORIGIN_SERIES_FOLLOW } from '@/lib/auditor-policy';

/**
 * `transcript_shares.origin` (migration 048) — why a share exists, and the
 * probe that keeps the code working before the migration is applied.
 *
 * One value exists: `'event-link'`, a share that exists ONLY because a
 * calendar event was linked to the meeting — the share with the event's
 * internal invitees every link makes (`shareWithInternalInvitees('event-link',
 * …)` in lib/server/auto-share.ts: upload with a linked event, recording
 * Link, retro-link, split-to-an-event, a linked text import). History: links
 * shared until 2026-09-23, design P4 stopped it, and the owner reversed P4 on
 * 2026-10-02 — a link shares like a cloud import again. A retranscribe re-run
 * copies an existing share's stamp. "Unlink from event" deletes exactly these
 * (docs/recorder-link-confirm-spec.md D5) — a share a human made in the
 * Share dialog carries no origin and is never touched.
 *
 * Same shape as db-ops/aai-job-id.ts: probed once per process, cached on
 * globalThis (Next bundles this module once per route graph), never at module
 * scope — `bun run build` must pass with no database at all.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const SHARE_ORIGIN_EVENT_LINK = 'event-link';
/** Second value (2026-10-06): an auditor share — lib/auditor-policy.ts. Never
 * taken by an unlink; only a person removes it (and that is recorded).
 * Third (same day, curated series §5): a series follower's read share —
 * added and taken back by the membership engine (lib/server/curated-series),
 * ledgered like an auditor's when a person removes it. */
export type ShareOrigin =
  | typeof SHARE_ORIGIN_EVENT_LINK
  | typeof SHARE_ORIGIN_AUDITOR
  | typeof SHARE_ORIGIN_SERIES_FOLLOW;

const g = globalThis as unknown as { __mwShareOriginColumn?: Promise<boolean> };

/** `true` when migration 048 has been applied to this schema. A FAILED probe
 * is not cached (a DB hiccup must not disable the column for the process). */
export function shareOriginColumnExists(): Promise<boolean> {
  return (g.__mwShareOriginColumn ??= (async () => {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM information_schema.columns
      WHERE table_schema = ${SCHEMA}
        AND table_name = 'transcript_shares'
        AND column_name = 'origin'
    `;
    const present = (rows[0]?.n ?? 0) > 0;
    if (!present) {
      console.warn(
        '[share-origin] column missing — apply migrations/048_share_origin.sql; ' +
          'link-born shares are not stamped and "Unlink from event" falls back to ' +
          'matching the event’s own attendees'
      );
    }
    return present;
  })().catch((err) => {
    g.__mwShareOriginColumn = undefined;
    throw err;
  }));
}

/**
 * Delete this meeting's link-born shares and say whose they were.
 *
 * Two arms, because the stamp only exists from 048 onwards:
 *   - stamped rows (`origin = 'event-link'`) go, always;
 *   - for a row linked BEFORE the stamp existed, the caller passes the
 *     event's attendee emails and the auto-share's own signature is matched:
 *     the owner shared them, with edit access, and no human origin. That is
 *     exactly what the pre-P4 upload link created.
 * The unstamped arm only matches shares older than LEGACY_LINK_SHARE_CUTOFF:
 * from then on every link-born share is stamped (048's writer was live; P4
 * wrote none, and the 2026-10-02 link shares stamp again) — so a newer
 * unstamped edit share to an invitee was made by a person, or by a cloud
 * import, and must survive the unlink.
 */
export const LEGACY_LINK_SHARE_CUTOFF = '2026-09-22T10:00:00Z';

export async function removeLinkBornShares(
  transcriptId: number,
  ownerUserId: string,
  attendeeEmails: string[]
): Promise<string[]> {
  const stamped = await shareOriginColumnExists().catch(() => false);
  const emails = [...new Set(attendeeEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];

  const rows = stamped
    ? await sql<Array<{ shared_with_email: string }>>`
        DELETE FROM ${sql(SCHEMA)}.transcript_shares
        WHERE transcript_id = ${transcriptId}
          AND (
            origin = ${SHARE_ORIGIN_EVENT_LINK}
            OR (
              origin IS NULL
              AND ${emails.length > 0}
              AND shared_with_email = ANY(${emails}::text[])
              AND shared_by_user_id = ${ownerUserId}
              AND access = 'edit'
              AND shared_at < ${LEGACY_LINK_SHARE_CUTOFF}::timestamptz
            )
          )
        RETURNING shared_with_email
      `
    : emails.length === 0
      ? []
      : await sql<Array<{ shared_with_email: string }>>`
          DELETE FROM ${sql(SCHEMA)}.transcript_shares
          WHERE transcript_id = ${transcriptId}
            AND shared_with_email = ANY(${emails}::text[])
            AND shared_by_user_id = ${ownerUserId}
            AND access = 'edit'
            AND shared_at < ${LEGACY_LINK_SHARE_CUTOFF}::timestamptz
          RETURNING shared_with_email
        `;
  if (rows.length > 0) publishEvent({ kind: 'shares' });
  return rows.map((r) => r.shared_with_email);
}

/**
 * RE-LINK: the meeting was linked to event A and is now being linked to event
 * B. Take off the shares A's link made for people who are NOT internal
 * invitees of B, before B's link adds its own — otherwise A's invitees keep a
 * meeting that is no longer theirs, and only a manual Unlink (which a re-link
 * never runs) would ever take them off.
 *
 * Stamped rows only (`origin = 'event-link'`). Unlike `removeLinkBornShares`
 * there is NO legacy signature arm: a re-link never guesses that an
 * un-stamped share was link-born — a share a person made (origin NULL) is
 * never touched here, whatever its shape. Without migration 048 nothing is
 * stamped, so nothing is removed.
 *
 * `keepEmails` = B's internal invitees (case-insensitive). A share to one of
 * them stays exactly as it is — same row, same access, same stamp — and B's
 * link then skips them as already shared. An empty list removes every
 * stamped share (B has no internal invitees). Returns whose shares went.
 */
export async function removeLinkBornSharesNotIn(
  transcriptId: number,
  keepEmails: string[]
): Promise<string[]> {
  const stamped = await shareOriginColumnExists().catch(() => false);
  if (!stamped) return [];
  const keep = [...new Set(keepEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const rows = await sql<Array<{ shared_with_email: string }>>`
    DELETE FROM ${sql(SCHEMA)}.transcript_shares
    WHERE transcript_id = ${transcriptId}
      AND origin = ${SHARE_ORIGIN_EVENT_LINK}
      AND NOT (lower(shared_with_email) = ANY(${keep}::text[]))
    RETURNING shared_with_email
  `;
  if (rows.length > 0) publishEvent({ kind: 'shares' });
  return rows.map((r) => r.shared_with_email);
}
