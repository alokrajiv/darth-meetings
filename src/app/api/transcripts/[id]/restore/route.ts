import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { restoreForUser } from '@/db-ops/transcripts';
import { resolveAccess } from '@/db-ops/transcript-access';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/restore
 * Owner-only. Undo a soft delete — clears deleted_at so the row reappears
 * everywhere (listing, search, series, shares for everyone it was shared
 * with).
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can restore' }, { status: 403 });
  }

  const restored = await restoreForUser(access.ownerUserId, id);
  if (!restored) {
    return NextResponse.json({ error: 'Not in the trash' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
});
