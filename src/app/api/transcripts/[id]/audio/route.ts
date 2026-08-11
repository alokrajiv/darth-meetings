import { NextResponse, type NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { withAuth } from '@/lib/auth/with-auth';
import { updateStatusForUser } from '@/db-ops/transcripts';
import { resolveAccess } from '@/db-ops/transcript-access';
import { getTranscript } from '@/lib/server/assemblyai';
import { resolveAudioPath } from '@/lib/server/audio-storage';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/audio[?part=N]
 *
 * `?part=N` (N >= 2) serves an EXTRA recording segment of a multi-video
 * meeting — gmeet_context.videoParts[N-2]'s stored file (the primary video
 * is "part 1" and lives in local_audio_path, served by the plain route).
 *
 * Returns the audio for a transcript. Resolution order:
 *   1. local_audio_path (imported transcripts whose bytes we downloaded) →
 *      stream from disk with HTTP Range support so the player can seek.
 *   2. audio_url cached on the row → 302 to AAI's CDN, which handles Range
 *      itself.
 *   3. uploaded transcript with no cached audio_url yet → fetch from AAI
 *      once, persist, then 302.
 *   4. nothing → 404.
 *
 * Ownership is enforced before any of the above so a user can't probe
 * another user's audio by id.
 */
export const GET = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const row = access.row;

  // Extra segment of a multi-video meeting.
  const partParam = new URL(request.url).searchParams.get('part');
  if (partParam) {
    const partNo = Number.parseInt(partParam, 10);
    const part = Number.isInteger(partNo)
      ? row.gmeet_context?.videoParts?.[partNo - 2]
      : undefined;
    if (!part?.filename) {
      return NextResponse.json({ error: 'No such video part' }, { status: 404 });
    }
    try {
      return await streamLocalFile(request, resolveAudioPath(part.filename));
    } catch (err) {
      console.error('[GET /api/transcripts/:id/audio] part stream failed:', err);
      return NextResponse.json({ error: 'Video part unavailable' }, { status: 404 });
    }
  }

  // Path 1 — local file (uploaded with bytes saved on the server, or imported)
  if (row.local_audio_path) {
    try {
      const abs = resolveAudioPath(row.local_audio_path);
      return await streamLocalFile(request, abs);
    } catch (err) {
      console.error('[GET /api/transcripts/:id/audio] local stream failed:', err);
      // Fall through to remote URL — though that's almost certainly broken
      // for AAI-backed rows; see project memory `aai_audio_url_unusable`.
    }
  }

  // Path 2 — remote URL (legacy / pre-local-storage rows). Note: AAI deletes
  // the upload after transcription so this path effectively doesn't work.
  // Kept here as a graceful fallback so old rows don't blow up.
  let audioUrl = row.audio_url;
  if (!audioUrl && row.source === 'uploaded') {
    try {
      const aai = await getTranscript(id);
      audioUrl = aai.audio_url ?? null;
      if (audioUrl) {
        await updateStatusForUser(access.ownerUserId, id, { audioUrl });
      }
    } catch (err) {
      console.error('[GET /api/transcripts/:id/audio] AAI backfill failed:', err);
    }
  }

  if (!audioUrl) {
    return NextResponse.json({ error: 'Audio not available' }, { status: 404 });
  }

  return NextResponse.redirect(audioUrl, 302);
});

function mimeFromPath(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'mp4':
      // Meeting recordings are video containers; <video> and <audio>
      // elements both play video/mp4 fine.
      return 'video/mp4';
    case 'wav':
      return 'audio/wav';
    case 'webm':
      return 'audio/webm';
    case 'ogg':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    default:
      return 'application/octet-stream';
  }
}

async function streamLocalFile(
  request: NextRequest,
  path: string
): Promise<Response> {
  const fsp = await import('node:fs/promises');
  const fs = await import('node:fs');

  let stats: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stats = await fsp.stat(path);
  } catch {
    return NextResponse.json({ error: 'Audio file missing' }, { status: 404 });
  }

  const fileSize = stats.size;
  const contentType = mimeFromPath(path);
  const rangeHeader = request.headers.get('range');

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1]!, 10);
      const end = match[2] ? parseInt(match[2]!, 10) : fileSize - 1;
      if (start >= fileSize || end >= fileSize || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` },
        });
      }
      const nodeStream = fs.createReadStream(path, { start, end });
      return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }
  }

  const nodeStream = fs.createReadStream(path);
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
