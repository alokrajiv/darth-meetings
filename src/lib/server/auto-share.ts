import 'server-only';
import { addShare } from '@/db-ops/transcript-shares';
import type { ShareOrigin } from '@/db-ops/share-origin';

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
  candidates: Array<{ email: string; name?: string | null }>,
  opts: {
    /**
     * Stamp these shares as created BY the calendar link (migration 048), so
     * "Unlink from event" can take exactly them back off again
     * (docs/recorder-link-confirm-spec.md D5). Passed by the upload path,
     * which is the one that shares an invite's people onto a recording the
     * moment it is linked. A share that already existed keeps its own
     * origin — a human's share never becomes link-born.
     */
    origin?: ShareOrigin;
  } = {}
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
        ...(opts.origin ? { origin: opts.origin } : {}),
      });
      shared++;
    } catch (err) {
      console.warn('[auto-share] failed for', email, err);
    }
  }
  return shared;
}
