import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { meetingRecordingRef, transcriptionVersionsEnabled } from '@/db-ops/transcriptions';
import { activateTranscription, mergeVersions } from '@/lib/server/transcription-runs';
import { parseMergeBody } from '@/lib/server/merge-request';
import type { MergeTranscriptionsResponse } from '@/lib/transcriptions';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/transcriptions/merge — editors only
 * (docs/transcription-merge-spec.md §3b).
 *
 *   { base, fill, options?, reason?, activate?, dryRun? }
 *
 * Merges two completed versions of THIS meeting's recording exactly as named
 * (no re-orientation — Amendment A only adds `warnings` when the pair looks
 * the wrong way round). `dryRun` computes and previews, writes nothing.
 * Otherwise the merged version is written with its base's edits and speaker
 * names carried over (they are index- and label-keyed and the merge keeps the
 * base's utterances), and made live when `activate`.
 *
 * PRIVACY: `resolveAccess` on the MEETING, editors only; `base` / `fill` are
 * honoured only as versions of the meeting's own recording — any other uuid
 * is the same 400 as an unfinished version, which says nothing about whether
 * it exists elsewhere (feedback_privacy_caller_scoping_gate).
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }
  const parsed = parseMergeBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.body;

  if (!(await transcriptionVersionsEnabled())) {
    return NextResponse.json(
      { error: 'Transcription versions are not available on this server.' },
      { status: 409 }
    );
  }
  const ref = await meetingRecordingRef(access.row.id);
  if (!ref) {
    return NextResponse.json({ error: 'This meeting has no recording to merge versions on.' }, { status: 409 });
  }
  // Same rule as "Use this version": a run in flight lands by switching, and
  // two switches racing would park annotations under the wrong version.
  if (body.activate && !body.dryRun && access.row.gmeet_context?.retranscribing) {
    return NextResponse.json(
      { error: 'A new transcription is running — wait for it to land before switching versions.' },
      { status: 409 }
    );
  }

  const out = await mergeVersions({
    recordingId: ref.recordingId,
    baseId: body.base,
    fillId: body.fill,
    options: body.options,
    by: { userId: user.userId, email: user.email ?? null, name: user.name ?? null },
    reason: body.reason,
    dryRun: body.dryRun,
  });
  if (out.kind === 'refused') {
    const err: MergeTranscriptionsResponse = { error: out.error };
    return NextResponse.json(err, { status: out.status });
  }
  if (out.kind === 'dry-run') {
    const dry: MergeTranscriptionsResponse = {
      dryRun: true,
      stats: out.stats,
      preview: out.preview,
      warnings: out.warnings,
    };
    return NextResponse.json(dry);
  }

  let activated = false;
  if (body.activate) {
    const a = await activateTranscription({
      ownerUserId: access.ownerUserId,
      assemblyaiId: access.row.assemblyai_id,
      targetTranscriptionId: out.transcriptionId,
    });
    activated = a.ok;
    if (!a.ok) {
      // The merged version exists and can be switched to later; say why it
      // is not live rather than failing a write that did happen.
      out.warnings.push(`not activated: ${a.error}`);
    }
  }
  const created: MergeTranscriptionsResponse = {
    ok: true,
    transcriptionId: out.transcriptionId,
    stats: out.stats,
    activated,
    warnings: out.warnings,
  };
  return NextResponse.json(created, { status: 201 });
});
