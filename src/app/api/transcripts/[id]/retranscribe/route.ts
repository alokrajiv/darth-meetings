import { promises as fsp } from 'node:fs';
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { mergeGmeetContextForUser } from '@/db-ops/transcripts';
import { DEFAULT_SPEECH_MODEL, LEGACY_SPEECH_MODEL } from '@/lib/aai-language';
import { audioFileSize, resolveAudioPath } from '@/lib/server/audio-storage';
import { finalizeUpload, openUpload, type LinkedEventInput } from '@/lib/server/upload-pipeline';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/retranscribe
 *
 * "Re-transcribe with the newer model": run the row's stored audio through
 * AssemblyAI again on DEFAULT_SPEECH_MODEL. Same shape as the other re-run
 * flows — a NEW row is created alongside (this one stays untouched), the
 * linked calendar event and invitee shares carry over, and the owner gets
 * the transcript_ready DM when it lands. Responds as soon as the job is
 * queued (202); the AAI upload of a multi-GB video runs in the background
 * with the placeholder's heartbeat keeping the sweeper off it.
 *
 * Editors only. Refused when the row already ran on the current model, has
 * no stored audio, or was re-run before (the old row carries a pointer).
 */
export const POST = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }
  const row = access.row;
  const ownerId = row.user_id;
  const ctx = row.gmeet_context;

  if (ctx?.retranscribed) {
    return NextResponse.json(
      { ok: true, already: true, newId: ctx.retranscribed.newId },
      { status: 200 }
    );
  }
  if ((row.speech_model ?? LEGACY_SPEECH_MODEL) === DEFAULT_SPEECH_MODEL) {
    return NextResponse.json(
      { error: 'This transcript already ran on the current model.' },
      { status: 409 }
    );
  }
  if (!row.local_audio_path) {
    return NextResponse.json(
      { error: 'No stored audio for this transcript — nothing to re-run.' },
      { status: 422 }
    );
  }
  const bytes = await audioFileSize(row.local_audio_path);
  if (bytes === null) {
    return NextResponse.json({ error: 'Stored audio file is missing on disk.' }, { status: 422 });
  }

  // Carry the meeting identity so the new row lands in the same series /
  // calendar slot and the same invitees are auto-shared.
  const linkedEvent: LinkedEventInput | null = ctx?.eventId
    ? {
        id: ctx.eventId,
        title: ctx.eventTitle,
        startTime: ctx.startTime,
        endTime: ctx.endTime,
        meetingCode: ctx.meetingCode,
        recurringEventId: ctx.recurringEventId,
        iCalUID: ctx.iCalUID,
        organizerEmail: ctx.organizerEmail,
        attendees: ctx.attendees,
      }
    : null;

  const owner = { ...user, userId: ownerId };
  const opened = await openUpload(owner, {
    originalFilename: row.original_filename ?? row.local_audio_path,
    contentType: 'application/octet-stream',
    languageCode: row.language_code ?? undefined,
    linkedEvent,
    reportPref: ctx?.uploadPrefs?.report ?? null,
    sourceId: row.assemblyai_id,
    multi: null,
    bytesTotal: bytes,
    speechModel: DEFAULT_SPEECH_MODEL,
    contextExtra: {
      ...(ctx?.provider ? { provider: ctx.provider } : {}),
      retranscribedFrom: row.assemblyai_id,
    },
  });
  if (!opened.ok) return NextResponse.json({ error: opened.error }, { status: opened.status });
  const { spec, placeholder } = opened;

  // The bytes are already on disk: hard-link them under the temp name the
  // pipeline expects (falls back to a copy on filesystems without links).
  // The pipeline renames the temp file to its permanent name on success and
  // deletes it on failure — the original stays put either way.
  const src = resolveAudioPath(row.local_audio_path);
  const tmp = resolveAudioPath(spec.tempFilename);
  try {
    await fsp.link(src, tmp);
  } catch {
    await fsp.copyFile(src, tmp);
  }

  const startedAt = new Date().toISOString();
  await mergeGmeetContextForUser(ownerId, row.assemblyai_id, {
    retranscribed: { at: startedAt, newId: placeholder.assemblyai_id, model: DEFAULT_SPEECH_MODEL },
  });

  void (async () => {
    try {
      const result = await finalizeUpload(owner, spec, bytes);
      if ('transcript' in result.body) {
        await mergeGmeetContextForUser(
          ownerId,
          row.assemblyai_id,
          { retranscribed: { at: startedAt, newId: result.body.transcript.assemblyai_id, model: DEFAULT_SPEECH_MODEL } },
          { quiet: true }
        );
        console.log(
          `[retranscribe] ${row.assemblyai_id} → ${result.body.transcript.assemblyai_id} (${DEFAULT_SPEECH_MODEL})`
        );
      } else {
        console.error(`[retranscribe] ${row.assemblyai_id} failed:`, result.body);
        await mergeGmeetContextForUser(ownerId, row.assemblyai_id, { retranscribed: null as never });
      }
    } catch (err) {
      console.error(`[retranscribe] ${row.assemblyai_id} crashed:`, err);
      await mergeGmeetContextForUser(ownerId, row.assemblyai_id, { retranscribed: null as never }).catch(
        () => {}
      );
    }
  })();

  return NextResponse.json(
    { ok: true, newId: placeholder.assemblyai_id, model: DEFAULT_SPEECH_MODEL },
    { status: 202 }
  );
});
