import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { restoreForUser } from '@/db-ops/transcripts';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';
import { resolveAccess } from '@/db-ops/transcript-access';
import { syncSeriesForTranscript } from '@/lib/server/curated-series';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/restore
 * Owner-only. Undo a soft delete — clears deleted_at so the row reappears
 * everywhere (listing, search, series, shares for everyone it was shared
 * with). A restored row is always permanent: the temporary flag (migration
 * 042) is cleared too, otherwise an auto-trashed temporary row would be
 * trashed again by the next sweep.
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
  // Trash keeps the clips (nothing was deleted), so this is only a heal: a
  // row trashed while MW_RECORDINGS_WRITE was off gets its graph here.
  queueRecordingGraphSync(access.ownerUserId, id, 'restore');
  // Trash took it out of its (auto) series, with the series' labels and
  // follow shares; back in the archive, it rejoins.
  await syncSeriesForTranscript(access.row.id);
  return NextResponse.json({ ok: true });
});
