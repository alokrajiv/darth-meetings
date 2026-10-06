import 'server-only';
import { addShare, listByTranscript } from '@/db-ops/transcript-shares';
import { removeLinkBornSharesNotIn, SHARE_ORIGIN_EVENT_LINK } from '@/db-ops/share-origin';
import { addAuditorShares } from '@/db-ops/auditor-shares';
import { AUDITORS, externalParties } from '@/lib/auditor-policy';

// Internal domains: invitees on these are the people a meeting tied to a
// calendar invite is shared with (and the domains share suggestions are
// drawn from).
export const AUTO_SHARE_DOMAINS = new Set(['trames.sg', 'trames-engineering.com']);

/**
 * Why a meeting is being shared with its invite's internal people. Both arms
 * apply ONE rule — the meeting share policy — and differ only in what the
 * share row records:
 *
 *  - `'cloud-import'`: a Meet/Teams import (manual, series auto-import,
 *    account auto-sync) creates the meeting from the invite itself. Shares
 *    carry no origin: "Unlink from event" leaves them alone.
 *  - `'event-link'`: a person LINKED a meeting to a calendar occurrence — the
 *    tray's Link, the web upload stepper, the calendar row's Upload,
 *    `darth-cli meetings upload --event`, `POST /api/recordings/:id/link`,
 *    retro-link (`…/link-event`) and split-to-an-event. Shares are stamped
 *    `origin = 'event-link'` (migration 048) so unlinking takes exactly them
 *    back off (docs/recorder-link-confirm-spec.md D5).
 */
export type AutoShareArm = 'cloud-import' | 'event-link';

/**
 * The people the policy shares with: every invitee on an internal domain,
 * lower-cased, de-duplicated, never the owner — email → display name.
 */
export function internalInvitees(
  ownerEmail: string,
  candidates: ReadonlyArray<{ email?: string | null; name?: string | null }>
): Map<string, string | null> {
  const self = ownerEmail.trim().toLowerCase();
  const wanted = new Map<string, string | null>();
  for (const a of candidates) {
    if (typeof a?.email !== 'string') continue;
    const email = a.email.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (!email || email === self || !AUTO_SHARE_DOMAINS.has(domain)) continue;
    if (!wanted.has(email)) wanted.set(email, a.name ?? null);
  }
  return wanted;
}

/**
 * Share a meeting with every INTERNAL invitee of its calendar event, with
 * edit access — the meeting share policy (owner, 2026-10-02, reversing the
 * 2026-09-23 "a link never shares" rule of design P4): the invite IS the
 * meeting, and everyone on it is a person the meeting belongs to, whether
 * the meeting came from a cloud import or from a recording someone linked.
 *
 * What is shared is the MEETING. A recording behind it stays its owner's:
 * `/api/recordings/*` answers to the owner alone, and a share recipient
 * reaches the media only through the meeting's routes.
 *
 * Never shares with the owner themself or with an external domain. No DM:
 * an auto-share notifies nobody (the manual Share dialog is the one that
 * does). The `'event-link'` arm is idempotent and never rewrites a share
 * that already exists — a re-link adds only the people missing, and a share
 * a person made (or downgraded to read) keeps its access and stays
 * un-stamped, so an unlink never takes it.
 *
 * Every call also runs the auditor policy (`shareWithAuditors` below): an
 * outside party on the invite shares the meeting read-only with the auditors.
 *
 * Returns how many invitee shares this call created (auditors not counted).
 */
export async function shareWithInternalInvitees(
  arm: AutoShareArm,
  transcriptId: number,
  ownerUserId: string,
  ownerEmail: string,
  candidates: ReadonlyArray<{ email?: string | null; name?: string | null }>
): Promise<number> {
  if (arm !== 'cloud-import' && arm !== 'event-link') return 0;
  const wanted = internalInvitees(ownerEmail, candidates);
  // The internal invitees go first, so an auditor who is ON the invite gets
  // the invitee's edit share, not the auditor's read one.
  const shared = wanted.size === 0 ? 0 : await shareWithInvitees(arm, transcriptId, ownerUserId, wanted);
  await shareWithAuditors(transcriptId, ownerUserId, ownerEmail, candidates).catch((err) =>
    console.warn('[auditor-share] failed for transcript', transcriptId, err)
  );
  return shared;
}

