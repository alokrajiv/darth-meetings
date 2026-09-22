import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getOwnRecording,
  listOwnRecordings,
  recordingOwnerOf,
  upsertRecording,
} from '@/db-ops/recorder';
import { matchForWrite } from '@/lib/server/recorder-match';
import { ownView, parseRecordingWrite, UUID_RE } from '@/lib/server/recorder-view';

export const runtime = 'nodejs';

/**
 * The Darth Recorder recordings registry (docs/recorder-beta-plan.md, S1).
 *
 * POST — insert-or-update one recording, owner = caller. The tray mints the
 * uuid at recording start and addresses the same row for every later update.
 * `matchRecording()` runs on every write and stores `matched`.
 *
 * GET ?mine=1 — the caller's own recordings (full detail, local paths and
 * all). It is the ONLY listing this route serves.
 *
 * There is no `?event=` form any more (P2,
 * docs/recordings-meetings-series-design.md F2). It listed recordings of any
 * owner for an occurrence the caller was merely involved in, redacted to
 * owner email + state + timings + the meeting id — an exposure of a
 * recording outside any meeting, on the strength of a machine match.
 * Involvement in an occurrence is a gate on the OCCURRENCE; the only gate on
 * a recording is a meeting. A recording someone linked to a meeting the
 * caller can open reaches them through that meeting, as it should.
 */

export const GET = withAuth(async ({ user, request }) => {
  const params = request.nextUrl.searchParams;

  if (params.get('mine') === '1') {
    const rows = await listOwnRecordings(user.userId);
    return NextResponse.json({ recordings: rows.map(ownView) });
  }

  if (params.get('event')) {
    return NextResponse.json(
      {
        error:
          'Recordings are not listed by occurrence. A recording is reachable by its owner (?mine=1), or through a meeting that holds a clip on it.',
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ error: 'Expected ?mine=1' }, { status: 400 });
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
