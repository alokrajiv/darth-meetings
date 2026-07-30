import { NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getById } from '@/db-ops/transcript-attachments';
import { resolveAttachmentPath } from '@/lib/server/attachment-storage';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/attachments/:attachmentId/download
 * Stream the original file to anyone with access to the transcript.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id, attachmentId } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const attId = Number.parseInt(attachmentId, 10);
  if (!Number.isFinite(attId)) {
    return NextResponse.json({ error: 'Bad attachment id' }, { status: 400 });
  }

  const row = await getById(access.row.id, attId);
  if (!row || row.kind !== 'file' || !row.filename) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const abs = resolveAttachmentPath(row.filename);
  try {
    const st = await stat(abs);
    const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    const dispositionName = (row.original_filename ?? row.title).replace(/["\r\n]/g, '');
    return new NextResponse(stream, {
      headers: {
        'Content-Type': row.mime_type ?? 'application/octet-stream',
        'Content-Length': String(st.size),
        'Content-Disposition': `attachment; filename="${dispositionName}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File missing on server' }, { status: 404 });
  }
});
