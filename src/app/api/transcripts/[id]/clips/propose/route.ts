import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { clipsEnabled } from '@/db-ops/clips';
import { meetingClipState } from '@/lib/server/clip-split';
import { proposeClips } from '@/lib/server/clip-proposer';
import type { ProposeClipsOk, ProposeClipsRequest } from '@/lib/clips';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/clips/propose — editors only.
 *
 * Suggestions, and ONLY suggestions: nothing is written, no file is cut, no
 * transcription is run. Deterministic boundaries (speaker entries and exits,
 * silences of 45 s or more, the owner's calendar) come first and are free;
 * one agent call then picks among them and names them, on the same runner and
 * cost accounting as auto-notes (`ai_runs` kind `clip_proposal`).
 *
 * No boundary ⇒ an empty list, no agent call and nothing charged. That is the
 * right answer for a recording that holds one meeting, and it is why the
 * model is never asked to invent a timestamp.
 *
 * Editors only because it spends money on the owner's account; readers get
 * the same meeting without the Suggest button.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const empty: ProposeClipsOk = { ok: true, proposals: [], candidates: 0, ranAgent: false };
  if (!(await clipsEnabled())) return NextResponse.json(empty);

  const state = await meetingClipState(access.row);
  if (!state.recordingId) return NextResponse.json(empty);

  const body = (await request.json().catch(() => null)) as ProposeClipsRequest | null;
  const out = await proposeClips({
    access,
    state,
    by: { userId: user.userId, email: user.email },
    instruction:
      typeof body?.instruction === 'string' ? body.instruction.trim().slice(0, 500) : null,
  });
  return NextResponse.json(out);
});
