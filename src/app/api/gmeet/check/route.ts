import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';

export const runtime = 'nodejs';

/**
 * POST /api/gmeet/check
 * Body: { meetingCodes: string[] } (max 100)
 *
 * Cross-USER dedupe check for the sync list: which of these meetings has
 * anyone already imported? Returns per-code info including whether the
 * caller can open it and (best-effort) who owns it. Deliberately exposes
 * only owner email + title — enough for a "synced by X" marker.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    meetingCodes?: string[];
  } | null;
  const codes = (body?.meetingCodes ?? []).slice(0, 100);
  if (codes.length === 0) return NextResponse.json({ imported: {} });

  const rows = await findImportedByMeetingCodes(codes, {
    userId: user.userId,
    email: user.email,
  });
  const imported: Record<
    string,
    {
      assemblyaiId: string | null;
      title: string | null;
      ownerEmail: string | null;
      accessible: boolean;
      mine: boolean;
    }
  > = {};
  for (const r of rows) {
    imported[r.meeting_code] = {
      // Don't leak the transcript id unless the caller can actually open it.
      assemblyaiId: r.accessible ? r.assemblyai_id : null,
      title: r.accessible ? r.title : null,
      ownerEmail: r.owner_email,
      accessible: r.accessible,
      mine: r.mine,
    };
  }
  return NextResponse.json({ imported });
});
