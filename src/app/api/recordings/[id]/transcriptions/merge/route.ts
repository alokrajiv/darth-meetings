import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { recordingRunInFlight, setRecordingActiveTranscription } from '@/db-ops/transcriptions';
import { mergeVersions } from '@/lib/server/transcription-runs';
import { parseMergeBody } from '@/lib/server/merge-request';
import { ownedRecording, writeRefusal } from '@/lib/server/recording-transcriptions';
import type { MergeTranscriptionsResponse } from '@/lib/transcriptions';

export const runtime = 'nodejs';

/**
 * POST /api/recordings/:id/transcriptions/merge — the meeting route's merge
 * (`{ base, fill, options?, reason?, activate?, dryRun? }`, same answers) on
 * a recording that belongs to NO meeting (docs/transcription-merge-spec.md
 * §3c). The OWNER only. A dry run is a read and is answered even when a
 * meeting holds the recording; writing is refused then with
 * 409 `{ error, meetingId }`.
 *
 * PRIVACY: owner only; everyone else 404, never 403. `base` / `fill` must be
 * versions of THIS recording.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const rec = await ownedRecording(user.userId, id);
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const parsed = parseMergeBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.body;

  // A dry run writes nothing, so "a meeting holds it" does not stop it —
  // only "versions are off" does.
  const refusal = await writeRefusal(rec, { userId: user.userId, email: user.email });
  const inMeetingOnly = !!refusal && 'meetingId' in refusal.body;
  if (refusal && !(body.dryRun && inMeetingOnly)) {
    return NextResponse.json(refusal.body, { status: refusal.status });
  }
  if (body.activate && !body.dryRun && (await recordingRunInFlight(rec.id))) {
    return NextResponse.json(
      { error: 'A new transcription is running — wait for it to land before switching versions.' },
      { status: 409 }
    );
  }

  const out = await mergeVersions({
    recordingId: rec.id,
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
    activated = await setRecordingActiveTranscription(rec.id, out.transcriptionId);
    if (!activated) out.warnings.push('not activated: the recording changed while merging');
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
