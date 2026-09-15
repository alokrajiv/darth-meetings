import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getOwnRecording, upsertRecording } from '@/db-ops/recorder';
import { matchForWrite } from '@/lib/server/recorder-match';
import { ownView, parseRecordingWrite, UUID_RE } from '@/lib/server/recorder-view';

export const runtime = 'nodejs';

/**
 * GET  /api/recorder/recordings/:id — the caller's own recording, full detail.
 * PATCH /api/recorder/recordings/:id — partial update (segments, bytes, stop,
 * upload state). Owner-only: a recording that is not the caller's is a 404,
 * not a 403. `matchRecording()` re-runs on every write with the merged
 * before/after values and overwrites `matched`.
 */

export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const row = await getOwnRecording(user.userId, id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ recording: ownView(row) });
});

export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const existing = await getOwnRecording(user.userId, id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const parsed = parseRecordingWrite(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const matched = await matchForWrite(user.userId, existing, parsed.write).catch((err) => {
    console.warn('[recorder] match failed:', err);
    return null;
  });

  const row = await upsertRecording(user, id, parsed.write, matched);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ recording: ownView(row) });
});
