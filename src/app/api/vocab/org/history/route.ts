import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { listHistory } from '@/db-ops/org-vocab';

export const runtime = 'nodejs';

/**
 * GET /api/vocab/org/history?limit=&offset=
 *
 * Returns the append-only edit history for the company-wide vocab. Anyone
 * logged in can read this — it's the audit trail for who changed what and
 * when. Useful for diagnostics and as a recovery surface (you can read this
 * via the API or directly in Postgres and re-PUT a previous version's
 * payload to restore it).
 */
export const GET = withAuth(async ({ request }) => {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
  const history = await listHistory(limit, offset);
  return NextResponse.json({ history });
});
