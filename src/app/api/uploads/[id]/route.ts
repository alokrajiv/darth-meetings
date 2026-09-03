import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  deleteUploadSession,
  getUploadSessionForUser,
  listReceivedChunks,
} from '@/db-ops/upload-sessions';
import { abandonUpload } from '@/lib/server/upload-pipeline';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/uploads/:id — session state. The client polls this when a
 * complete request's response was lost (network drop mid-ingest). */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getUploadSessionForUser(user.userId, id);
  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  const received = session.status === 'open' ? await listReceivedChunks(session.id) : [];
  return NextResponse.json({
    id: session.id,
    status: session.status,
    error: session.error,
    chunkSize: session.chunk_size,
    chunkCount: session.chunk_count,
    received,
    transcriptId: session.result_id,
    placeholderId: session.placeholder_id,
  });
});

/** DELETE /api/uploads/:id — the user gave up: drop the session, its temp
 * file and (for a single-file / first-part session) the placeholder row. */
export const DELETE = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getUploadSessionForUser(user.userId, id);
  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  if (session.status === 'open') await abandonUpload(user, session.spec);
  await deleteUploadSession(session.id);
  return NextResponse.json({ ok: true });
});
