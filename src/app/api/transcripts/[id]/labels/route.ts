import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { publishEvent } from '@/lib/server/event-bus';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { labelErrorResponse, parseIntId, readJson } from '@/lib/server/labels-http';
import {
  addAssignment,
  getLabel,
  listForTranscript,
  resolveOrCreatePath,
  type LabelDbRow,
} from '@/db-ops/labels';

export const runtime = 'nodejs';

// Labels ON one transcript (docs/labels-design.md §3/§7).
//   GET  — {labels, canEdit}; anyone who can see the transcript
//   POST — {labelId} | {path} (creates the chain) → {labels}; owner or editor
//          (mirrors canManageShares); readers get 403 but still see chips.

function canEditLabels(access: string): boolean {
  return access === 'owner' || access === 'edit';
}

export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const labels = await listForTranscript(access.row.id);
  return NextResponse.json({ labels, canEdit: canEditLabels(access.access) });
});

export const POST = withAuth(async ({ user, request, cliScope }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canEditLabels(access.access)) {
    return NextResponse.json(
      { error: 'Read-only access: only the owner or an editor can change labels' },
      { status: 403 }
    );
  }
  const body = await readJson(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const actor = { userId: user.userId, email: user.email };
  try {
    let label: LabelDbRow | null = null;
    if (body.labelId !== undefined) {
      const labelId = parseIntId(body.labelId);
      if (labelId == null) return NextResponse.json({ error: 'labelId must be a positive integer' }, { status: 400 });
      label = await getLabel(labelId);
      if (!label) return NextResponse.json({ error: 'Label not found' }, { status: 404 });
    } else if (typeof body.path === 'string') {
      const r = await resolveOrCreatePath(body.path, actor);
      label = r.label;
      if (r.created.length > 0) publishEvent({ kind: 'labels' });
    } else {
      return NextResponse.json({ error: 'Provide labelId or path' }, { status: 400 });
    }
    const { inserted } = await addAssignment(access.row.id, label.id, actor, cliScope ? 'cli' : 'manual');
    if (inserted) {
      await logActivity({
        transcriptId: access.row.id,
        userId: user.userId,
        email: user.email,
        action: 'label_add',
        details: { label_id: label.id, path: label.path },
      });
      publishEvent({ kind: 'labels', assemblyaiId: id });
    }
    const labels = await listForTranscript(access.row.id);
    return NextResponse.json({ labels });
  } catch (err) {
    const mapped = labelErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
