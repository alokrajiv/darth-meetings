import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import { getAnyByAssemblyaiId } from '@/db-ops/transcripts';
import { addShare } from '@/db-ops/transcript-shares';
import {
  findConferenceRecordName,
  getDriveFileMeta,
} from '@/lib/server/gmeet';

export const runtime = 'nodejs';

/**
 * POST /api/gmeet/join
 * Body: { meetingCode, startTime?, accessToken }
 *
 * "Join the existing import instead of cloning it." When a colleague already
 * imported a meeting but never shared it, the caller can prove — with their
 * OWN Google token — that Google gives them access to that meeting, and get
 * shared onto the existing row.
 *
 * Accepted proofs, in order:
 *   1. the Meet API lists a conference record for this code+time under the
 *      caller's token (Meet only shows meetings you attended or organized);
 *   2. the caller can read the recording file on Drive;
 *   3. the caller can read the transcript Doc on Drive.
 *
 * This is the load-bearing end of the cache privacy rule: cached metadata
 * may TELL anyone the meeting exists, but joining its content always runs
 * through the joiner's own Google access, never through the cache or the
 * importer's token.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    meetingCode?: string;
    startTime?: string | null;
    accessToken?: string;
  } | null;
  const meetingCode = body?.meetingCode?.trim();
  const accessToken = body?.accessToken;
  const startTime = typeof body?.startTime === 'string' ? body.startTime : null;
  if (!meetingCode || typeof accessToken !== 'string' || accessToken.length < 20) {
    return NextResponse.json(
      { error: 'meetingCode and accessToken are required' },
      { status: 400 }
    );
  }

  const [existing] = await findImportedByMeetingCodes(
    [{ code: meetingCode, startTime }],
    { userId: user.userId, email: user.email }
  );
  if (!existing) {
    return NextResponse.json(
      { error: 'Nobody has imported this meeting yet.' },
      { status: 404 }
    );
  }
  if (existing.accessible) {
    // Already theirs / already shared — nothing to grant.
    return NextResponse.json({
      transcriptId: existing.assemblyai_id,
      title: existing.title,
      alreadyAccessible: true,
    });
  }

  const row = await getAnyByAssemblyaiId(existing.assemblyai_id);
  if (!row) {
    return NextResponse.json({ error: 'Existing import not found.' }, { status: 404 });
  }

  // ---- Access proof via the CALLER's own Google token ----------------------
  let proof: 'meet-record' | 'drive-video' | 'drive-doc' | null = null;
  try {
    const record = await findConferenceRecordName(
      accessToken,
      meetingCode,
      startTime ?? row.gmeet_context?.startTime ?? undefined
    );
    if (record) proof = 'meet-record';
  } catch {
    // fall through to Drive proofs
  }
  if (!proof) {
    for (const [fileId, kind] of [
      [row.gmeet_context?.videoFileId, 'drive-video'],
      [row.gmeet_context?.transcriptDocId, 'drive-doc'],
    ] as const) {
      if (!fileId) continue;
      try {
        await getDriveFileMeta(accessToken, fileId);
        proof = kind;
        break;
      } catch {
        // not readable with this token — try the next artifact
      }
    }
  }
  if (!proof) {
    return NextResponse.json(
      {
        error:
          "Google doesn't show you having access to this meeting (you weren't in it, and its recording/transcript aren't shared with you) — ask the importer to share it instead.",
      },
      { status: 403 }
    );
  }

  await addShare({
    transcriptId: row.id,
    ownerUserId: row.user_id,
    sharedByUserId: user.userId,
    sharedWithEmail: user.email,
    sharedWithName: null,
    sharedWithPplId: null,
    access: 'edit',
  });
  console.log(
    `[gmeet/join] ${user.email} joined ${row.assemblyai_id} (proof: ${proof})`
  );

  return NextResponse.json({
    transcriptId: row.assemblyai_id,
    title: row.title,
    proof,
  });
});
