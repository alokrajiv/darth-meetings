import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { validatePatterns } from '@/lib/series-patterns';
import { previewPatterns } from '@/lib/server/curated-series';
import { isAuditor } from '@/db-ops/auditors';
import { parseSeriesId, seriesForCaller } from '@/lib/server/series-api';

export const runtime = 'nodejs';

/**
 * POST /api/series/preview { patterns, seriesId? } → { matched, visibleToYou, sample }
 *
 * What would these patterns catch — within a REACH (§11.6), never org-wide:
 *  - by default the CALLER's own reach: the meetings they can open (an
 *    auditor's: every meeting), so `matched` == `visibleToYou` for most
 *    people and the answer is no oracle;
 *  - with `seriesId` of a series the caller OWNS or EDITS: that series'
 *    OWNER's reach — an editor may know what the series matches. Any other
 *    seriesId → 404 (a series the caller cannot see does not exist), or the
 *    caller's own reach for a follower/auditor who cannot edit it.
 * `sample` names only meetings the CALLER can open, whatever the reach.
 * Raw matches: "not this series" answers are not applied.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: { patterns?: unknown; seriesId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const v = validatePatterns(body.patterns ?? []);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };

  let reach = {
    ownerUserId: user.userId as string | null,
    ownerEmail: user.email.trim().toLowerCase() as string | null,
    ownerIsAuditor: await isAuditor(user.email),
  };
  let reachOf: 'you' | 'owner' = 'you';
  if (body.seriesId !== undefined && body.seriesId !== null) {
    const id = parseSeriesId(String(body.seriesId));
    if (!id) return NextResponse.json({ error: 'Bad seriesId' }, { status: 400 });
    const ctx = await seriesForCaller(id, caller);
    if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (ctx.deco.permissions.edit) {
      reach = {
        ownerUserId: ctx.series.owner_user_id,
        ownerEmail: ctx.series.owner_email,
        ownerIsAuditor: ctx.facts.ownerIsAuditor,
      };
      reachOf = 'owner';
    }
  }
  if (v.patterns.length === 0) {
    return NextResponse.json({ matched: 0, visibleToYou: 0, sample: [], reachOf });
  }
  const r = await previewPatterns(v.patterns, reach, caller);
  return NextResponse.json({ ...r, reachOf });
});
