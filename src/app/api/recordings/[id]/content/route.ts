import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  getStandaloneForOwner,
  getStandalonePayloadForOwner,
  standaloneColumnsExist,
} from '@/db-ops/standalone-recordings';

export const runtime = 'nodejs';

/**
 * `GET /api/recordings/:id/content` — the recording's transcription payload
 * (AssemblyAI's response, verbatim: text, words, diarised utterances), for
 * its OWNER only (arm a; everyone else 404 — invariant I2). 202 while it is
 * still being transcribed. The recording page reads this; a meeting made from
 * the recording serves the same bytes from `/api/transcripts/:id/content`.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  if (!(await standaloneColumnsExist().catch(() => false))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id } = await params;
  const rec = await getStandaloneForOwner(user.userId, id ?? '');
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const payload = await getStandalonePayloadForOwner(user.userId, rec.id);
  if (!payload) return NextResponse.json({ pending: true }, { status: 202 });
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } });
});
