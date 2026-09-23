import 'server-only';
import { addShare } from '@/db-ops/transcript-shares';

// Internal domains: invitees on these are the people a cloud import shares
// the new meeting with (and the domains share suggestions are drawn from).
export const AUTO_SHARE_DOMAINS = new Set(['trames.sg', 'trames-engineering.com']);

/**
 * THE CLOUD-IMPORT ARM, and nothing else (docs/recordings-meetings-series-design.md
 * §1.2, §6.2 Q8): a Meet/Teams import — manual, series auto-import, account
 * auto-sync — creates a meeting shared to its internal invitees, because the
 * invite IS the meeting and everyone on it could fetch the provider's
 * artifacts themselves; gating them behind a manual share only invites
 * duplicate imports.
 *
 * Rule (owner, 2026-09-23, design step P4): LINKING A RECORDING TO A
 * CALENDAR OCCURRENCE NEVER CREATES SHARES. The tray's Link, the web upload
 * stepper, the calendar row's Upload, `darth-cli meetings upload --event`,
 * retro-link and split-to-an-event are user LINKS — they must not call this.
 * Sharing a linked meeting is a separate, explicit act (the share dialog's
 * "Suggested from this meeting"). Hence the name, and the `arm` argument a
 * caller has to spell out: nobody reaches this by accident from a link path.
 *
 * Shares are written with edit access and no origin (they are not link-born,
 * so "Unlink from event" leaves them alone).
 */
export async function shareCloudImportWithInternalInvitees(
  arm: 'cloud-import',
  transcriptId: number,
  ownerUserId: string,
  ownerEmail: string,
  candidates: Array<{ email: string; name?: string | null }>
): Promise<number> {
  if (arm !== 'cloud-import') return 0;
  const self = ownerEmail.trim().toLowerCase();
  let shared = 0;
  for (const a of candidates) {
    const email = a.email.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (email === self || !AUTO_SHARE_DOMAINS.has(domain)) continue;
    try {
      await addShare({
        transcriptId,
        ownerUserId,
        sharedByUserId: ownerUserId,
        sharedWithEmail: email,
        sharedWithName: a.name ?? null,
        sharedWithPplId: null,
        access: 'edit',
      });
      shared++;
    } catch (err) {
      console.warn('[auto-share] failed for', email, err);
    }
  }
  return shared;
}
