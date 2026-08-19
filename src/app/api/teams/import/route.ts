import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { executeTeamsImport, type TeamsImportBody } from '@/lib/server/teams-import-core';

export const runtime = 'nodejs';
// Teams MP4s are hundreds of MB — pulling from Graph and re-uploading to
// AssemblyAI takes a while (only enforced on serverless hosts).
export const maxDuration = 900;

/**
 * POST /api/teams/import
 *
 * Import a Microsoft Teams meeting picked from the user's Google calendar.
 * Artifacts come app-only from Graph under the organizer's AAD id (embedded
 * in the join link) — the user needs no Microsoft login, and unlike Meet
 * there is no per-user artifact access to verify.
 *
 * Modes mirror /api/gmeet/import:
 *  - 'transcript': fetch + parse the speaker-attributed VTT, store as a
 *    completed imported row. Synthetic id `teams-<meetingHash>-<callId8>`.
 *  - 'video': download the MP4 and run the normal AAI pipeline.
 *  - 'both': video mode plus the parsed VTT as the meetTranscript sidecar
 *    (real names for cross-referencing/speaker-ID, like Meet's both).
 *
 * With `defer: true`, a still-processing artifact queues the import instead
 * of failing (202 + `defer-…` placeholder; the deferred-import poller runs
 * it once Microsoft finishes). Logic lives in teams-import-core so the
 * poller can replay it server-side.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: TeamsImportBody;
  try {
    body = (await request.json()) as TeamsImportBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const outcome = await executeTeamsImport({ userId: user.userId, email: user.email }, body);
  return NextResponse.json(outcome.body, { status: outcome.status });
});
