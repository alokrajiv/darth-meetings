import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logPayloadMissing } from '@/lib/server/aai-retention';
import { resolveMeetingContent } from '@/lib/server/recordings';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/content
 *
 * Returns the full transcript payload (text, utterances, words). Visible to
 * owners and all collaborators (read or edit). Pure Postgres: the payload is
 * written by whoever observed completion (DEC-4 —
 * docs/recordings-first-class-design.md §7), so there is nothing to fetch and
 * nothing to cache here. A finished row with no payload is a real fault and
 * says so; it is never papered over with a call to AssemblyAI, whose copy is
 * deleted as soon as ours is safe.
 *
 * The payload comes from `resolveMeetingContent` — the meeting's clips over
 * its recordings. In compat (every row today) that IS `imported_content`,
 * returned by reference, so the JSON on the wire is byte-identical whether
 * MW_RECORDINGS is on or off.
 */
/**
 * Freshness after a version switch (Phase 2, landmine #5 — "content is cached
 * forever" was true until now).
 *
 * What the SERVICE WORKER actually does with `/api/…` GETs (public/sw.js
 * `api()`, read 2026-09-22): it keys the cache on path+query and never
 * revalidates — no `If-None-Match`, no `Cache-Control` parsing. ONLINE it is
 * network-first with a 2.5 s cap and RE-STORES whatever comes back, so a
 * swapped payload replaces the cached one on the next load by itself. OFFLINE
 * it is cache-only, and what refreshes a pinned copy is the offline plan's
 * `rev` (db-ops/offline-plan.ts), which hashes `completed_at` + the newest
 * edit/mapping — all three move on a switch, verified in the Phase 2 scratch
 * run rather than assumed. So an ETag is NOT what the worker needs and adding
 * one changes nothing for it.
 *
 * It is still worth sending, for the two actors that are not the worker: the
 * browser's own HTTP cache and any proxy in front of nginx. `no-store` is what
 * keeps them from holding a payload the meeting no longer serves; the ETag
 * makes "which version am I looking at?" answerable from a response header.
 *
 * The tag is the resolver's `rev` — the clips plus the ACTIVE transcription id
 * — AND the row's `completed_at`, because with `MW_RECORDINGS` off the
 * resolver falls back to the row's own columns and its `rev` then describes
 * only the media. `completed_at` is copied from the version being activated,
 * so it moves on every switch on both paths.
 */
function freshnessHeaders(rev: string, completedAt: string | null): Record<string, string> {
  const at = completedAt ? Date.parse(completedAt) : 0;
  return {
    ETag: `W/"${rev}.${Number.isFinite(at) ? at : 0}"`,
    'Cache-Control': 'no-store',
  };
}

export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const resolved = await resolveMeetingContent(access.row);
  if (resolved.content) {
    return NextResponse.json(
      { content: resolved.content },
      { headers: freshnessHeaders(resolved.rev, access.row.completed_at) }
    );
  }

  const status = access.row.status;
  if (status !== 'completed' && status !== 'error') {
    // Still in flight — the detail page only asks once the row reads
    // 'completed', so this is a stale client or a direct caller.
    return NextResponse.json(
      { error: 'Transcript is still being transcribed', status },
      { status: 409 }
    );
  }

  // A failed job legitimately has nothing to serve; only a COMPLETED row
  // with no payload is the fault worth shouting about.
  if (status === 'error') {
    return NextResponse.json({ error: 'Transcription failed — there is no transcript', status }, { status: 404 });
  }

  logPayloadMissing(id, 'GET /api/transcripts/:id/content');
  return NextResponse.json(
    { error: 'Transcript content was never stored for this meeting', status },
    { status: 500 }
  );
});
