import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { clipsView } from '@/lib/server/clip-split';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/clips
 *
 * Which windows of which recording this meeting uses, what the player must
 * clamp to, where the holes are, and — the part that matters — which OTHER
 * meetings sit on the same recording.
 *
 * PRIVACY: a recording has no ACL. The meeting is the gate (`resolveAccess`),
 * and every sibling is resolved through the CALLER's own owner-or-share
 * predicate in SQL (`listSiblingMeetingsForRecordings`). A person shared only
 * the split-off half never learns that the longer meeting exists: not its id,
 * not its title, not its window, not even that the list is non-empty
 * (feedback_privacy_caller_scoping_gate). `splitFrom` is served only when the
 * caller can open the meeting it names.
 *
 * `enabled: false` — `MW_CLIPS` off, 044–046 missing, or this meeting has no
 * clip — means the UI hides everything about clips and nothing else changes.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await clipsView(access, { userId: user.userId, email: user.email });
  return NextResponse.json(body);
});
