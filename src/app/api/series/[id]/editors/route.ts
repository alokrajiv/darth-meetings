import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { canAddEditor, SERIES_MANAGE_DENIED } from '@/lib/series-permissions';
import { addSeriesEditor, removeSeriesEditor } from '@/lib/server/curated-series';
import { isInternalEmail, parsePerson, parseSeriesId, seriesForCaller } from '@/lib/server/series-api';

export const runtime = 'nodejs';

/**
 * POST /api/series/:id/editors { email, name? } — make someone an editor
 * (§11.1: edits the definition, manages editors + followers; never transfers
 * or deletes). Owner and editors only — 404 for a caller who cannot see the
 * series, 403 for one who cannot manage it. Company addresses only. On an
 * AUDITOR-owned series (it reaches every meeting) the new editor must be an
 * auditor too — 400 otherwise.
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
  const verdict = canAddEditor(
    ctx.facts,
    { callerEmail: user.email, callerUserId: user.userId, callerIsAuditor: ctx.callerIsAuditor },
    ctx.auditors.has(p.email)
  );
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  if (ctx.series.owner_email === p.email) {
    return NextResponse.json({ error: 'They already own this series' }, { status: 400 });
  }
  const added = await addSeriesEditor(id, p, user.email);
  console.log(`[series] #${id} "${ctx.series.title}": ${user.email} added editor ${p.email}`);
  return NextResponse.json({ ok: true, added });
});

/**
 * DELETE /api/series/:id/editors?email=… — remove an editor. Owner and
 * editors (an editor may also step down themselves). 404 for a caller who
 * cannot see the series.
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const id = parseSeriesId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const email = (new URL(request.url).searchParams.get('email') ?? '').trim().toLowerCase();
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const ctx = await seriesForCaller(id, caller);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const self = email === user.email.trim().toLowerCase() && ctx.deco.permissions.isEditor;
  if (!ctx.deco.permissions.manageEditors && !self) {
    return NextResponse.json({ error: SERIES_MANAGE_DENIED }, { status: 403 });
  }
  const removed = await removeSeriesEditor(id, email);
  if (!removed) return NextResponse.json({ error: 'Not an editor of this series' }, { status: 404 });
  console.log(`[series] #${id} "${ctx.series.title}": ${user.email} removed editor ${email}`);
  return NextResponse.json({ ok: true });
});
