import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

export const runtime = 'nodejs';

/**
 * GET /api/offline/badge — the number the installed app shows on its icon
 * (tech-debt C2; client: src/lib/offline/app-badge.tsx).
 *
 * Counts the caller's OWN meetings that are transcribed and waiting for the
 * human step — speaker review before notes generate (auto_notes_status
 * still null, speaker-ID pass finished or never scheduled). Trash and
 * temporary rows are excluded, and anything older than WINDOW_DAYS is not
 * nagged about forever. Cheap: one count, no joins.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const WINDOW_DAYS = 30;

export const GET = withAuth(async ({ user }) => {
  const [row] = await sql<Array<{ review: number }>>`
    SELECT count(*)::int AS review
    FROM ${sql(SCHEMA)}.transcripts
    WHERE user_id = ${user.userId}
      AND status = 'completed'
      AND deleted_at IS NULL
      AND NOT scratch
      AND auto_notes_status IS NULL
      AND (speaker_id_status = 'completed' OR speaker_id_status IS NULL)
      AND COALESCE(completed_at, created_at) > now() - make_interval(days => ${WINDOW_DAYS})
  `;
  const review = row?.review ?? 0;
  return NextResponse.json(
    { count: review, review, windowDays: WINDOW_DAYS },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
});
