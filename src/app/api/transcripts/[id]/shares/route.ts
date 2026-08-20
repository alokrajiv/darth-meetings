import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { notifyUser } from '@/lib/server/darth-notify';
import { resolveAccess } from '@/db-ops/transcript-access';
import { identityForUser, logActivity, userIdForEmail } from '@/db-ops/transcript-activity';
import {
  addShare,
  listByTranscript,
  removeShare,
  transferOwnership,
  updateAccess,
} from '@/db-ops/transcript-shares';

export const runtime = 'nodejs';

// Share management for a single transcript.
//   GET    — list collaborators + owner identity (any access)
//   POST   — add a collaborator (owner or editor)
//   PATCH  — update a collaborator's access level (owner or editor), or
//            transfer ownership with access: 'owner' (owner only)
//   DELETE — remove a collaborator (owner or editor)

function canManageShares(access: string): boolean {
  return access === 'owner' || access === 'edit';
}

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

  const [shares, ownerIdentity] = await Promise.all([
    listByTranscript(access.row.id),
    identityForUser(access.ownerUserId),
  ]);
  return NextResponse.json({
    shares,
    owner: {
      email: ownerIdentity?.email ?? null,
      name: ownerIdentity?.name ?? null,
      isMe: access.access === 'owner',
    },
  });
});

export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canManageShares(access.access)) {
    return NextResponse.json({ error: 'Only the owner or an editor can share' }, { status: 403 });
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

  // Editors can share, so "yourself" no longer implies "the owner" — block
  // adding the owner as a collaborator explicitly.
  const ownerIdentity = await identityForUser(access.ownerUserId);
  if (ownerIdentity && normalized === ownerIdentity.email.trim().toLowerCase()) {
    return NextResponse.json(
      { error: 'That person already owns this transcript' },
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

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'share_add',
    details: { withEmail: normalized, accessLevel: requestedAccess },
  });

  // Slack-DM the recipient — deliberate human shares only (auto-share on
  // import stays silent by design). addShare is an upsert: a fresh INSERT has
  // shared_at === updated_at, an access-level bump does not — only the former
  // notifies, and the dedupe key means at most one DM ever per (transcript,
  // recipient). Fire-and-forget: the share result never waits on this.
  if (new Date(share.shared_at as unknown as string).getTime() === new Date(share.updated_at as unknown as string).getTime()) {
    const title = access.row.title?.trim() || 'Untitled meeting';
    void notifyUser({
      kind: 'share',
      toEmail: normalized,
      text: `*${user.email}* shared a meeting with you: *${title}* → <https://meetings.darth-internal.trames.io/transcript/${access.row.assemblyai_id}|open>`,
      dedupeKey: `mw-share:${access.row.id}:${normalized}`,
      onBehalfOf: user.userId,
    });
  }

  return NextResponse.json({ share }, { status: 201 });
});

export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canManageShares(access.access)) {
    return NextResponse.json(
      { error: 'Only the owner or an editor can change access' },
      { status: 403 }
    );
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

  if (requestedAccess === 'owner') {
    if (access.access !== 'owner') {
      return NextResponse.json(
        { error: 'Only the owner can transfer ownership' },
        { status: 403 }
      );
    }

    const normalized = email.trim().toLowerCase();
    const shares = await listByTranscript(access.row.id);
    const target = shares.find((s) => s.shared_with_email.toLowerCase() === normalized);
    if (!target) {
      return NextResponse.json(
        { error: 'Share the transcript with them first, then transfer ownership' },
        { status: 404 }
      );
    }

    const newOwnerUserId = await userIdForEmail(normalized);
    if (!newOwnerUserId) {
      return NextResponse.json(
        { error: "They haven't opened Darth Meetings yet, so ownership can't be transferred to them" },
        { status: 400 }
      );
    }

    const me = await identityForUser(user.userId);
    const result = await transferOwnership({
      transcriptRowId: access.row.id,
      assemblyaiId: id,
      oldOwnerUserId: access.ownerUserId,
      oldOwnerEmail: user.email,
      oldOwnerName: me?.name ?? null,
      newOwnerUserId,
      newOwnerEmail: normalized,
    });
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    void logActivity({
      transcriptId: access.row.id,
      userId: user.userId,
      email: user.email,
      action: 'owner_transfer',
      details: { toEmail: normalized },
    });

    return NextResponse.json({ transferred: true });
  }

  if (!isValidAccess(requestedAccess)) {
    return NextResponse.json({ error: 'access must be "edit" or "read"' }, { status: 400 });
  }

  const share = await updateAccess(access.row.id, email, requestedAccess);
  if (!share) {
    return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  }

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'share_update',
    details: { withEmail: email.toLowerCase(), accessLevel: requestedAccess },
  });

  return NextResponse.json({ share });
});

export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canManageShares(access.access)) {
    return NextResponse.json(
      { error: 'Only the owner or an editor can remove shares' },
      { status: 403 }
    );
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

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'share_remove',
    details: { withEmail: email.toLowerCase() },
  });

  return NextResponse.json({ ok: true });
});
