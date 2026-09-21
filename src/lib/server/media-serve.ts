/**
 * Stage B of DEC-3 — SERVE FROM BLOB (docs/recordings-blob-spec.md).
 *
 * `/api/transcripts/:id/audio` does its access check exactly as before and
 * then, instead of pushing several hundred MB through Tailscale → nginx →
 * Next, answers **302 to a read-only user-delegation SAS** on the one blob
 * that media row names. The bytes go straight from the storage front end to
 * the browser; the access decision is still ours, per request, before the
 * redirect.
 *
 * THREE GATES, all lazy, all off by default:
 *  - `MW_MEDIA_FROM_BLOB` unset/`0` → never redirect (today's behaviour, byte
 *    for byte).
 *  - `DARTH_MEDIA_ACCOUNT` unset → `mediaStore()` is null → same.
 *  - the resolved media has no `blob_name` → same. An unarchived file is
 *    still streamed from disk, so Stage B can be switched on while the
 *    backfill is only half done.
 *
 * WHO DOES NOT GET A REDIRECT (`mediaRedirectDecision`), and why:
 *  - `?via=app` — the explicit "keep it on the app" escape hatch. Anything
 *    that needs a same-origin, cookie-authenticated, CORS-free answer says so
 *    with this.
 *  - the `x-darth-media-via: app` REQUEST HEADER — what the offline pin
 *    downloader and the player's Range probe send. It exists because those
 *    two must keep their URL *spelling* untouched: the service worker matches
 *    cached media on the exact path+query, so adding a query parameter to a
 *    pinned URL would orphan every pin made before today. A header changes no
 *    cache key. See src/lib/offline/offline-urls.ts for the full argument.
 *  - a `dth_` bearer caller (darth-cli), unless it opts in with `?redirect=1`.
 *    The CLI streams to a file with its own HTTP client; a cross-origin
 *    redirect with an Authorization header is a trap, so it stays on the app
 *    until it asks.
 *
 * A SAS URL is a bearer link for its lifetime: whoever holds it can read that
 * ONE blob for at most 60 minutes. That is the trade for not proxying bytes —
 * the same trust the upload ticket already takes. Hence: TTL 60 min,
 * `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer` on the
 * redirect, and **the query string is never logged** (`redactSas`).
 *
 * No `server-only` and no db import on purpose: this is pure policy over a
 * store and a couple of plain values, so the unit tests exercise it directly.
 */
import { createDownloadSas } from '@/lib/server/darth-uploads';
import { mediaContentType, mediaStore, type MediaBlobLike } from '@/lib/server/media-store';
import type { ResolvedMedia } from '@/lib/server/recordings';

export const MEDIA_FROM_BLOB_FLAG_ENV = 'MW_MEDIA_FROM_BLOB';

/** Spec Stage B: a read SAS lives 60 minutes and not a second longer. */
export const MEDIA_SAS_TTL_MS = 60 * 60_000;

/**
 * The request header that means "answer from the app, not from Blob". Sent by
 * the offline pin downloader and by the player's audio-only Range probe — the
 * two callers whose URL spelling is a cache key and therefore cannot change.
 */
export const MEDIA_VIA_HEADER = 'x-darth-media-via';
export const MEDIA_VIA_APP = 'app';

/**
 * Read lazily, never at module scope: `bun run build` must succeed with no env
 * at all, and the flag is flipped by restarting the server, not by rebuilding.
 */
