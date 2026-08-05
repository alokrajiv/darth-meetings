import { NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { extractFrame, hasVideoStream } from '@/lib/server/video-frames';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/frames/:frame
 * Serve a single video frame as jpeg. `:frame` is `<ms>.jpg` (or a bare
 * millisecond offset). Frames are extracted on demand with ffmpeg and
 * cached on disk, so the first hit costs a fast keyframe seek and every
 * later hit is a plain file read. Used by the AI notes' embedded
 * screenshots — the notes agent writes `frame:<ms>` refs which the server
 * rewrites to this URL.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id, frame } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const ms = Number.parseInt(String(frame).replace(/\.jpe?g$/i, ''), 10);
  if (!Number.isFinite(ms) || ms < 0 || ms > 24 * 3600_000) {
    return NextResponse.json({ error: 'Bad frame timestamp' }, { status: 400 });
  }

  const audioFilename = access.row.local_audio_path;
  if (!audioFilename || !(await hasVideoStream(audioFilename))) {
    return NextResponse.json({ error: 'No video stored for this transcript' }, { status: 404 });
  }

  try {
    const abs = await extractFrame(access.row.assemblyai_id, audioFilename, ms);
    const st = await stat(abs);
    const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(st.size),
        // Frames are immutable for a given (transcript, ms) — cache hard.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    console.warn(`[frames] extract failed for ${id}@${ms}ms:`, err);
    return NextResponse.json({ error: 'Frame extraction failed' }, { status: 422 });
  }
});
