import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { unsplitMeeting } from '@/lib/server/clip-split';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/unsplit — "put it back", sent from the meeting
 * that was SPLIT OFF.
 *
 * The source's two clips merge back into one, both halves' edits go back on
 * one map in time order, and this row is destroyed. No file is touched: the
 * bytes were never this meeting's own.
 *
 * The caller must be able to EDIT BOTH meetings, and the refusal never says
 * which one is in the way — a person shared only this half must not be able
 * to write into a meeting they cannot open, nor learn that it exists.
 * Plain trash of this meeting is the other option and leaves the hole (the
 * text comes back by restoring it).
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const out = await unsplitMeeting(access, {
    userId: user.userId,
    email: user.email,
    name: user.name ?? null,
  });
  if (!out.ok) return NextResponse.json(out.body, { status: out.status });
  return NextResponse.json(out.body);
});