/**
 * The auditor policy (lib/auditor-policy.ts): a meeting with an outside party
 * on its invite (or among who joined) is shared read-only with every auditor
 * who is not its owner. Runs wherever the invite policy runs — every import
 * and every link to an event. Never touches an existing share, never re-adds
 * an auditor the meeting was taken away from. Returns the auditors added.
 */
export async function shareWithAuditors(
  transcriptId: number,
  ownerUserId: string,
  ownerEmail: string,
  candidates: ReadonlyArray<{ email?: string | null; name?: string | null }>
): Promise<string[]> {
  const outside = externalParties(
    candidates.map((c) => c?.email),
    AUTO_SHARE_DOMAINS
  );
  if (outside.length === 0) return [];
  const self = ownerEmail.trim().toLowerCase();
  const auditors = AUDITORS.filter((a) => a.email !== self);
  const added = await addAuditorShares(transcriptId, ownerUserId, auditors);
  if (added.length > 0) {
    console.log(
      `[auditor-share] transcript ${transcriptId}: added ${added.join(', ')} ` +
        `(outside party: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', …' : ''})`
    );
  }
  return added;
}

async function shareWithInvitees(
  arm: AutoShareArm,
  transcriptId: number,
  ownerUserId: string,
  wanted: Map<string, string | null>
): Promise<number> {
  if (arm === 'event-link') {
    const existing = await listByTranscript(transcriptId);
    for (const s of existing) wanted.delete(s.shared_with_email.trim().toLowerCase());
  }

  let shared = 0;
  for (const [email, name] of wanted) {
    try {
      await addShare({
        transcriptId,
        ownerUserId,
        sharedByUserId: ownerUserId,
        sharedWithEmail: email,
        sharedWithName: name,
        sharedWithPplId: null,
        access: 'edit',
        ...(arm === 'event-link' ? { origin: SHARE_ORIGIN_EVENT_LINK } : {}),
      });
      shared++;
    } catch (err) {
      console.warn('[auto-share] failed for', email, err);
    }
  }
  return shared;
}

/**
 * Link a meeting that is ALREADY linked to a calendar event to an event
 * (`POST /api/transcripts/:id/link-event` on a linked row — the link dialog's
 * "change event", the "Link to it" strips, `darth-cli meetings link` on a
 * linked meeting). Two steps, in this order:
 *
 *  1. the shares the PREVIOUS link made (`origin = 'event-link'`) for anyone
 *     who is not an internal invitee of the new event come off
 *     (`removeLinkBornSharesNotIn`) — A's invitees are not B's, and a re-link
 *     never runs Unlink;
 *  2. the new event's internal invitees are added exactly as any link adds
 *     them (`shareWithInternalInvitees('event-link', …)`): only the missing
 *     ones, so someone on both invites keeps their one share untouched.
 *
 * A share a person made (origin NULL) is never touched, whoever it is for.
 * Re-linking to the SAME event is the same two steps — an invitee dropped
 * from the invite since the first link loses the link's share, which is what
 * "shared as per the invite" means.
 */
export async function relinkSharesToEvent(
  transcriptId: number,
  ownerUserId: string,
  ownerEmail: string,
  candidates: ReadonlyArray<{ email?: string | null; name?: string | null }>
): Promise<{ shared: number; removed: string[] }> {
  const keep = [...internalInvitees(ownerEmail, candidates).keys()];
  const removed = await removeLinkBornSharesNotIn(transcriptId, keep);
  const shared = await shareWithInternalInvitees(
    'event-link',
    transcriptId,
    ownerUserId,
    ownerEmail,
    candidates
  );
  return { shared, removed };
}
