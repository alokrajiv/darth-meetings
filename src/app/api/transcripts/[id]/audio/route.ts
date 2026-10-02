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
import { cutPlanOf, type CutWindow } from '@/lib/clip-cut';
import { clipCutWithin } from '@/lib/server/clip-cut';

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
 * `?variant=audio` asks for the SOUNDTRACK only — the player whenever its
 * video toggle is off (since 2026-09-18; the web app's offline "audio" pins,
 * its first caller, were removed 2026-10-02)
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
 *         player's audio-only probe) and a darth-cli
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
 * CLIP WINDOWS (2026-10-02, lib/clip-cut.ts). A file the meeting holds only a
 * WINDOW of (`windowFromMs > 0` or a `windowToMs` — a meeting split off a
 * longer recording, a combined clip) is never served whole: the answer is a
 * CUT rendition of exactly that window, made once with ffmpeg and cached under
 * `${MW_STORAGE_DIR}/clips/<meeting>/` (lib/server/clip-cut.ts), streamed with
 * Range like any other file and starting at 0. No Stage B redirect and no
 * blob proxy for it — both would hand out the whole recording. A file with a
 * HOLE in the middle (a source meeting whose middle was split off) is served
 * the same way: the concatenation of the stretches it kept (`cutPlanOf`), so
 * the hole's bytes are not reachable either. A meeting that holds the whole
 * file with no hole is served exactly as before (no copy). The recording's
 * OWNER still gets every second through `/api/recordings/:id/audio`.
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
      return await serveMedia(request, row.assemblyai_id, part, audioOnly, decision.redirect);
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
      return await serveMedia(request, row.assemblyai_id, canonical, audioOnly, decision.redirect);
    } catch (err) {
      console.error('[GET /api/transcripts/:id/audio] local stream failed:', redactError(err));
      // A windowed file must never fall through to a whole-file URL.
      if (cutPlanOf(canonical)) {
        return NextResponse.json({ error: 'Audio unavailable' }, { status: 500 });
      }
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
  meetingId: string,
  media: ResolvedMedia,
  audioOnly: boolean,
  mayRedirect: boolean
): Promise<Response> {
  // A window of the file, never the file: checked FIRST, before the Stage B
  // redirect or the blob proxy could hand out the whole recording.
  const plan = cutPlanOf(media);
  if (plan) return serveClipCut(request, meetingId, media, plan, audioOnly);

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
 * How long a request waits for a cut that is not cached yet. A stream copy is
 * seconds; a re-encode of a long video can be minutes. `?variant=audio` keeps
 * the audio-only protocol (the player's 4 s Range probe → 202 → it plays the
 * plain URL meanwhile), so it waits only briefly; the plain URL is what a
 * media element is loading and nginx allows 900 s, so it waits longer and
 * answers 503 + Retry-After only when even that is not enough — the ffmpeg
 * carries on and the next request is served from the cache. Since M2 the
 * clip writers start the cut the moment a window or hole is written
 * (lib/server/clip-precut.ts), so this wait is the fallback, not the norm.
 */
const CUT_WAIT_VARIANT_MS = 3_000;
const CUT_WAIT_PLAIN_MS = 240_000;

async function serveClipCut(
  request: NextRequest,
  meetingId: string,
  media: ResolvedMedia,
  segments: CutWindow[],
  audioOnly: boolean
): Promise<Response> {
  const noStore = { 'Cache-Control': 'private, no-store' };
  const result = await clipCutWithin(
    {
      meetingId,
      sourceFilename: media.filename,
      segments,
      trigger: 'route',
      variant: audioOnly ? 'audio' : 'av',
      part: media.part,
      sourceDurationMs: media.durationMs,
      media,
    },
    audioOnly ? CUT_WAIT_VARIANT_MS : CUT_WAIT_PLAIN_MS
  );
  if (result === null) {
    return NextResponse.json(
      { preparing: true },
      audioOnly
        ? { status: 202, headers: noStore }
        : { status: 503, headers: { ...noStore, 'Retry-After': '30' } }
    );
  }
  if (result.status === 'missing') {
    // Neither on this VM nor pullable from the archive (clip-cut already
    // tried `ensureLocalMedia`). Never a whole-file fallback: a meeting route
    // does not serve a window's recording whole.
    return NextResponse.json({ error: 'Audio file missing' }, { status: 404 });
  }
  if (result.status === 'error') {
    return NextResponse.json({ error: result.error }, { status: 500, headers: noStore });
  }
  // The bytes behind this URL change when the window does (a re-split, an
  // un-split), so no hour-long max-age: revalidate against the cut's name.
  const etag = `"${result.path.split('/').slice(-2).join('/')}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } });
  }
  const local = await streamLocalFile(request, result.path, result.contentType, {
    'Cache-Control': 'private, no-cache',
    ETag: etag,
  });
  if (local === MISSING) return NextResponse.json({ error: 'Audio file missing' }, { status: 404 });
  return local;
}

/**
 * `?variant=audio` for one stored file. The 202/500 bodies are `no-store`
 * so no browser or proxy cache ever keeps a
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
  contentTypeOverride?: string,
  extraHeaders?: Record<string, string>
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
          ...extraHeaders,
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
      ...extraHeaders,
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
