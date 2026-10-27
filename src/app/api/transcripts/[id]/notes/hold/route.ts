import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getForUser, mergeGmeetContextForUser } from '@/db-ops/transcripts';
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
 * Idempotent: a row already held, or already evaluated and blocked, is left
 * as it is (200). A row the sweeper already wrote the summary for is a 409 —
 * there is nothing left to hold. Opening the review dialog does NOT hold;
 * only this button does.
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const existing = access.row.gmeet_context?.autoReview;
  if (existing?.passed) {
    return NextResponse.json(
      { error: 'The summary was already written automatically — nothing left to hold.' },
      { status: 409 }
    );
  }
  if (!existing) {
    await mergeGmeetContextForUser(access.ownerUserId, id, {
      autoReview: {
        evaluatedAt: new Date().toISOString(),
        passed: false,
        mode: 'held',
        reason: 'held on the detail page',
        by: { userId: user.userId, email: user.email },
      },
    });
  }
  const after = (await getForUser(access.ownerUserId, id)) ?? access.row;
  return NextResponse.json({
    ok: true,
    held: true,
    autoProceedAt: autoProceedAt(autoProceedFactsOf(after)),
  });
});