export function mediaFromBlobFlagOn(): boolean {
  const raw = process.env[MEDIA_FROM_BLOB_FLAG_ENV];
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

/** The store to serve FROM, or null when this host serves nothing from blob. */
export function serveStore(): MediaBlobLike | null {
  return mediaFromBlobFlagOn() ? mediaStore() : null;
}

/**
 * A URL with its query string removed — the ONLY form a SAS may appear in, in
 * a log line, an error message or a response body. The query carries `sig=`,
 * which is the credential; printing it would hand a reader 60 minutes of
 * access to that blob. Non-URL input is returned unchanged (it cannot be
 * leaking a signature).
 */
export function redactSas(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  return `${url.slice(0, q)}?<sas redacted>`;
}

/**
 * `redactSas` applied to every URL inside a free-text string — an error
 * message, an SDK exception, an AssemblyAI rejection that quotes back the
 * `audio_url` we sent it (Stage C). Anything that reaches a `console.*` on a
 * path where a SAS exists goes through this first.
 */
export function redactSasInText(text: string): string {
  return text.replace(/https?:\/\/[^\s"']+/g, (u) => redactSas(u));
}

export type RedirectDecision = { redirect: true } | { redirect: false; reason: string };

/**
 * Is this caller allowed a cross-origin redirect? Spec Stage B:
 * eligible = NOT `?via=app` AND NOT the pin/probe header AND NOT a `dth_`
 * bearer caller unless it passed `?redirect=1`.
 *
 * Order matters: `via=app` and the header are absolute (they are the caller
 * saying "I cannot follow a redirect"), while `redirect=1` only overrides the
 * bearer rule.
 */
export function mediaRedirectDecision(input: {
  searchParams: URLSearchParams;
  headers: Headers;
  /** Set by `withAuth` when the caller authenticated with a darth token. */
  isBearer: boolean;
}): RedirectDecision {
  if (input.searchParams.get('via') === 'app') return { redirect: false, reason: 'via=app' };
  if ((input.headers.get(MEDIA_VIA_HEADER) ?? '').toLowerCase() === MEDIA_VIA_APP) {
    return { redirect: false, reason: 'offline pin / probe' };
  }
  if (input.isBearer && input.searchParams.get('redirect') !== '1') {
    return { redirect: false, reason: 'darth-cli bearer' };
  }
  return { redirect: true };
}

/** One servable thing: a blob name, what to call it and how big it is. */
export interface BlobTarget {
  blobName: string;
  filename: string;
  /** `recording_media.bytes` when the archive stamped it; else null. */
  bytes: number | null;
}

/**
 * Which blob answers this request.
 *
 * `?variant=audio` wants the SOUNDTRACK: the file's own `audio_only`
 * derivative when one has been built and archived, or — when the file carries
 * no video at all — the file itself, which IS the audio (that is exactly what
 * `ensureAudioOnly` does locally). A video whose extract exists only on disk,
 * or not yet at all, has no blob answer and falls through to the local path,
 * which builds it and serves 202 meanwhile.
 *
 * Returns null when nothing up there can answer — the caller then streams
 * locally, exactly as before Stage B.
 */
export function blobTargetFor(media: ResolvedMedia, wantAudioOnly: boolean): BlobTarget | null {
  if (wantAudioOnly) {
    const d = media.audioOnly;
    if (d?.blobName) return { blobName: d.blobName, filename: d.filename, bytes: null };
    // `has_video === false` ⇒ the stored file is already audio; a derivative
    // was never built for it and never will be.
    if (media.isVideo === false && media.blobName) {
      return { blobName: media.blobName, filename: media.filename, bytes: null };
    }
    return null;
  }
  if (!media.blobName) return null;
  return { blobName: media.blobName, filename: media.filename, bytes: null };
}

/**
 * The 302. `createDownloadSas` is `darth-uploads.ts`'s (LIFTED VERBATIM,
 * never edited) — a `r`-only, HTTPS-only, single-blob SAS signed with the
 * account's user-delegation key, which is itself minted from the VM's managed
 * identity. No account key exists anywhere.
 *
 * `no-store` so no shared cache, and no service worker, ever keeps a URL that
 * stops working in an hour. `no-referrer` so the SAS never travels in a
 * `Referer` header if the blob ever served something that made a subrequest.
 */
export async function mediaSasRedirect(
  store: MediaBlobLike,
  target: BlobTarget,
  opts: { ttlMs?: number; now?: () => number } = {}
): Promise<Response> {
  const { url } = await createDownloadSas(store, {
    blobName: target.blobName,
    ttlMs: opts.ttlMs ?? MEDIA_SAS_TTL_MS,
    now: opts.now,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      // The blob carries its own Content-Type; this is only a hint for a
      // client that inspects the redirect itself.
      'Content-Type': mediaContentType(target.filename),
    },
  });
}

/** Parse `bytes=A-B` / `bytes=A-` against a known total. null = not a range we serve. */
export function parseRange(
  header: string | null,
  total: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number.parseInt(m[2]!, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number.parseInt(m[1]!, 10);
    end = m[2] === '' ? total - 1 : Math.min(Number.parseInt(m[2]!, 10), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return 'unsatisfiable';
  }
  return { start, end };
}

/**
 * Stream the blob THROUGH the app, with Range, for a caller that may not be
 * redirected (a pin download, `?via=app`, darth-cli) and whose local file is
 * gone. Today that combination cannot happen — Stage A never deletes a local
 * file — so this is the forward guard for Stage D, when `storage/` is drained
 * and the VM becomes a cache: the answer then is slower bytes, never a 404.
 *
 * The size comes from `properties()` (one HEAD-shaped call) because
 * `recording_media.bytes` is the SOURCE file's size and a derivative's row may
 * not carry one; a blob that vanished answers null and the caller 404s.
 */
export async function proxyBlobRange(
  store: MediaBlobLike,
  target: BlobTarget,
  rangeHeader: string | null
): Promise<Response | null> {
  const props = await store.properties(target.blobName);
  if (!props) return null;
  const total = props.bytes;
  const contentType = props.contentType ?? mediaContentType(target.filename);
  const range = parseRange(rangeHeader, total);

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
    });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const body = await store.readRange(target.blobName, start, end);
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Type': contentType,
      // Proxied bytes are the recording itself and do not expire; the same
      // private cache policy the local stream uses.
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
