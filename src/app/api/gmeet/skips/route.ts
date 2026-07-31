import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { addSkip, getSyncState, removeSkip } from '@/db-ops/gmeet-sync';

export const runtime = 'nodejs';

/**
 * POST /api/gmeet/skips — mute an event ("never sync this").
 * Body: { eventKey: string, title?: string, eventStart?: ISO string }
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    eventKey?: string;
    title?: string;
    eventStart?: string;
  } | null;
  const eventKey = body?.eventKey?.trim();
  if (!eventKey) {
    return NextResponse.json({ error: 'eventKey required' }, { status: 400 });
  }
  await addSkip(user.userId, {
    eventKey: eventKey.slice(0, 200),
    title: body?.title?.slice(0, 300) ?? null,
    eventStart: body?.eventStart ?? null,
  });
  const state = await getSyncState(user.userId);
  return NextResponse.json(state);
});

/**
 * DELETE /api/gmeet/skips?eventKey=... — unmute.
 */
export const DELETE = withAuth(async ({ user, request }) => {
  const eventKey = new URL(request.url).searchParams.get('eventKey')?.trim();
  if (!eventKey) {
    return NextResponse.json({ error: 'eventKey required' }, { status: 400 });
  }
  await removeSkip(user.userId, eventKey);
  const state = await getSyncState(user.userId);
  return NextResponse.json(state);
});
