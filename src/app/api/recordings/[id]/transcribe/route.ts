import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { DEFAULT_SPEECH_MODEL, type SpeechModel } from '@/lib/aai-language';
import { parseRunBody } from '@/lib/transcription-merge-plan';
import { ownedRecording, startRecordingRun, writeRefusal } from '@/lib/server/recording-transcriptions';

export const runtime = 'nodejs';

/**
 * POST /api/recordings/:id/transcribe — transcribe a recording that belongs to
 * NO meeting again (docs/transcription-merge-spec.md §3c). The OWNER only.
 *
 * Body = the meeting route's (`POST /api/transcripts/:id/retranscribe`):
 * `{ languageCode?: 'auto' | 'auto-en' | <code>, speechModel?, reason?, force?,
 *    mode?: 'replace' | 'helper' | 'merge', mergeOptions? }`.
 * 202 `{ ok, mode: 'version', transcriptionId, running, runMode }` — the same
 * shape the meeting route answers in version mode.
 *
 * 409 `{ error, meetingId }` once a meeting holds the recording: its
 * versions are switched from the meeting, which moves the meeting's
 * annotations with them.
 *
 * PRIVACY: owner only; everyone else 404, never 403.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const rec = await ownedRecording(user.userId, id);
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const parsed = parseRunBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.body;

  const refusal = await writeRefusal(rec, { userId: user.userId, email: user.email });
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });

  const started = await startRecordingRun({
    rec,
    by: { userId: user.userId, email: user.email ?? null, name: user.name ?? null },
    speechModel: (body.speechModel as SpeechModel | undefined) ?? DEFAULT_SPEECH_MODEL,
    languageCode: body.languageCode ?? 'auto',
    reason: body.reason ?? null,
    force: body.force,
    mode: body.mode,
    mergeOptions: body.mergeOptions,
  });
  if (started.kind === 'refused') return NextResponse.json(started.body, { status: started.status });
  return NextResponse.json(
    {
      ok: true,
      mode: 'version',
      transcriptionId: started.transcriptionId,
      running: started.running,
      runMode: body.mode,
    },
    { status: 202 }
  );
});
