import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { listVisibleMemberships } from '@/db-ops/series';
import { isAuditor } from '@/db-ops/auditors';
import { seriesOwnershipReady } from '@/db-ops/series-ownership-schema';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/series — the series this meeting is in that the
 * CALLER may see (curated series v2, §11.6 — owner, editor, follower or
 * auditor of the series), first by priority then id, and whether the caller
 * may change the meeting's series (owner or editor of the MEETING; the
 * series routes check the series side). A meeting can be in several series
 * (§11.2); a series the caller cannot see is never named — not even counted.
 *
 *   { memberships: [{ series_id, title, how }], membership: <first>|null,
 *     canEdit, candidates: [] }
 *
 * `membership` (the first) and `candidates` (always empty — a pattern match
 * IS membership) are kept for older clients.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const ready = await seriesOwnershipReady().catch(() => false);
  const memberships = ready
    ? (
        await listVisibleMemberships(
          access.row.id,
          { userId: user.userId, email: user.email },
          await isAuditor(user.email)
        )
      ).map((m) => ({ series_id: m.series_id, title: m.title, how: m.how }))
    : [];
  return NextResponse.json({
    memberships,
    membership: memberships[0] ?? null,
    canEdit: access.access === 'owner' || access.access === 'edit',
    candidates: [],
  });
});
