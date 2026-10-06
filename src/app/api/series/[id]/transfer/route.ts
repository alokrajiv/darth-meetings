import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { canTransferTo } from '@/lib/series-permissions';
import { transferSeries } from '@/lib/server/curated-series';
import { identityForUser, userIdForEmail } from '@/db-ops/transcript-activity';
import { isInternalEmail, parsePerson, parseSeriesId, seriesForCaller } from '@/lib/server/series-api';

export const runtime = 'nodejs';
// The new owner's reach is re-matched over every meeting.
export const maxDuration = 120;

/**
 * POST /api/series/:id/transfer { email, name? } — hand the series to a new
 * owner (§11.1): an existing editor or any company person who has opened
 * Darth Meetings (their user id is how "meetings they own" is known). The
 * old owner becomes an editor. The OWNER only — 404 for a caller who cannot
 * see the series, 403 for anyone else. Making an AUDITOR the owner (the
 * series then reaches every meeting) can only be done BY an auditor, and
 * only when every editor afterwards is an auditor too (400). Reach changes
 * with the owner: every meeting is re-matched.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const p = parsePerson(body);
  if (!p || !isInternalEmail(p.email)) {
    return NextResponse.json({ error: 'a company email address is required' }, { status: 400 });
  }
  if (p.email === ctx.series.owner_email) {
    return NextResponse.json({ error: 'They already own this series' }, { status: 400 });
  }
  const targetIsAuditor = ctx.auditors.has(p.email);
  // Editors after the transfer: today's minus the new owner, plus the old owner.
  const after = new Set(ctx.facts.editorEmails.filter((e) => e !== p.email));
  if (ctx.series.owner_email) after.add(ctx.series.owner_email);
  const nonAuditorEditorsAfter = [...after].filter((e) => !ctx.auditors.has(e)).length;
  const verdict = canTransferTo(
    ctx.facts,
    { callerEmail: user.email, callerUserId: user.userId, callerIsAuditor: ctx.callerIsAuditor },
    { isAuditor: targetIsAuditor, nonAuditorEditorsAfter }
  );
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  const toUserId = await userIdForEmail(p.email);
  if (!toUserId) {
    return NextResponse.json(
      { error: "They haven't opened Darth Meetings yet, so the series can't be handed to them" },
      { status: 400 }
    );
  }
  const me = await identityForUser(user.userId).catch(() => null);
  await transferSeries(
    id,
    { userId: toUserId, email: p.email, name: p.name },
    { email: ctx.series.owner_email, name: me?.name ?? null },
    user.email
  );
  console.log(`[series] #${id} "${ctx.series.title}": ${user.email} transferred ownership to ${p.email}`);
  return NextResponse.json({ ok: true });
});
