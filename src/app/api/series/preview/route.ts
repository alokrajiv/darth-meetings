import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { validatePatterns } from '@/lib/series-patterns';
import { previewPatterns } from '@/lib/server/curated-series';
import { isAuditorEmail } from '@/lib/auditor-policy';

export const runtime = 'nodejs';

/**
 * POST /api/series/preview { patterns } → { matched, visibleToYou, sample }
 *
 * What would these patterns catch? `sample` = up to 10 of the caller's own
 * or shared meetings that match, newest first; `visibleToYou` counts them.
 * `matched` — the ORG-WIDE count — goes to auditors only (null for everyone
 * else): an arbitrary regex plus a global count is an oracle ("is there a
 * meeting titled `alok <> terence`?"), and metadata is the leak
 * (.agent-memory/feedback_privacy_caller_scoping_gate.md). Raw matches:
 * priority and "not this series" answers are not applied.
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
  if (v.patterns.length === 0) {
    return NextResponse.json({ matched: isAuditorEmail(user.email) ? 0 : null, visibleToYou: 0, sample: [] });
  }
  const r = await previewPatterns(v.patterns, { userId: user.userId, email: user.email });
  return NextResponse.json({ ...r, matched: isAuditorEmail(user.email) ? r.matched : null });
});
