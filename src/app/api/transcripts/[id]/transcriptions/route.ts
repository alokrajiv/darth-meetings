import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { transcriptionVersionsEnabled } from '@/db-ops/transcriptions';
import { meetingTranscriptionVersions } from '@/lib/server/transcription-runs';
import type { TranscriptionsResponse } from '@/lib/transcriptions';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/transcriptions
 *
 * Every version of what was heard on this meeting's recording, newest first,
 * plus the run in flight and whether the notes were written from another
 * version. The Sources card's Versions disclosure is the only reader
 * (docs/recordings-phase2-spec.md §5).
 *
 * `versioned: false` is the honest answer whenever Phase 2 cannot serve this
 * meeting — the flag is off, 044/045/046 are not applied, or the meeting has
 * no clip yet. The card then hides the Versions UI and keeps the old button,
 * which still works (the route falls back to a new meeting row).
 *
 * PRIVACY: access is the MEETING's (`resolveAccess`), and it is the only gate
 * — a recording has no ACL of its own. Readers see the list; only editors may
 * change which version is live. The `editsSetAside` / `speakerNamesSetAside`
 * numbers COUNT every user's parked annotations because the sentence on the
 * card is about the meeting ("12 edits set aside"), but no annotation's
 * CONTENT is ever in this response (feedback_privacy_caller_scoping_gate).
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const canEdit = access.access !== 'read';
  const marker = access.row.gmeet_context?.retranscribing ?? null;
  const running = marker
    ? {
        transcriptionId: marker.transcriptionId,
        startedAt: marker.startedAt,
        by: marker.by,
        speechModel: marker.speechModel,
        languageCode: marker.languageCode,
      }
    : null;
  const notesStale = access.row.gmeet_context?.notesStale ?? null;

  const off: TranscriptionsResponse = {
    versioned: false,
    canEdit,
    running: null,
    versions: [],
    // With versions off there is no "previous transcription" to talk about —
    // a marker left from before a rollback must not keep a banner up. A marker
    // with its own sentence (a split: "Part of this meeting was split off…")
    // is not about versions and still applies.
    notesStale: notesStale?.reason ? notesStale : null,
  };
  if (!(await transcriptionVersionsEnabled())) return NextResponse.json(off);

  const found = await meetingTranscriptionVersions(access.row.id);
  if (!found) return NextResponse.json(off);

  const body: TranscriptionsResponse = {
    versioned: true,
    canEdit,
    running,
    versions: found.versions,
    notesStale,
  };
  return NextResponse.json(body);
});
