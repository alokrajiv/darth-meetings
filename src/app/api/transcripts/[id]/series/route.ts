import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getMembership } from '@/db-ops/series';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/series — the meeting's series membership (if any)
 * and whether the caller may change it (owner or editor). `candidates` is
 * always empty since curated series (2026-10-06): a pattern match IS
 * membership, so there is nothing left to guess — kept for older clients.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const membership = await getMembership(access.row.id);
  return NextResponse.json({
    membership,
    canEdit: access.access === 'owner' || access.access === 'edit',
    candidates: [],
  });
});
