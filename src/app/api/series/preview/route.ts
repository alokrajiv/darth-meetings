import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { validatePatterns } from '@/lib/series-patterns';
import { previewPatterns } from '@/lib/server/curated-series';

export const runtime = 'nodejs';

/**
 * POST /api/series/preview { patterns } → { matched, visibleToYou, sample }
 *
 * What would these patterns catch? `matched` is the org-wide count and it is
 * a NUMBER ONLY — no title, date or id of a meeting the caller cannot open
 * ever leaves this route (spec §6). `sample` = up to 10 of the caller's own
 * or shared meetings that match, newest first. Raw matches: priority and
 * "not this series" answers are not applied.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: { patterns?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const v = validatePatterns(body.patterns ?? []);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (v.patterns.length === 0) return NextResponse.json({ matched: 0, visibleToYou: 0, sample: [] });
  return NextResponse.json(await previewPatterns(v.patterns, { userId: user.userId, email: user.email }));
});
