import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { claimAutoReview, getForUser } from '@/db-ops/transcripts';
import { autoProceedAt, autoProceedFactsOf } from '@/lib/auto-proceed';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/notes/hold — owner / editor.
 *
 * "Don't write the summary on your own." The detail page shows "Summary
 * starts automatically at HH:MM … Hold" while a manual row is inside the
 * grace window (lib/auto-proceed.ts); Hold stamps
 * `gmeet_context.autoReview = {passed: false, mode: 'held', by}`, which is
 * the one-evaluation marker the sweeper's query excludes — so the human gate
 * stays and the line disappears (`autoProceedAt` reads null from then on).
 *
 * The stamp is the same conditional write the sweeper claims with
 * (`claimAutoReview`: only where no autoReview exists), so a Hold and a
 * sweeper landing in the same minute cannot both win. Losing is a 409 that
 * says why — the summary is being written right now, or was already — except
 * that pressing Hold twice is idempotent (200). Opening the review dialog
 * does NOT hold; only this button does.
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const won = await claimAutoReview(access.ownerUserId, id, {
    evaluatedAt: new Date().toISOString(),
    passed: false,
    mode: 'held',
    reason: 'held on the detail page',
    by: { userId: user.userId, email: user.email },
  });
  const after = (await getForUser(access.ownerUserId, id)) ?? access.row;
  if (!won) {
    const existing = after.gmeet_context?.autoReview;
    if (existing?.mode !== 'held') {
      const why = existing?.pending
        ? 'The summary is being written right now.'
        : existing?.passed
          ? 'The summary was already written automatically.'
          : 'The automatic pass already ran on this meeting; the review gate stays.';
      return NextResponse.json({ error: `${why} Nothing left to hold.` }, { status: 409 });
    }
  }
  return NextResponse.json({
    ok: true,
    held: true,
    autoProceedAt: autoProceedAt(autoProceedFactsOf(after)),
  });
});
