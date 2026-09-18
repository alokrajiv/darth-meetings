import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { publishEvent } from '@/lib/server/event-bus';
import { labelErrorResponse, parseIntId, readJson } from '@/lib/server/labels-http';
import {
  createLabel,
  listLabels,
  listLabelsWithCounts,
  resolveOrCreatePath,
} from '@/db-ops/labels';

export const runtime = 'nodejs';

/**
 * GET /api/labels[?counts=1] — the org-wide catalog, flat, sorted by path_key
 * (client builds the tree). With counts=1 every row carries count_visible
 * (subtree-inclusive) + count_direct scoped to the caller's visible
 * transcripts, and the envelope adds `unlabelled` + `total` for the rail's
 * pseudo-nodes (docs/labels-design.md §7).
 */
export const GET = withAuth(async ({ user, request }) => {
  const counts = new URL(request.url).searchParams.get('counts') === '1';
  if (!counts) {
    return NextResponse.json({ labels: await listLabels({ userId: user.userId, email: user.email }) });
  }
  const res = await listLabelsWithCounts(user.userId, user.email);
  return NextResponse.json(res);
});

/**
 * POST /api/labels — `{path}` (creates the whole chain) or `{name, parentId?}`,
 * plus optional `color`. Returns `{label, created:[…]}`; 200 with created=[]
 * when it already existed (case-insensitive).
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = await readJson(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const color = body.color === undefined ? undefined : (body.color as string | null);
  const actor = { userId: user.userId, email: user.email };
  try {
    let result;
    if (typeof body.path === 'string') {
      result = await resolveOrCreatePath(body.path, actor, { color });
    } else if (typeof body.name === 'string') {
      let parentId: number | null = null;
      if (body.parentId !== undefined && body.parentId !== null) {
        parentId = parseIntId(body.parentId);
        if (parentId == null) return NextResponse.json({ error: 'parentId must be a positive integer' }, { status: 400 });
      }
      result = await createLabel({ name: body.name, parentId, color }, actor);
    } else {
      return NextResponse.json({ error: 'Provide path or name' }, { status: 400 });
    }
    if (result.created.length > 0) publishEvent({ kind: 'labels' });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = labelErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
