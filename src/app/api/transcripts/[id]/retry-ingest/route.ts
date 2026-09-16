import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { retryIngest } from '@/lib/server/ingest-retry';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/retry-ingest
 *
 * "Retry now" for a kept-failure row (status 'error' with an ingestFailure
 * marker — the hand-off to AssemblyAI failed after the bytes were stored).
 * Same replay the sweeper runs on its backoff, just immediately. Editors.
 * Responds 202 as soon as the row flips back to 'uploading'; the AAI upload
 * leg runs in the background and the page's status stream picks up the
 * result.
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }
  const row = access.row;
  if (row.status !== 'error' || !row.gmeet_context?.ingestFailure) {
    return NextResponse.json({ error: 'This transcript is not a failed hand-off.' }, { status: 409 });
  }
  const started = new Promise<void>((resolve) => {
    void retryIngest({ user_id: row.user_id, assemblyai_id: row.assemblyai_id }, 'manual')
      .then((out) => {
        if (!out.ok) console.warn(`[retry-ingest] ${row.assemblyai_id}: ${out.error}`);
      })
      .catch((err) => console.error(`[retry-ingest] ${row.assemblyai_id} crashed:`, err));
    // Give the reset a moment so the caller's next fetch sees 'uploading'.
    setTimeout(resolve, 300);
  });
  await started;
  return NextResponse.json({ ok: true }, { status: 202 });
});
