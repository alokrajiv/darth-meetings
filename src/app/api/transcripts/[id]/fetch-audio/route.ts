import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { GoogleApiError } from '@/lib/server/gmeet';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import {
  RecordingFetchError,
  fetchRecordingFromDrive,
  fetchRecordingFromTeams,
} from '@/lib/server/recording-fetch';
import { GraphApiError } from '@/lib/server/ms-graph';

export const runtime = 'nodejs';
// A meeting recording can be multi-GB; the Drive pull takes a while (only
// enforced on serverless hosts; the VM ignores it).
export const maxDuration = 900;

/**
 * POST /api/transcripts/:id/fetch-audio
 * Optional body: { accessToken } — otherwise a token is minted server-side
 * from the caller's stored Google connection (own-token rule either way).
 *
 * Attach playable audio to a Meet quick-import (transcript-only rows have no
 * audio): download the meeting's recording from Drive and store it as the
 * row's local audio. No re-transcription — the Meet transcript stays as-is;
 * /api/transcripts/:id/audio then streams the file with Range support so
 * playback and seeking just work (the <audio> element plays an mp4's audio
 * track natively). Concurrent calls join the same in-flight download.
 *
 * Editors only (owner + 'edit' shares) — it mutates the owner's row, and
 * auto-shared invitees get 'edit' anyway.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    accessToken?: string;
  } | null;

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

  // Teams rows fetch app-only from Graph — no Google token involved.
  if (ctx?.provider === 'teams') {
    const teams = ctx.teams;
    if (!teams?.recordingId) {
      return NextResponse.json(
        { error: 'No recording is known for this transcript.' },
        { status: 422 }
      );
    }
    try {
      const { bytes } = await fetchRecordingFromTeams({
        ownerUserId: access.ownerUserId,
        assemblyaiId: id,
        organizerOid: teams.organizerOid,
        graphMeetingId: teams.graphMeetingId,
        recordingId: teams.recordingId,
      });
      return NextResponse.json({ ok: true, bytes });
    } catch (err) {
      if (err instanceof RecordingFetchError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      if (err instanceof GraphApiError) {
        return NextResponse.json(
          {
            error:
              err.status === 404
                ? 'Recording no longer available on Microsoft 365.'
                : `Microsoft Graph error: ${err.message}`,
          },
          { status: err.status === 404 ? 404 : 502 }
        );
      }
      console.error('[fetch-audio] teams fetch failed:', err);
      return NextResponse.json(
        { error: 'Recording fetch failed', detail: String(err) },
        { status: 502 }
      );
    }
  }

  const fileId = ctx?.videoFileId ?? ctx?.actuals?.recordings?.[0]?.fileId;
  if (!fileId) {
    return NextResponse.json(
      { error: 'No recording is known for this transcript.' },
      { status: 422 }
    );
  }

  let accessToken =
    typeof body?.accessToken === 'string' && body.accessToken.length >= 20
      ? body.accessToken
      : null;
  if (!accessToken) {
    accessToken = (await getServerAccessToken(user.userId))?.token ?? null;
  }
  if (!accessToken) {
    return NextResponse.json(
      { error: 'Google is not connected — connect Google and try again.' },
      { status: 401 }
    );
  }

  try {
    const { bytes } = await fetchRecordingFromDrive({
      ownerUserId: access.ownerUserId,
      assemblyaiId: id,
      fileId,
      accessToken,
    });
    return NextResponse.json({ ok: true, bytes });
  } catch (err) {
    if (err instanceof RecordingFetchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
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
  }
});
