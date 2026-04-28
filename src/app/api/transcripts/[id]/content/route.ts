import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { setCachedContentForUser } from '@/db-ops/transcripts';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getTranscript } from '@/lib/server/assemblyai';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/content
 *
 * Returns the full transcript payload (text, utterances, words). Visible to
 * owners and all collaborators (read or edit). Reads from the DB cache
 * (`imported_content`) if present; otherwise calls AAI once, stores the
 * result on the *owner's* row, and returns it.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Cache hit — serve straight from Postgres.
  if (access.row.imported_content) {
    return NextResponse.json({ content: access.row.imported_content });
  }

  try {
    const content = await getTranscript(id);
    if (content.status === 'completed' || content.status === 'error') {
      void setCachedContentForUser(access.ownerUserId, id, content).catch((err) =>
        console.error('[GET /api/transcripts/:id/content] cache write failed:', err)
      );
    }
    return NextResponse.json({ content });
  } catch (error) {
    console.error('[GET /api/transcripts/:id/content] AAI fetch failed:', error);
    return NextResponse.json(
      { error: 'Failed to fetch transcript content', detail: String(error) },
      { status: 502 }
    );
  }
});
