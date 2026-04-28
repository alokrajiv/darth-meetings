import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import {
  getForUser as getMappingsForUser,
  upsertForUser as upsertMappingsForUser,
  type SpeakerLabel,
} from '@/db-ops/speaker-mappings';

export const runtime = 'nodejs';

function validateLabels(value: unknown): SpeakerLabel[] | null {
  if (!Array.isArray(value)) return null;
  const out: SpeakerLabel[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { originalSpeaker, customName, description } = item as Record<string, unknown>;
    if (typeof originalSpeaker !== 'string') return null;
    out.push({
      originalSpeaker,
      customName: typeof customName === 'string' ? customName : '',
      description: typeof description === 'string' ? description : '',
    });
  }
  return out;
}

/**
 * GET /api/transcripts/:id/speakers
 * Returns the speaker label customisations for this transcript. Readable by
 * owner and any collaborator (read or edit).
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const row = await getMappingsForUser(access.ownerUserId, id);
  return NextResponse.json({ speakerLabels: row?.speaker_labels ?? [] });
});

/**
 * PUT /api/transcripts/:id/speakers
 * Replace the speaker label customisations on the owner's row. Editors
 * allowed, read-only denied.
 */
export const PUT = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const labels = validateLabels((body as { speakerLabels?: unknown })?.speakerLabels);
  if (!labels) {
    return NextResponse.json(
      { error: 'Invalid speakerLabels (expected array of {originalSpeaker, customName, description})' },
      { status: 400 }
    );
  }

  const row = await upsertMappingsForUser(access.ownerUserId, id, labels);

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'edit_speakers',
    details: { count: labels.length },
  });

  return NextResponse.json({ speakerLabels: row.speaker_labels });
});
