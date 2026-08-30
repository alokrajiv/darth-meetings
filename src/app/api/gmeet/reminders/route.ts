import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  listOpenReminders,
  resolveReminderById,
} from '@/db-ops/gmeet-reminders';
import { addSkip } from '@/db-ops/gmeet-sync';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import { getUserPrefs } from '@/db-ops/user-prefs';

export const runtime = 'nodejs';

/** Open reminders from the background poller, newest meeting first. */
export const GET = withAuth(async ({ user }) => {
  const [allReminders, account, prefs] = await Promise.all([
    listOpenReminders(user.userId),
    getGoogleAccount(user.userId),
    getUserPrefs(user.userId).catch(() => null),
  ]);
  // With account auto-sync on, "not imported yet" is no longer the user's
  // problem — the sweep consumes those rows itself (Alok 2026-08-30: the
  // noise can go). Actionable kinds (auto-record off before a meeting,
  // colleagues needing your import) stay.
  const autoSyncOn = (prefs?.auto_sync ?? 'off') !== 'off';
  const reminders = autoSyncOn ? allReminders.filter((r) => r.kind !== 'unimported') : allReminders;
  return NextResponse.json({
    connected: !!account && account.status !== 'revoked',
    accountStatus: account?.status ?? null,
    lastPollAt: account?.last_poll_at ?? null,
    reminders: reminders.map((r) => ({
      id: r.id,
      kind: r.kind,
      meetingCode: r.meeting_code,
      title: r.title,
      eventStart: r.event_start,
      organizerSelf: r.organizer_self,
      hasRecording: r.has_recording,
      hasTranscript: r.has_transcript,
      firstSeenAt: r.first_seen_at,
    })),
  });
});

/**
 * Act on a reminder: {id, action: 'dismiss' | 'mute'}.
 * dismiss = this occurrence only; mute = never remind about this meeting
 * again (writes a gmeet_sync_skips row, same as muting in the sync dialog).
 */
export const PATCH = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    id?: number;
    action?: string;
    meetingCode?: string | null;
    title?: string | null;
    eventStart?: string | null;
  } | null;
  if (!body || typeof body.id !== 'number' || !['dismiss', 'mute'].includes(body.action ?? '')) {
    return NextResponse.json({ error: 'Expected {id, action: dismiss|mute}' }, { status: 400 });
  }
  if (body.action === 'mute' && body.meetingCode) {
    await addSkip(user.userId, {
      eventKey: body.meetingCode,
      title: body.title ?? null,
      eventStart: body.eventStart ?? null,
    });
  }
  const ok = await resolveReminderById(
    user.userId,
    body.id,
    body.action === 'mute' ? 'muted' : 'dismissed'
  );
  if (!ok) return NextResponse.json({ error: 'Reminder not found or already resolved' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
