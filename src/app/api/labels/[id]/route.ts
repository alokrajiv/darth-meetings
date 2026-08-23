import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { publishEvent } from '@/lib/server/event-bus';
import { labelErrorResponse, parseIntId, readJson } from '@/lib/server/labels-http';
import { deleteLabel, getLabel, updateLabel, type UpdateLabelPatch } from '@/db-ops/labels';

export const runtime = 'nodejs';

/** GET /api/labels/:id — one label (no counts). */
export const GET = withAuth(async (_ctx, { params }) => {
  const id = parseIntId((await params).id);
  if (id == null) return NextResponse.json({ error: 'Bad label id' }, { status: 400 });
  const label = await getLabel(id);
  if (!label) return NextResponse.json({ error: 'Label not found' }, { status: 404 });
  return NextResponse.json({ label });
});

/**
 * PATCH /api/labels/:id — `{name?, parentId?: number|null, color?, description?}`.
 * Rename, move and meta run in ONE transaction (rename → move → meta), so a
 * 4xx from any step leaves nothing written; returns `{label, updated:[{id,path}]}`
 * (every subtree row rewritten, final paths). 409 on cycle / duplicate
 * sibling / depth overflow.
 */
export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const id = parseIntId((await params).id);
  if (id == null) return NextResponse.json({ error: 'Bad label id' }, { status: 400 });
  const body = await readJson(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const actor = { userId: user.userId, email: user.email };
  const hasName = body.name !== undefined;
  const hasParent = body.parentId !== undefined;
  const hasMeta = body.color !== undefined || body.description !== undefined;
  if (!hasName && !hasParent && !hasMeta) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }
  const patch: UpdateLabelPatch = {};
  if (hasName) {
    if (typeof body.name !== 'string') return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
    patch.name = body.name;
  }
  if (hasParent) {
    if (body.parentId === null) {
      patch.parentId = null;
    } else {
      const parentId = parseIntId(body.parentId);
      if (parentId == null) return NextResponse.json({ error: 'parentId must be a positive integer or null' }, { status: 400 });
      patch.parentId = parentId;
    }
  }
  if (body.color !== undefined) patch.color = body.color as string | null;
  if (body.description !== undefined) patch.description = body.description as string | null;
  try {
    const { label, updated } = await updateLabel(id, patch, actor);
    publishEvent({ kind: 'labels' });
    return NextResponse.json({ label, updated });
  } catch (err) {
    const mapped = labelErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});

/**
 * DELETE /api/labels/:id[?cascade=1] — 409 when it has sub-labels and
 * cascade is off. Assignments go with the label (FK cascade).
 */
export const DELETE = withAuth(async ({ user, request }, { params }) => {
  const id = parseIntId((await params).id);
  if (id == null) return NextResponse.json({ error: 'Bad label id' }, { status: 400 });
  const c = new URL(request.url).searchParams.get('cascade');
  const cascade = c === '1' || c === 'true';
  try {
    const r = await deleteLabel(id, cascade, { userId: user.userId, email: user.email });
    // One archive-wide event for the taxonomy change, plus one per affected
    // transcript so open detail pages drop the chip.
    publishEvent({ kind: 'labels' });
    for (const aid of r.affectedTranscripts) publishEvent({ kind: 'labels', assemblyaiId: aid });
    return NextResponse.json({
      ok: true,
      removedAssignments: r.removedAssignments,
      removedLabels: r.removedLabels,
    });
  } catch (err) {
    const mapped = labelErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
