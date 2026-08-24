import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { sweepSeriesOccurrences, type SeriesOccurrencesResult } from '@/lib/server/series-occurrences';
import { visibleSeriesIds } from '@/db-ops/series';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_IDS = 8;

/**
 * GET /api/series/occurrence-counts?ids=1,2,3 — the occurrence sweep's
 * counts for up to 8 series at once (the /series index's Importable
 * column). Same per-user 6h cache as the dialog sweep, so after the first
 * visit this is instant; the index fetches in small chunks so cells fill
 * progressively instead of one long spinner.
 */
export const GET = withAuth(async ({ user, request }) => {
  const raw = new URL(request.url).searchParams.get('ids') ?? '';
  const ids = [...new Set(raw.split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 });
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `at most ${MAX_IDS} ids per call` }, { status: 400 });
  }
  const caller = { userId: user.userId, email: user.email };
  // PRIVACY GATE (2026-08-24): invisible series report null, same as
  // missing ones — no existence oracle.
  const visible = await visibleSeriesIds(caller);
  const results = await Promise.all(
    ids.map((id) =>
      visible.has(id)
        ? sweepSeriesOccurrences(id, caller).catch((err: unknown) => {
            console.warn(`[series] occurrence-counts sweep failed for ${id}:`, err);
            return 'error' as const;
          })
        : Promise.resolve(null)
    )
  );
  const counts: Record<
    number,
    (SeriesOccurrencesResult['counts'] & { googleConnected: boolean }) | 'error' | null
  > = {};
  ids.forEach((id, i) => {
    const r = results[i];
    counts[id] = r === 'error' ? 'error' : r ? { ...r.counts, googleConnected: r.googleConnected } : null;
  });
  return NextResponse.json({ counts });
});
