import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getOwnRecording,
  lastNudgeAt,
  listOwnRecordings,
  recordingOwnerOf,
  recordingsForOccurrence,
  upsertRecording,
} from '@/db-ops/recorder';
import { matchForWrite, resolveOccurrenceRef } from '@/lib/server/recorder-match';
import {
  ownView,
  othersView,
  parseRecordingWrite,
  UUID_RE,
  type RecordingView,
} from '@/lib/server/recorder-view';

export const runtime = 'nodejs';

/**
 * The Darth Recorder recordings registry (docs/recorder-beta-plan.md, S1).
 *
 * POST — insert-or-update one recording, owner = caller. The tray mints the
 * uuid at recording start and addresses the same row for every later update.
 * `matchRecording()` runs on every write and stores `matched`.
 *
 * GET ?mine=1 — the caller's own recordings (full detail, local paths and
 * all).
 * GET ?event=<ref> — recordings OF THAT OCCURRENCE the caller may know
 * about. CALLER-SCOPING GATE: the caller must be involved in the occurrence
 * (own calendar row / organizer / invitee — callerInvolvedCodes); anything
 * else answers with an empty list. Recordings that are not the caller's are
 * redacted to existence + owner email + status (no paths, no window titles)
 * — see lib/server/recorder-view.
 */

export const GET = withAuth(async ({ user, request }) => {
  const params = request.nextUrl.searchParams;
  const eventRef = params.get('event');

  if (eventRef) {
    const occ = await resolveOccurrenceRef({ userId: user.userId, email: user.email }, eventRef);
    if (!occ || !occ.code) {
      return NextResponse.json(
        { error: 'event must be a meeting code, "<code>|<startIso>" or a calendar event key' },
        { status: 400 }
      );
    }
    // Not involved → the occurrence simply has no recordings as far as this
    // caller is concerned. Never 403: that would confirm one exists.
    if (!occ.involved) {
      return NextResponse.json({ recordings: [], occurrence: { code: occ.code, instant: occ.instant } });
    }
    const rows = await recordingsForOccurrence(occ.code, occ.instant);
    const othersIds = rows.filter((r) => r.user_id !== user.userId).map((r) => r.id);
    const nudges = await lastNudgeAt(othersIds, user.userId);
    const recordings: RecordingView[] = rows.map((r) =>
      r.user_id === user.userId ? ownView(r) : othersView(r, nudges.get(r.id) ?? null)
    );
    return NextResponse.json({
      recordings,
      occurrence: { code: occ.code, instant: occ.instant, title: occ.title },
    });
  }

  if (params.get('mine') === '1') {
    const rows = await listOwnRecordings(user.userId);
    return NextResponse.json({ recordings: rows.map(ownView) });
  }

  return NextResponse.json(
    { error: 'Expected ?mine=1 or ?event=<meeting code | occurrence key | event key>' },
    { status: 400 }
  );
});

export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'id must be a uuid minted by the recorder' }, { status: 400 });
  }
  const parsed = parseRecordingWrite(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const owner = await recordingOwnerOf(id);
  if (owner && owner !== user.userId) {
    return NextResponse.json({ error: 'That recording id belongs to another user' }, { status: 409 });
  }

  const existing = owner ? await getOwnRecording(user.userId, id) : null;
  const matched = await matchForWrite(user.userId, existing, parsed.write).catch((err) => {
    console.warn('[recorder] match failed:', err);
    return null;
  });

  // A first POST defaults to 'recording'; a repeat POST with no status must
  // not drag a finished recording back to it.
  const write = owner ? parsed.write : { ...parsed.write, status: parsed.write.status ?? 'recording' };
  const row = await upsertRecording(user, id, write, matched);
  if (!row) {
    return NextResponse.json({ error: 'That recording id belongs to another user' }, { status: 409 });
  }
  return NextResponse.json({ recording: ownView(row) }, { status: owner ? 200 : 201 });
});
