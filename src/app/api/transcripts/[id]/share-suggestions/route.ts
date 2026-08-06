import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getForUser as getMappingsForUser } from '@/db-ops/speaker-mappings';
import { listByTranscript as listShares } from '@/db-ops/transcript-shares';
import { searchPeople } from '@/db-ops/people';
import { normName } from '@/lib/server/import-helpers';

export const runtime = 'nodejs';

const SUGGEST_DOMAINS = new Set(['trames.sg', 'trames-engineering.com']);
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * GET /api/transcripts/:id/share-suggestions
 *
 * People this transcript should probably be shared with but isn't: named
 * speakers (resolved to directory emails) plus, for Meet imports, the
 * invitees/participants — filtered to internal domains, minus the owner and
 * anyone already shared. Powers the "Suggested from this meeting" section of
 * the share dialog and the nudge dot on Share buttons.
 *
 * Owner and editors only (they can share); read-only collaborators get [].
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access !== 'owner' && access.access !== 'edit') {
    return NextResponse.json({ suggestions: [] });
  }

  const [mappings, shares] = await Promise.all([
    getMappingsForUser(access.ownerUserId, id),
    listShares(access.row.id),
  ]);

  const excluded = new Set<string>([user.email.trim().toLowerCase()]);
  for (const s of shares) excluded.add(s.shared_with_email.toLowerCase());

  const found = new Map<string, { name: string; email: string; reason: string }>();
  const consider = (name: string | undefined, email: string | undefined, reason: string) => {
    if (!email) return;
    const e = email.trim().toLowerCase();
    const domain = e.split('@')[1] ?? '';
    if (!SUGGEST_DOMAINS.has(domain) || excluded.has(e) || found.has(e)) return;
    found.set(e, { name: name?.trim() || e, email: e, reason });
  };

  // 1. Named speakers → emails, from the mapping description (imports embed
  //    them) or a directory lookup by exact-normalised name.
  for (const label of mappings?.speaker_labels ?? []) {
    const name = label.customName.trim();
    if (!name) continue;
    const embedded = EMAIL_RE.exec(label.description ?? '')?.[0];
    if (embedded) {
      consider(name, embedded, 'spoke in this meeting');
      continue;
    }
    try {
      const people = await searchPeople(name, 5);
      const match = people.find((p) => p.email && normName(p.name) === normName(name));
      if (match?.email) consider(name, match.email, 'spoke in this meeting');
    } catch {
      // directory unavailable — skip silently
    }
  }

  // 2. Meet imports: invitees + actual participants.
  const ctx = access.row.gmeet_context;
  for (const a of ctx?.attendees ?? []) consider(a.name ?? undefined, a.email, 'was invited');
  for (const p of ctx?.actuals?.participants ?? []) {
    consider(p.displayName, p.email, 'joined the meeting');
  }

  return NextResponse.json({ suggestions: [...found.values()].slice(0, 12) });
});
