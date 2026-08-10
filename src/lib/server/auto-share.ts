import 'server-only';
import { addShare } from '@/db-ops/transcript-shares';

// Invitees on these domains get the transcript shared to them automatically
// ("throw them in"): everyone on the invite could have fetched the artifacts
// from Drive themselves, so gating access behind manual sharing only invites
// duplicate imports. Used by the Meet import AND the upload-media path (when
// a calendar event is linked at upload time).
export const AUTO_SHARE_DOMAINS = new Set(['trames.sg', 'trames-engineering.com']);

export async function autoShareToInternalInvitees(
  transcriptId: number,
  ownerUserId: string,
  ownerEmail: string,
  candidates: Array<{ email: string; name?: string | null }>
): Promise<number> {
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
