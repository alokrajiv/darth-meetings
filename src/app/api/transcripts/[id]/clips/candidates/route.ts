import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { clipCandidates } from '@/lib/server/clip-combine';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/clips/candidates — "Add a recording… from where?"
 * (Phase 3b, docs/recordings-phase3b-combine-spec.md).
 *
 * The recordings THIS caller may be offered as a second capture of this
 * meeting: their own unlinked recordings (the Recordings tab), and the
 * recordings of meetings they can EDIT.
 *
 * PRIVACY — this is a list of other people's meetings' bytes and every row on
 * it is caller-scoped in SQL (`listAddableRecordings`): a recording reaches
 * this list only when the caller OWNS it, or can open AND edit a meeting that
 * holds it. A read-only reader of a meeting is never offered its recording,
 * and a meeting the caller cannot open never contributes its title
 * (feedback_privacy_caller_scoping_gate).
 *
 * `addable: false` marks a row the caller may see but may not add — someone
 * else's bytes, which are theirs to give (spec §Privacy). The sheet shows the
 * reason rather than offering an action the route would refuse.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await clipCandidates(access, { userId: user.userId, email: user.email });
  return NextResponse.json(body);
});
