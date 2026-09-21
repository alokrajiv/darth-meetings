import { NextResponse, type NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { ensureAudioOnly } from '@/lib/server/audio-only';
import {
  blobTargetFor,
  mediaRedirectDecision,
  mediaSasRedirect,
  proxyBlobRange,
  redactSas,
  serveStore,
} from '@/lib/server/media-serve';
import {
  canonicalMedia,
  mediaPart,
  resolveMeetingContent,
  type ResolvedMedia,
} from '@/lib/server/recordings';

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/audio[?part=N][&variant=audio][&via=app][&redirect=1]
 *
 * `?part=N` (N >= 2) serves an EXTRA file of a multi-video meeting — today
 * gmeet_context.videoParts[N-2]'s stored file (the primary video is "part 1"
 * and lives in local_audio_path, served by the plain route). Both come from
 * `resolveMeetingContent().media`, which reproduces that numbering exactly:
 * the canonical is 1, the parts follow in capture order, and a part whose
 * bytes never landed keeps its number reserved rather than renumbering the
 * ones after it.
 *
 * `?variant=audio` asks for the SOUNDTRACK only — offline "audio" pins, and
 * since 2026-09-18 the player itself whenever its video toggle is off
 * (components/audio-player.tsx probes this URL with a 2-byte Range and uses
 * it on 206, so phones pull ~30 MB/h instead of the whole mp4). A stored
 * file with no video stream is served as-is, exactly like the plain route.
 * A video file is served as its audio-only m4a derivative
 * (`<storageDir>/audio-only/…`, see lib/server/audio-only.ts — built at
 * import and backfilled by media-sweeper.ts): present → streamed with
 * Range; absent → ffmpeg is started in the background once and the
 * response is 202 `{ preparing: true }` for the client to poll (the player
 * falls back to the full recording on anything but 206/200); a failed
 * transcode surfaces as 500 `{ error }` on the next request.
 * The variant only applies to locally stored files — a legacy remote
 * audio_url row ignores it and redirects as before.
 *
 * Returns the audio for a transcript. Resolution order:
 *   1. the meeting's canonical file (bytes we hold on the VM) →
 *      a. DEC-3 Stage B (`MW_MEDIA_FROM_BLOB` + an archived `blob_name` + an
 *         eligible caller): **302 to a 60-minute read-only SAS** on that one
 *         blob, so the bytes never cross nginx/Next/Tailscale at all. The
 *         access check below has already run; the redirect is the last thing
 *         that happens. `?via=app`, the `x-darth-media-via: app` header (the
 *         offline pin downloader and the player's probe) and a darth-cli
 *         bearer without `?redirect=1` all opt out — see media-serve.ts.
 *      b. otherwise stream from disk with HTTP Range support so the player
 *         can seek — unchanged.
 *      c. local file gone but the blob is there (Stage D, when `storage/`
 *         is drained): proxy the blob through the app, with Range, rather
 *         than 404.
 *   2. an audio_url already stored on the row → 302 (legacy rows only).
 *   3. nothing → 404.
 * There is no step that asks AssemblyAI for a URL any more (DEC-4).
 *
 * Ownership is enforced before any of the above so a user can't probe
 * another user's audio by id — and in particular NO SAS IS EVER MINTED for a
 * caller that failed the check: the 404 below returns before the resolver.
 */
export const GET = withAuth(async ({ user, request, cliScope }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const row = access.row;

  const searchParams = new URL(request.url).searchParams;
  const audioOnly = searchParams.get('variant') === 'audio';
  const media = (await resolveMeetingContent(row)).media;

  // Stage B: may THIS caller be handed a cross-origin URL at all? Decided
  // once, from the request alone, and reused for whichever file is served.
  const decision = mediaRedirectDecision({
    searchParams,
    headers: request.headers,
    isBearer: cliScope !== undefined,
  });

  // Extra file of a multi-video meeting. `?part=1` (and anything below 2, or
  // non-numeric) is not a part: it 404s exactly as videoParts[N-2] did.
  const partParam = searchParams.get('part');
  if (partParam) {
    const part = mediaPart(media, Number.parseInt(partParam, 10));
    if (!part) {
      return NextResponse.json({ error: 'No such video part' }, { status: 404 });
    }
    try {
      return await serveMedia(request, part, audioOnly, decision.redirect);
    } catch (err) {
      console.error('[GET /api/transcripts/:id/audio] part stream failed:', redactError(err));
      return NextResponse.json({ error: 'Video part unavailable' }, { status: 404 });
    }
  }

  // Path 1 — the canonical file (uploaded with bytes saved on the server, or
  // imported).
  const canonical = canonicalMedia(media);
  if (canonical) {
    try {
      return await serveMedia(request, canonical, audioOnly, decision.redirect);
    } catch (err) {
      console.error('[GET /api/transcripts/:id/audio] local stream failed:', redactError(err));
      // Fall through to remote URL — though that's almost certainly broken
      // for AAI-backed rows; see project memory `aai_audio_url_unusable`.
    }
  }

  // Path 2 — an audio_url already ON the row (legacy / pre-local-storage).
  // Almost certainly broken for AAI-backed rows (TLS SAN mismatch + the URL
  // needs signing; see project memory `aai_audio_url_unusable`) but it costs
  // nothing to try what we already hold. We no longer ASK AAI for one:
  // under DEC-4 the job is deleted as soon as our copy is safe, and the
  // answer was never playable anyway.
  const audioUrl = row.audio_url;

  if (!audioUrl) {
    return NextResponse.json({ error: 'Audio not available' }, { status: 404 });
  }

  return NextResponse.redirect(audioUrl, 302);
});

/** A local file we expected is not on this VM (Stage D's normal state). */
const MISSING = Symbol('media file missing');
type Missing = typeof MISSING;

/**
 * ONE file, the whole Stage B ladder: redirect if we may and there is a blob,
 * else the local bytes, else the blob proxied through the app, else the same
 * 404 the local stream has always answered with.
 *
 * With the flag off (or no blob) `store` is null, `target` is null, and what
 * is left is the old `streamLocalFile` / `streamAudioOnly` call and the old
 * 404 — byte for byte.
 */
async function serveMedia(
  request: NextRequest,
  media: ResolvedMedia,
  audioOnly: boolean,
  mayRedirect: boolean
): Promise<Response> {
  const store = serveStore();
  const target = store ? blobTargetFor(media, audioOnly) : null;

  if (store && target && mayRedirect) {
    return mediaSasRedirect(store, target);
  }

  const local = audioOnly
    ? await streamAudioOnly(request, media.filename)
    : await streamLocalFile(request, resolveAudioPath(media.filename));
  if (local !== MISSING) return local;

  // The bytes are not on this VM. If the archive holds them, serve them.
  if (store && target) {
    const proxied = await proxyBlobRange(store, target, request.headers.get('range'));
    if (proxied) return proxied;
    console.warn(
      `[GET /api/transcripts/:id/audio] ${target.blobName} is neither on disk nor in the archive`
    );
  }
  return NextResponse.json({ error: 'Audio file missing' }, { status: 404 });
}

/**
 * `?variant=audio` for one stored file. The 202/500 bodies are `no-store`
 * so neither the browser nor the offline service worker ever keeps a
 * "preparing" answer around as if it were the media.
 */
async function streamAudioOnly(
  request: NextRequest,
  storedFilename: string
): Promise<Response | Missing> {
  const result = await ensureAudioOnly(storedFilename);
  if (result.status === 'ready') {
    return streamLocalFile(request, result.path, result.derived ? 'audio/mp4' : undefined);
  }
  if (result.status === 'preparing') {
    return NextResponse.json(
      { preparing: true },
      { status: 202, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  return NextResponse.json(
    { error: result.error },
    { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

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

/**
 * Stream a file from disk with HTTP Range support. `contentTypeOverride`
 * pins the Content-Type when the path's extension isn't the right signal
 * (the audio-only derivative is always audio/mp4 regardless of what the
 * source was called).
 *
 * A file that is not there answers MISSING rather than a 404 response: the
 * caller decides whether the archive can still serve it (Stage D).
 */
async function streamLocalFile(
  request: NextRequest,
  path: string,
  contentTypeOverride?: string
): Promise<Response | Missing> {
  const fsp = await import('node:fs/promises');
  const fs = await import('node:fs');

  let stats: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stats = await fsp.stat(path);
  } catch {
    return MISSING;
  }

  const fileSize = stats.size;
  const contentType = contentTypeOverride ?? mimeFromPath(path);
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

/**
 * Anything that reaches a `console.*` here goes through this first. An Azure
 * SDK error carries the request URL — which, once a SAS is in play, IS the
 * credential (`?sig=…`, valid for an hour). Never let one into a log line.
 */
function redactError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.replace(/https?:\/\/[^\s"']+/g, (u) => redactSas(u));
}
