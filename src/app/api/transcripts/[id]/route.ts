import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  deleteForUser,
  setRecordedAtForUser,
  softDeleteForUser,
  touchLastAccessedForUser,
  updateMetaForUser,
} from '@/db-ops/transcripts';
import { deleteForUser as deleteSpeakerMappingsForUser } from '@/db-ops/speaker-mappings';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { deleteTranscript as aaiDelete } from '@/lib/server/assemblyai';
import { deleteAudioFile } from '@/lib/server/audio-storage';
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

  const { title, description, recordedAt } = body as {
    title?: unknown;
    description?: unknown;
    recordedAt?: unknown;
  };

  // Meeting date: ISO string sets it, explicit null clears it.
  if (recordedAt === null) {
    await setRecordedAtForUser(access.ownerUserId, id, null);
  } else if (typeof recordedAt === 'string') {
    const d = new Date(recordedAt);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: 'recordedAt must be an ISO date' }, { status: 400 });
    }
    await setRecordedAtForUser(access.ownerUserId, id, d);
  }

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
 * Owner-only. Default is a SOFT delete (trash): the row is stamped
 * deleted_at and disappears from listings/search/series/dedupe/background
 * jobs, but the AAI transcript, audio, shares, and notes survive —
 * restorable via POST :id/restore. Permanent delete (row + speaker mappings
 * + shares via FK cascade + AAI transcript + audio files) happens when the
 * row is already in the trash, when it's a placeholder (`up-…`/`defer-…` —
 * nothing worth keeping), or on ?permanent=1.
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can delete' }, { status: 403 });
  }

  const isPlaceholder = access.row.status === 'uploading' || access.row.status === 'waiting';
  const permanent =
    isPlaceholder ||
    !!access.row.deleted_at ||
    new URL(request.url).searchParams.get('permanent') === '1';
  if (!permanent) {
    await softDeleteForUser(access.ownerUserId, id);
    return NextResponse.json({ ok: true, trashed: true });
  }

  await aaiDelete(id);
  await deleteSpeakerMappingsForUser(access.ownerUserId, id);
  await deleteForUser(access.ownerUserId, id);
  if (access.row.local_audio_path) {
    await deleteAudioFile(access.row.local_audio_path);
  }
  // Extra recording segments (multi-video meetings) live in sidecar files.
  for (const part of access.row.gmeet_context?.videoParts ?? []) {
    if (part.filename) await deleteAudioFile(part.filename);
  }

  return NextResponse.json({ ok: true });
});
