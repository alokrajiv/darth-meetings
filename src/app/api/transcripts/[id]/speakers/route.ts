import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import {
  getForUser as getMappingsForUser,
  upsertForUser as upsertMappingsForUser,
  type SpeakerLabel,
} from '@/db-ops/speaker-mappings';
import { enrollFromTranscript } from '@/lib/server/voiceprint';
import { getContentCached } from '@/lib/server/auto-notes';
import { resolveMeetingContent } from '@/lib/server/recordings';
import { settleSpeakerIdAfterNaming } from '@/lib/server/speaker-id-settle';
import { resolveLabelIdentities } from '@/lib/server/speaker-identity';
import { isEmailShape, normalizeEmail } from '@/lib/speaker-identity';

export const runtime = 'nodejs';

/**
 * The wire shape: `{originalSpeaker, customName?, description?, email?}`.
 * `email` (lib/speaker-identity) is optional; when present it has to look
 * like an address — anything else is a 400, never silently dropped.
 */
function validateLabels(value: unknown): SpeakerLabel[] | null {
  if (!Array.isArray(value)) return null;
  const out: SpeakerLabel[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { originalSpeaker, customName, description, email } = item as Record<string, unknown>;
    if (typeof originalSpeaker !== 'string') return null;
    if (email !== undefined && email !== null && email !== '') {
      if (typeof email !== 'string' || !isEmailShape(email)) return null;
    }
    out.push({
      originalSpeaker,
      customName: typeof customName === 'string' ? customName : '',
      description: typeof description === 'string' ? description : '',
      ...(typeof email === 'string' && email.trim() ? { email: normalizeEmail(email) } : {}),
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
  return NextResponse.json({
    speakerLabels: row?.speaker_labels ?? [],
    suggestions: row?.suggestions ?? {},
  });
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

  const sent = validateLabels((body as { speakerLabels?: unknown })?.speakerLabels);
  if (!sent) {
    return NextResponse.json(
      {
        error:
          'Invalid speakerLabels (expected array of {originalSpeaker, customName, description, email?} — email, when given, must be an address)',
      },
      { status: 400 }
    );
  }

  // A label with an email names a PERSON: the stored name is the canonical
  // one (directory → invitee → sent) and a missing directory row is created
  // — the same as "+ Person". The reply carries what was stored.
  const labels = await resolveLabelIdentities(sent, {
    attendees: access.row.gmeet_context?.attendees,
    createdBy: user.userId,
  });
  const row = await upsertMappingsForUser(access.ownerUserId, id, labels);

  // One content read serves both of the follow-ups below.
  const content = await getContentCached(access.ownerUserId, access.row).catch((err) => {
    console.warn('[speakers PUT] content read failed:', err);
    return null;
  });

  // Naming everyone answers the question the speaker-ID pass was asking: a
  // null / running / errored pass is marked completed, so the detail page
  // stops waiting ("Identifying speakers first…") and the sweeper never
  // spends a model call re-running it. Best-effort — the names are saved.
  await settleSpeakerIdAfterNaming(access.ownerUserId, access.row, labels, content).catch((err) =>
    console.warn('[speakers PUT] speaker_id_status settle failed:', err)
  );

  // Every confirmed name is free enrollment data: update that person's
  // voiceprint from this meeting's audio (fire-and-forget, best-effort).
  // Text and media both come from the resolver, so the utterance ms and the
  // file they are sliced out of always belong to the same timeline.
  void (async () => {
    const resolved = await resolveMeetingContent(access.row);
    await enrollFromTranscript(resolved.media /* every file: a combined meeting embeds each recording's voices from ITS OWN file (mediaForSpeaker) */, content, labels);
  })().catch((err) => console.warn('[speakers PUT] voiceprint enroll failed:', err));

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'edit_speakers',
    details: { count: labels.length },
  });

  return NextResponse.json({ speakerLabels: row.speaker_labels });
});
