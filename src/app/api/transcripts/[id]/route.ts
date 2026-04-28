import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  deleteForUser,
  touchLastAccessedForUser,
  updateMetaForUser,
} from '@/db-ops/transcripts';
import { deleteForUser as deleteSpeakerMappingsForUser } from '@/db-ops/speaker-mappings';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { deleteTranscript as aaiDelete } from '@/lib/server/assemblyai';
import { refreshIfPending } from '@/lib/server/transcript-sync';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id
 * Fetch a single transcript row visible to the current user (owner or
 * shared). If the row is still pending, refresh from AAI before returning.
 * Also bumps last_accessed on the owner's row.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const refreshed = await refreshIfPending(access.ownerUserId, access.row);
  await touchLastAccessedForUser(access.ownerUserId, id);

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'view',
  });

  return NextResponse.json({
    transcript: { ...refreshed, access: access.access, owner_email: null, owner_name: null },
  });
});

/**
 * PATCH /api/transcripts/:id
 * Update title and/or description. Editors (owner + 'edit' shares) can
 * update; read-only shares cannot.
 */
export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const { title, description } = body as { title?: unknown; description?: unknown };
  const updated = await updateMetaForUser(access.ownerUserId, id, {
    title: typeof title === 'string' ? title : undefined,
    description: typeof description === 'string' ? description : undefined,
  });

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'edit_meta',
    details: {
      changedTitle: typeof title === 'string',
      changedDescription: typeof description === 'string',
    },
  });

  return NextResponse.json({
    transcript: updated ? { ...updated, access: access.access, owner_email: null, owner_name: null } : null,
  });
});

/**
 * DELETE /api/transcripts/:id
 * Owner-only. Removes the row (and its speaker mappings + any shares via
 * the FK cascade) and asks AAI to delete the underlying transcript.
 */
export const DELETE = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can delete' }, { status: 403 });
  }

  await aaiDelete(id);
  await deleteSpeakerMappingsForUser(access.ownerUserId, id);
  await deleteForUser(access.ownerUserId, id);

  return NextResponse.json({ ok: true });
});
