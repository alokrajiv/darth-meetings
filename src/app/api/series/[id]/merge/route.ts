import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';

export const runtime = 'nodejs';

/**
 * POST /api/series/:id/merge — GONE (curated series, 2026-10-06). Series are
 * hand-made now; two that overlap are fixed by editing their patterns or
 * priority, not by folding one into the other.
 */
export const POST = withAuth(async () =>
  NextResponse.json(
    { error: 'Series merge is gone — curated series are edited (patterns / priority), not merged' },
    { status: 410 }
  )
);
