import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import {
  addShare,
  listByTranscript,
  removeShare,
  updateAccess,
} from '@/db-ops/transcript-shares';

export const runtime = 'nodejs';

// Share management for a single transcript.
//   GET    — list collaborators (any access)
//   POST   — add a collaborator (owner only)
//   PATCH  — update a collaborator's access level (owner only)
//   DELETE — remove a collaborator (owner only)

function isValidAccess(value: unknown): value is 'edit' | 'read' {
  return value === 'edit' || value === 'read';
}

function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.includes('@');
}

export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const shares = await listByTranscript(access.row.id);
  return NextResponse.json({ shares });
});

export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can share' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email, name, pplId, access: requestedAccess } = (body ?? {}) as {
    email?: unknown;
    name?: unknown;
    pplId?: unknown;
    access?: unknown;
  };

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }
  if (!isValidAccess(requestedAccess)) {
    return NextResponse.json({ error: 'access must be "edit" or "read"' }, { status: 400 });
  }

  const normalized = email.trim().toLowerCase();
  if (normalized === user.email.trim().toLowerCase()) {
    return NextResponse.json(
      { error: "You can't share a transcript with yourself" },
      { status: 400 }
    );
  }

  const share = await addShare({
    transcriptId: access.row.id,
    ownerUserId: access.ownerUserId,
    sharedByUserId: user.userId,
    sharedWithEmail: normalized,
    sharedWithName: typeof name === 'string' && name.length > 0 ? name : null,
    sharedWithPplId: typeof pplId === 'number' ? pplId : null,
    access: requestedAccess,
  });

  return NextResponse.json({ share }, { status: 201 });
});

export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can change access' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email, access: requestedAccess } = (body ?? {}) as {
    email?: unknown;
    access?: unknown;
  };

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }
  if (!isValidAccess(requestedAccess)) {
    return NextResponse.json({ error: 'access must be "edit" or "read"' }, { status: 400 });
  }

  const share = await updateAccess(access.row.id, email, requestedAccess);
  if (!share) {
    return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  }
  return NextResponse.json({ share });
});

export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can remove shares' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email } = (body ?? {}) as { email?: unknown };
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }

  const removed = await removeShare(access.row.id, email);
  if (!removed) {
    return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
});
