import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { deleteAttachment } from '@/db-ops/transcript-attachments';
import { deleteAttachmentFile } from '@/lib/server/attachment-storage';

export const runtime = 'nodejs';

/**
 * DELETE /api/transcripts/:id/attachments/:attachmentId
 * Owner and edit collaborators can remove attached context.
 */
export const DELETE = withAuth(async ({ user }, { params }) => {
  const { id, attachmentId } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const attId = Number.parseInt(attachmentId, 10);
  if (!Number.isFinite(attId)) {
    return NextResponse.json({ error: 'Bad attachment id' }, { status: 400 });
  }

  const row = await deleteAttachment(access.row.id, attId);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (row.filename) await deleteAttachmentFile(row.filename);
  return NextResponse.json({ ok: true });
});
