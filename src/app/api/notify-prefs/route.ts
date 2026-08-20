import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getNotifyPrefs,
  setNotifyPrefs,
  NOTIFY_KINDS,
  NOTIFY_KIND_LABELS,
  type NotifyPrefs,
} from '@/db-ops/notify-prefs';

export const runtime = 'nodejs';

/** GET /api/notify-prefs — the caller's Slack DM notification switches. */
export const GET = withAuth(async ({ user }) => {
  const prefs = await getNotifyPrefs(user.email);
  return NextResponse.json({ prefs, kinds: NOTIFY_KINDS, labels: NOTIFY_KIND_LABELS });
});

/** PUT /api/notify-prefs — partial update, body { prefs: { kind: bool } }. */
export const PUT = withAuth(async ({ user, request }) => {
  let body: { prefs?: Partial<NotifyPrefs> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.prefs || typeof body.prefs !== 'object') {
    return NextResponse.json({ error: 'prefs object required' }, { status: 400 });
  }
  const prefs = await setNotifyPrefs(user.email, body.prefs);
  return NextResponse.json({ prefs });
});
