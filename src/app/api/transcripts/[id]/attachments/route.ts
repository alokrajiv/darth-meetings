import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import {
  insertAttachment,
  listByTranscript,
  type AttachmentRow,
} from '@/db-ops/transcript-attachments';
import {
  attachmentFilename,
  resolveAttachmentPath,
  saveAttachmentBytes,
  deleteAttachmentFile,
} from '@/lib/server/attachment-storage';
import { extractAttachmentText } from '@/lib/server/attachment-extract';
import type { TranscriptAttachment } from '@/lib/format';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;

/** Strip the storage filename before anything leaves the server. */
function toClient(row: AttachmentRow): TranscriptAttachment {
  const { filename, ...rest } = row;
  void filename;
  return rest;
}

/**
 * GET /api/transcripts/:id/attachments — list the transcript's attached
 * context. Visible to owner + all collaborators.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rows = await listByTranscript(access.row.id);
  return NextResponse.json({ attachments: rows.map(toClient) });
});

/**
 * POST /api/transcripts/:id/attachments
 *
 * Two body shapes:
 *  - application/json { kind: 'text', title?, text } — pasted/typed context
 *  - anything else: raw file bytes, `x-filename` header (URI-encoded),
 *    optional `x-title`. Text is extracted at upload time (pdf/docx/pptx/
 *    xlsx/plain formats) so notes generation just reads text_content.
 *
 * Owner and edit collaborators only.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    let body: { kind?: string; title?: string; text?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (body.kind !== 'text' || !text) {
      return NextResponse.json({ error: "kind must be 'text' with non-empty text" }, { status: 400 });
    }
    const row = await insertAttachment({
      transcriptId: access.row.id,
      addedByUserId: user.userId,
      addedByEmail: user.email ?? null,
      kind: 'text',
      title: (body.title ?? '').trim().slice(0, 200) || 'Pasted notes',
      textContent: text.slice(0, MAX_TEXT_CHARS),
    });
    return NextResponse.json({ attachment: toClient(row) }, { status: 201 });
  }

  // Raw file body.
  const rawName = request.headers.get('x-filename');
  let originalFilename: string | null = null;
  if (rawName) {
    try {
      originalFilename = decodeURIComponent(rawName);
    } catch {
      originalFilename = rawName;
    }
  }
  const rawTitle = request.headers.get('x-title');
  let title = originalFilename ?? 'Attachment';
  if (rawTitle) {
    try {
      title = decodeURIComponent(rawTitle);
    } catch {
      title = rawTitle;
    }
  }

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  }
  if (buf.length > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'File too large (max 25 MB)' }, { status: 413 });
  }

  const filename = attachmentFilename(originalFilename);
  await saveAttachmentBytes(filename, buf);

  const mimeType = contentType.split(';')[0]?.trim() || null;
  let extraction: Awaited<ReturnType<typeof extractAttachmentText>>;
  try {
    extraction = await extractAttachmentText(
      resolveAttachmentPath(filename),
      originalFilename,
      mimeType
    );
  } catch {
    extraction = { text: null, status: 'failed' };
  }

  try {
    const row = await insertAttachment({
      transcriptId: access.row.id,
      addedByUserId: user.userId,
      addedByEmail: user.email ?? null,
      kind: 'file',
      title: title.trim().slice(0, 200) || 'Attachment',
      textContent: extraction.text,
      filename,
      originalFilename,
      mimeType,
      sizeBytes: buf.length,
      extractionStatus: extraction.status,
    });
    return NextResponse.json({ attachment: toClient(row) }, { status: 201 });
  } catch (err) {
    // DB insert failed — don't leave orphaned bytes on disk.
    await deleteAttachmentFile(filename);
    throw err;
  }
});
