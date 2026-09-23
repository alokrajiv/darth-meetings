import 'server-only';
import { Readable } from 'node:stream';

/**
 * Stream one stored media file with HTTP Range support — for the recording
 * media route (`GET /api/recordings/:id/audio`, design P7). A copy of the
 * meeting audio route's private helper, deliberately NOT a refactor of it:
 * the `/api/transcripts/:id/*` media paths are left exactly as they are.
 *
 * Returns null when the file is not on disk (the caller decides what else
 * can answer — the archived blob, or a 404).
 */
export async function streamLocalMedia(
  rangeHeader: string | null,
  absPath: string,
  contentTypeOverride?: string
): Promise<Response | null> {
  const fsp = await import('node:fs/promises');
  const fs = await import('node:fs');
  let size: number;
  try {
    size = (await fsp.stat(absPath)).size;
  } catch {
    return null;
  }
  const contentType = contentTypeOverride ?? mimeFromPath(absPath);
  const common = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=3600',
  };
  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1]!, 10);
      const end = match[2] ? parseInt(match[2]!, 10) : size - 1;
      if (start >= size || end >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const stream = fs.createReadStream(absPath, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          ...common,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
  }
  const stream = fs.createReadStream(absPath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...common, 'Content-Length': String(size) },
  });
}

export function mimeFromPath(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
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
