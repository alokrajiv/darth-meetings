import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { standaloneColumnsExist } from '@/db-ops/standalone-recordings';
import { deleteRecording, getRecordingView, patchRecording } from '@/lib/server/recording-actions';

export const runtime = 'nodejs';

/**
 * `/api/recordings/:id` — ONE standalone recording, for its OWNER only
 * (design P7, docs/recordings-meetings-series-design.md §4.1).
 *
 * Reachability: arm (a) only — the caller owns it. Anyone else, including a
 * person the meeting made from it is shared with, gets the same 404 as for a
 * recording that does not exist (invariant I2). A reader reaches the bytes
 * through the MEETING (its own media route, or `…/audio` below), never this.
 *
 *   GET     → { recording: RecordingView }
 *   PATCH   { keep?: true, title?: string|null, dismissSuggestedEvent?: true }
 *           → { recording }   (Keep removes the expiry; it stays a recording — Q6)
 *   DELETE  → { ok, deleted }  409 while a meeting (live or trashed) uses it
 */
async function gate(): Promise<NextResponse | null> {
  if (!(await standaloneColumnsExist().catch(() => false))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return null;
}

export const GET = withAuth(async ({ user }, { params }) => {
  const closed = await gate();
  if (closed) return closed;
  const { id } = await params;
  const view = await getRecordingView(user, id ?? '');
  if (!view) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ recording: view });
});

export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const closed = await gate();
  if (closed) return closed;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const out = await patchRecording(user, id ?? '', body);
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status });
  return NextResponse.json(out.body);
});

export const DELETE = withAuth(async ({ user }, { params }) => {
  const closed = await gate();
  if (closed) return closed;
  const { id } = await params;
  const out = await deleteRecording(user, id ?? '');
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status });
  return NextResponse.json(out.body);
});
