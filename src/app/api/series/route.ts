import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { addKeys, addMember, createSeries, listSeries, seriesTotals } from '@/db-ops/series';
import { keysFromContext, normalizeTitle } from '@/lib/series-keys';
import { publishEvent } from '@/lib/server/event-bus';

export const runtime = 'nodejs';

export type SeriesCadence = 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;

/** Median inter-occurrence gap → a human cadence label (null = no pattern). */
function cadenceOf(medianGapSecs: number | null): SeriesCadence {
  if (medianGapSecs == null) return null;
  const days = medianGapSecs / 86_400;
  if (days <= 1.5) return 'daily';
  if (days <= 10) return 'weekly';
  if (days <= 20) return 'biweekly';
  if (days <= 45) return 'monthly';
  return null;
}

/**
 * GET /api/series — all series with member counts (org-global), plus
 * cadence, a same-normalized-title dup flag (the merge prompt), and the
 * memberships/unattached totals for the index footer.
 */
export const GET = withAuth(async () => {
  const [series, totals] = await Promise.all([listSeries(), seriesTotals()]);
  const titleCounts = new Map<string, number>();
  for (const s of series) {
    const norm = normalizeTitle(s.title);
    titleCounts.set(norm, (titleCounts.get(norm) ?? 0) + 1);
  }
  return NextResponse.json({
    series: series.map((s) => ({
      ...s,
      cadence: cadenceOf(s.median_gap_secs),
      dup: (titleCounts.get(normalizeTitle(s.title)) ?? 0) > 1,
    })),
    totals,
  });
});

/**
 * POST /api/series — create a series, optionally seeded from a transcript:
 * { title, fromTranscriptId? } where fromTranscriptId is an assemblyai_id
 * the caller can access. Seeding attaches the transcript as a manual member
 * and claims its evidence keys.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: { title?: string; fromTranscriptId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const series = await createSeries(user.userId, title);

  if (body.fromTranscriptId) {
    const access = await resolveAccess(user.userId, user.email, body.fromTranscriptId);
    if (!access) {
      return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
    }
    await addKeys(
      series.id,
      keysFromContext(access.row.gmeet_context, access.row.title),
      'user',
      user.userId
    );
    await addMember(series.id, access.row.id, 'manual', user.userId);
    publishEvent({ kind: 'meta', assemblyaiId: access.row.assemblyai_id });
  }

  return NextResponse.json({ series });
});
