import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';

export const runtime = 'nodejs';

/**
 * POST /api/series/retro-attach — GONE (curated series, 2026-10-06). The
 * membership engine re-matches every meeting after each series edit and
 * every 10 minutes (lib/server/curated-series rematchAll).
 */
export const POST = withAuth(async () =>
  NextResponse.json(
    { error: 'Retro-attach is gone — curated series re-match every meeting on their own' },
    { status: 410 }
  )
);
