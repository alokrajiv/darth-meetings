import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logPayloadMissing } from '@/lib/server/aai-retention';
import { resolveMeetingContent } from '@/lib/server/recordings';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/content
 *
 * Returns the full transcript payload (text, utterances, words). Visible to
 * owners and all collaborators (read or edit). Pure Postgres: the payload is
 * written by whoever observed completion (DEC-4 —
 * docs/recordings-first-class-design.md §7), so there is nothing to fetch and
 * nothing to cache here. A finished row with no payload is a real fault and
 * says so; it is never papered over with a call to AssemblyAI, whose copy is
 * deleted as soon as ours is safe.
 *
 * The payload comes from `resolveMeetingContent` — the meeting's clips over
 * its recordings. In compat (every row today) that IS `imported_content`,
 * returned by reference, so the JSON on the wire is byte-identical whether
 * MW_RECORDINGS is on or off.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const resolved = await resolveMeetingContent(access.row);
  if (resolved.content) {
    return NextResponse.json({ content: resolved.content });
  }

  const status = access.row.status;
  if (status !== 'completed' && status !== 'error') {
    // Still in flight — the detail page only asks once the row reads
    // 'completed', so this is a stale client or a direct caller.
    return NextResponse.json(
      { error: 'Transcript is still being transcribed', status },
      { status: 409 }
    );
  }

  // A failed job legitimately has nothing to serve; only a COMPLETED row
  // with no payload is the fault worth shouting about.
  if (status === 'error') {
    return NextResponse.json({ error: 'Transcription failed — there is no transcript', status }, { status: 404 });
  }

  logPayloadMissing(id, 'GET /api/transcripts/:id/content');
  return NextResponse.json(
    { error: 'Transcript content was never stored for this meeting', status },
    { status: 500 }
  );
});
