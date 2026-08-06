import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { setLocalAudioPathForUser } from '@/db-ops/transcripts';
import {
  GoogleApiError,
  downloadDriveFileToTemp,
  getDriveFileMeta,
} from '@/lib/server/gmeet';
import {
  audioFilename,
  deleteAudioFile,
  renameAudioFile,
} from '@/lib/server/audio-storage';

export const runtime = 'nodejs';
// A meeting recording can be multi-GB; the Drive pull takes a while (only
// enforced on serverless hosts; the VM ignores it).
export const maxDuration = 900;

/** One Drive pull per transcript at a time — double-clicks and two viewers
 * racing would otherwise download the same multi-hundred-MB file twice. */
const inFlight = new Set<string>();

/**
 * POST /api/transcripts/:id/fetch-audio
 * Body: { accessToken } — browser-supplied Google token, used in memory only.
 *
 * Attach playable audio to a Meet quick-import (transcript-only rows have no
 * audio): download the meeting's recording from Drive and store it as the
 * row's local audio. No re-transcription — the Meet transcript stays as-is;
 * /api/transcripts/:id/audio then streams the file with Range support so
 * playback and seeking just work (the <audio> element plays an mp4's audio
 * track natively).
 *
 * Editors only (owner + 'edit' shares) — it mutates the owner's row, and
 * auto-shared invitees get 'edit' anyway.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    accessToken?: string;
  } | null;
  const accessToken = body?.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length < 20) {
    return NextResponse.json({ error: 'accessToken is required' }, { status: 400 });
  }

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }
  const row = access.row;
  if (row.local_audio_path) {
    return NextResponse.json({ ok: true, already: true });
  }

  const ctx = row.gmeet_context;
  const fileId = ctx?.videoFileId ?? ctx?.actuals?.recordings?.[0]?.fileId;
  if (!fileId) {
    return NextResponse.json(
      { error: 'No recording is known for this transcript.' },
      { status: 422 }
    );
  }

  if (inFlight.has(id)) {
    return NextResponse.json(
      { error: 'Recording fetch already in progress — try again in a minute.' },
      { status: 429 }
    );
  }
  inFlight.add(id);
  try {
    const meta = await getDriveFileMeta(accessToken, fileId);
    if (!meta.canDownload) {
      return NextResponse.json(
        {
          error:
            'The owner has disabled downloads for viewers on this recording. Ask them for edit access or to lift the restriction (Share → gear icon).',
        },
        { status: 403 }
      );
    }
    const dl = await downloadDriveFileToTemp(accessToken, fileId);
    if (dl.bytes === 0) {
      await deleteAudioFile(dl.tempFilename);
      return NextResponse.json({ error: 'Drive returned an empty file' }, { status: 502 });
    }
    const filename = audioFilename(id, meta.name);
    await renameAudioFile(dl.tempFilename, filename);
    await setLocalAudioPathForUser(access.ownerUserId, id, filename);
    return NextResponse.json({ ok: true, bytes: dl.bytes });
  } catch (err) {
    if (err instanceof GoogleApiError) {
      const status = err.status === 401 ? 401 : err.status === 404 ? 404 : 502;
      return NextResponse.json(
        {
          error:
            err.status === 401
              ? 'Google session expired — reconnect Google and try again.'
              : err.status === 404
                ? 'Recording not found on Drive — it may have been moved or deleted.'
                : `Google API error: ${err.message}`,
        },
        { status }
      );
    }
    console.error('[fetch-audio] failed:', err);
    return NextResponse.json(
      { error: 'Recording fetch failed', detail: String(err) },
      { status: 502 }
    );
  } finally {
    inFlight.delete(id);
  }
});
