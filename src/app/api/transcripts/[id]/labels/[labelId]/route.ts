import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { publishEvent } from '@/lib/server/event-bus';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { parseIntId } from '@/lib/server/labels-http';
import { getLabel, listForTranscript, removeAssignment } from '@/db-ops/labels';

export const runtime = 'nodejs';

/**
 * DELETE /api/transcripts/:id/labels/:labelId — unassign (owner or editor);
 * idempotent, answers `{labels}` (the remaining set). Readers → 403.
 */
export const DELETE = withAuth(async ({ user }, { params }) => {
  const { id, labelId: rawLabelId } = await params;
  const labelId = parseIntId(rawLabelId);
  if (labelId == null) return NextResponse.json({ error: 'Bad label id' }, { status: 400 });
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access !== 'owner' && access.access !== 'edit') {
    return NextResponse.json(
      { error: 'Read-only access: only the owner or an editor can change labels' },
      { status: 403 }
    );
  }
  const label = await getLabel(labelId);
  const { removed } = await removeAssignment(access.row.id, labelId);
  if (removed) {
    await logActivity({
      transcriptId: access.row.id,
      userId: user.userId,
      email: user.email,
      action: 'label_remove',
      details: { label_id: labelId, path: label?.path ?? null },
    });
    publishEvent({ kind: 'labels', assemblyaiId: id });
  }
  const labels = await listForTranscript(access.row.id);
  return NextResponse.json({ labels });
});
