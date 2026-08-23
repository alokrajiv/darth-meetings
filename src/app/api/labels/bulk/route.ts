import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { publishEvent } from '@/lib/server/event-bus';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import { labelErrorResponse, parseIntId, readJson } from '@/lib/server/labels-http';
import {
  addAssignment,
  getLabel,
  removeAssignment,
  resolveOrCreatePath,
  type LabelDbRow,
} from '@/db-ops/labels';

export const runtime = 'nodejs';

const MAX_BULK = 500;

/**
 * POST /api/labels/bulk — `{transcriptIds:[aai ids], add:[labelId|path], remove:[labelId]}`.
 * `add` entries are typed, not sniffed: a JSON number is a label id, a
 * string is a display path (so a top-level '2026' is a path, never id 2026).
 * Per-row owner|edit check; partial success is reported, never silent:
 * `{applied, skipped:[{id, reason}]}` where reason is 'not found' or
 * 'read-only'. Paths in `add` are created once up front (404/400 before any
 * row is touched). `how='bulk'` on the assignments.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = await readJson(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const ids = Array.isArray(body.transcriptIds)
    ? body.transcriptIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (ids.length === 0) return NextResponse.json({ error: 'transcriptIds is required' }, { status: 400 });
  if (ids.length > MAX_BULK) return NextResponse.json({ error: `At most ${MAX_BULK} transcripts per call` }, { status: 400 });
  const addRaw = Array.isArray(body.add) ? body.add : [];
  const removeRaw = Array.isArray(body.remove) ? body.remove : [];
  if (addRaw.length === 0 && removeRaw.length === 0) {
    return NextResponse.json({ error: 'Provide add and/or remove' }, { status: 400 });
  }
  const actor = { userId: user.userId, email: user.email };

  try {
    const addLabels: LabelDbRow[] = [];
    let createdAny = false;
    for (const a of addRaw) {
      if (typeof a === 'number') {
        const asId = parseIntId(a);
        if (asId == null) return NextResponse.json({ error: 'add: label ids must be positive integers' }, { status: 400 });
        const l = await getLabel(asId);
        if (!l) return NextResponse.json({ error: `Label #${asId} not found` }, { status: 404 });
        addLabels.push(l);
      } else if (typeof a === 'string') {
        const r = await resolveOrCreatePath(a, actor);
        if (r.created.length > 0) createdAny = true;
        addLabels.push(r.label);
      } else {
        return NextResponse.json({ error: 'add entries must be label ids (numbers) or paths (strings)' }, { status: 400 });
      }
    }
    const removeLabels: LabelDbRow[] = [];
    for (const r of removeRaw) {
      const asId = parseIntId(r);
      if (asId == null) return NextResponse.json({ error: 'remove entries must be label ids' }, { status: 400 });
      const l = await getLabel(asId);
      if (!l) return NextResponse.json({ error: `Label #${asId} not found` }, { status: 404 });
      removeLabels.push(l);
    }
    if (createdAny) publishEvent({ kind: 'labels' });

    let applied = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    const uniqueIds = [...new Set(ids)];
    for (const aid of uniqueIds) {
      const access = await resolveAccess(user.userId, user.email, aid);
      if (!access) {
        skipped.push({ id: aid, reason: 'not found' });
        continue;
      }
      if (access.access !== 'owner' && access.access !== 'edit') {
        skipped.push({ id: aid, reason: 'read-only' });
        continue;
      }
      let changed = false;
      for (const l of addLabels) {
        const { inserted } = await addAssignment(access.row.id, l.id, actor, 'bulk');
        if (inserted) {
          changed = true;
          await logActivity({
            transcriptId: access.row.id,
            userId: user.userId,
            email: user.email,
            action: 'label_add',
            details: { label_id: l.id, path: l.path, bulk: true },
          });
        }
      }
      for (const l of removeLabels) {
        const { removed } = await removeAssignment(access.row.id, l.id);
        if (removed) {
          changed = true;
          await logActivity({
            transcriptId: access.row.id,
            userId: user.userId,
            email: user.email,
            action: 'label_remove',
            details: { label_id: l.id, path: l.path, bulk: true },
          });
        }
      }
      applied++;
      if (changed) publishEvent({ kind: 'labels', assemblyaiId: aid });
    }
    return NextResponse.json({ applied, skipped });
  } catch (err) {
    const mapped = labelErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
