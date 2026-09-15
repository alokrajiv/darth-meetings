import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { callerInvolvedInOccurrence } from '@/db-ops/calendar-event-cache';
import {
  claimNudge,
  getRecordingAnyOwner,
  NUDGE_WINDOW_H,
  releaseNudge,
} from '@/db-ops/recorder';
import { APP_URL, sendDarthDm } from '@/lib/server/darth-notify';
import { dm, meetingLine } from '@/lib/server/dm-copy';
import { recorderOwnerFirstName } from '@/lib/recorder';
import { UUID_RE } from '@/lib/server/recorder-view';

export const runtime = 'nodejs';

/**
 * POST /api/recorder/recordings/:id/nudge — "Ask to upload".
 *
 * The recording sits on a colleague's Mac; only they can upload it. This
 * sends them ONE Darth DM (house style, src/lib/server/dm-copy) and is rate
 * limited to one per (recording, requester) per 6 h — the ask is legitimately
 * repeatable tomorrow, so a permanent notify dedupe_key would be wrong.
 *
 * CALLER-SCOPING GATE: the requester must be involved in the occurrence the
 * recording matched (their own calendar row / organizer / invitee). Without a
 * match there is nothing to be involved in → 404, same answer an outsider
 * gets, so the route never confirms a recording they may not know about.
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rec = await getRecordingAnyOwner(id);
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const mine = rec.user_id === user.userId;
  if (!mine) {
    const code = rec.matched?.meeting_code ?? null;
    const involved = code
      ? await callerInvolvedInOccurrence(
          { userId: user.userId, email: user.email },
          code,
          rec.matched?.occ_start ?? null
        )
      : false;
    if (!involved) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (rec.status === 'uploaded' && rec.transcript_id) {
    return NextResponse.json(
      { error: 'That recording is already uploaded', transcript_id: rec.transcript_id },
      { status: 409 }
    );
  }
  const toEmail = rec.email;
  if (!toEmail) {
    return NextResponse.json(
      { error: 'We do not know the owner’s email for that recording yet' },
      { status: 409 }
    );
  }

  const claim = await claimNudge(id, { userId: user.userId, email: user.email });
  if (!claim.claimed) {
    const next = new Date(new Date(claim.sentAt).getTime() + NUDGE_WINDOW_H * 3600_000);
    return NextResponse.json(
      {
        error: `You already asked about this recording — one nudge per ${NUDGE_WINDOW_H} h`,
        sent_at: claim.sentAt,
        next_allowed_at: next.toISOString(),
      },
      { status: 429 }
    );
  }

  const asker = recorderOwnerFirstName(user.email);
  const title = rec.matched?.title ?? rec.call?.title ?? 'a call';
  const text = dm(
    `🎥 *${asker} is asking for a recording on your Mac*`,
    meetingLine({
      title: rec.matched?.title ?? rec.call?.title ?? null,
      when: rec.matched?.occ_start ?? rec.started_at,
      duration: rec.duration_s,
    }),
    `Darth Recorder still has it locally — open the tray and hit Upload, and it transcribes itself.`,
    `<${APP_URL}/settings#recorder|Open Darth Recorder settings>`
  );

  try {
    await sendDarthDm({ toEmail, text, onBehalfOf: user.userId });
  } catch (err) {
    await releaseNudge(id, user.userId).catch(() => {});
    console.error('[recorder] nudge DM failed:', err);
    return NextResponse.json({ error: 'Could not send the DM' }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    to: toEmail,
    about: title,
    sent_at: claim.sentAt,
    next_allowed_at: new Date(new Date(claim.sentAt).getTime() + NUDGE_WINDOW_H * 3600_000).toISOString(),
  });
});
