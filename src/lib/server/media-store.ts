/**
 * The PERMANENT media store — `meetings-media` in its own storage account
 * (docs/recordings-blob-spec.md, DEC-3).
 *
 * Why a second store at all: `darth-uploads.ts` talks to the TRANSIT account
 * (`darthuploads`), whose lifecycle rule `expire-uploads` deletes every block
 * blob one day after its last write, with NO prefix filter — verified
 * read-only on 2026-09-22. Permanent recording bytes put there would be
 * destroyed the next day. Transit and archive have opposite lifecycles, so
 * they get different accounts: `DARTH_MEDIA_ACCOUNT` / `DARTH_MEDIA_CONTAINER`
 * (default `meetings-media`), read lazily and completely independent of
 * `DARTH_UPLOADS_*`. Account unset → `mediaStore()` is null and every caller
 * above it is inert: zero queries, zero network.
 *
 * `darth-uploads.ts` is LIFTED VERBATIM from ../chat and must stay in step, so
 * nothing here edits it. Instead this module:
 *  - reuses `createAzureBlobStore` for the whole `BlobLike` seam (same
 *    managed-identity credential, same SAS/stat/read/write/delete), and
 *  - adds the five methods a PERMANENT store needs that a TRANSIT store never
 *    did: `putStream` (block upload with a content type + disposition),
 *    `setMetadata` (the sha256 + kind stamp, written after the bytes because
 *    the hash is only known once the stream ends), `properties` (size +
 *    metadata + content type, for verify-then-stamp and for adopt),
 *    `readRange` (Stage B's proxy: a byte range of a blob, so a caller that
 *    may not be redirected can still seek) and `copyFromUrl` (Stage C:
 *    Azure pulls the bytes from another blob's URL itself — the VM never sees
 *    them).
 * The in-memory fake grows the same five methods —
 * `__tests__/helpers/fake-media-blob.ts`.
 *
 * No `server-only`: like `darth-uploads.ts` this is a plain Node module (the
 * Azure SDK and env, no db, no Next), so `scripts/media-archive-status.ts`
 * can import it under bun.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import {
  blobEndpoint,
  createAzureBlobStore,
  type BlobLike,
  type UploadsConfig,
} from './darth-uploads';

export const DARTH_MEDIA_ACCOUNT_ENV = 'DARTH_MEDIA_ACCOUNT';
export const DARTH_MEDIA_CONTAINER_ENV = 'DARTH_MEDIA_CONTAINER';
export const DARTH_MEDIA_CONTAINER_DEFAULT = 'meetings-media';

/** Block size and parallelism of an archive upload (spec Stage A.1). */
export const MEDIA_BLOCK_BYTES = 8 * 1024 * 1024;
export const MEDIA_UPLOAD_PARALLEL = 4;

/**
 * Block size and parallelism of a SERVER-SIDE copy (Stage C, `copyFromUrl`).
 *
 * Bigger blocks than an upload because nothing streams through this process:
 * each block is one `Put Block From URL` call telling the storage front end to
 * fetch that byte range itself. 64 MiB is well inside the 100 MiB per-block
 * limit and keeps a 3 GB recording at ~48 calls; the 50,000-block ceiling is
 * 3.2 TB away.
 */
export const MEDIA_COPY_BLOCK_BYTES = 64 * 1024 * 1024;
export const MEDIA_COPY_PARALLEL = 4;

/**
 * Block ids must be equal-length base64 strings within one blob; a zero-padded
 * decimal index is the simplest thing that is also readable in a block list.
 */
export function copyBlockId(index: number): string {
  return Buffer.from(`mw-copy-${String(index).padStart(6, '0')}`).toString('base64');
}

/** The block plan of a server-side copy: one `Put Block From URL` per entry. */
export function copyBlockPlan(
  totalBytes: number,
  blockBytes = MEDIA_COPY_BLOCK_BYTES
): Array<{ id: string; offset: number; count: number }> {
  const plan: Array<{ id: string; offset: number; count: number }> = [];
  for (let offset = 0, i = 0; offset < totalBytes; offset += blockBytes, i += 1) {
    plan.push({ id: copyBlockId(i), offset, count: Math.min(blockBytes, totalBytes - offset) });
  }
  return plan;
}

/** What `properties` reports about a committed blob. */
export interface MediaBlobProperties {
  bytes: number;
  contentType: string | null;
  /** Azure lower-cases metadata keys on the way out; `sha256` / `kind` here. */
  metadata: Record<string, string>;
}

export interface MediaPutOptions {
  contentType?: string;
  contentDisposition?: string;
  blockBytes?: number;
  parallel?: number;
}

/**
 * The transit seam plus the permanent store's four methods. Everything above it
 * (`media-archive.ts`) is written against this interface and is therefore
 * exercised entirely against the fake.
 */
export interface MediaBlobLike extends BlobLike {
  /** Block-blob upload from a stream. Resolves with the bytes written. */
  putStream(
    blobName: string,
    body: ReadableStream<Uint8Array>,
    opts?: MediaPutOptions
  ): Promise<{ bytes: number }>;
  /** Replace the blob's metadata (the sha256 + kind stamp). */
  setMetadata(blobName: string, metadata: Record<string, string>): Promise<void>;
  /** Size + metadata + content type, or null when the blob does not exist. */
  properties(blobName: string): Promise<MediaBlobProperties | null>;
  /**
   * A BYTE RANGE of the blob, inclusive on both ends (`read` gives the whole
   * thing). Stage B's fallback: a caller that must stay on the app — the
   * player's probe, `?via=app`, darth-cli — and whose local file is gone can
   * still be served, with seeking, by proxying the blob. Rejects when the
   * blob does not exist.
   */
  readRange(blobName: string, start: number, end: number): Promise<ReadableStream<Uint8Array>>;
  /**
   * SERVER-SIDE copy of `totalBytes` from `sourceUrl` (a blob URL carrying its
   * own read SAS — the source may be in another account) into `blobName`.
   * Stage C: the bytes go account → account inside Azure and never cross this
   * VM. Implemented as `Put Block From URL` × N + `Put Block List`, so it is
   * synchronous (we know when it is done), size-unbounded and resumable by
   * simply re-running it — nothing is readable until the block list commits.
   */
  copyFromUrl(
    blobName: string,
    sourceUrl: string,
    totalBytes: number,
    opts?: MediaPutOptions
  ): Promise<{ bytes: number }>;
}

/**
 * `DARTH_MEDIA_ACCOUNT` / `DARTH_MEDIA_CONTAINER`; null while the account is
 * unset. Names only, never a key — the account has `allowSharedKeyAccess=false`
 * and the VM's managed identity is the whole auth story. The two regexes are
 * Azure's own naming rules, the same ones `uploadsConfigFromEnv` applies (that
 * function is keyed to the `DARTH_UPLOADS_*` names, so its messages would name
 * the wrong variable here).
 */
export function mediaConfigFromEnv(
  e: Record<string, string | undefined> = process.env
): UploadsConfig | null {
  const account = (e[DARTH_MEDIA_ACCOUNT_ENV] ?? '').trim();
  if (account === '') return null;
  if (!/^[a-z0-9]{3,24}$/.test(account)) {
    throw new Error(
      `${DARTH_MEDIA_ACCOUNT_ENV} must be a storage account name (3–24 lowercase letters/digits), got ${JSON.stringify(account)}`
    );
  }
  const container = (e[DARTH_MEDIA_CONTAINER_ENV] ?? '').trim() || DARTH_MEDIA_CONTAINER_DEFAULT;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(container)) {
    throw new Error(`${DARTH_MEDIA_CONTAINER_ENV} must be a container name, got ${JSON.stringify(container)}`);
  }
  return { account, container };
}

export type MediaStoreDeps = {
  /** Test seam: the credential (default ManagedIdentityCredential — IMDS on the VM). */
  credential?: TokenCredential;
  now?: () => number;
};

/**
 * The real store: `createAzureBlobStore` for the seam, plus a container client
 * of our own for the four extra methods. ONE credential instance is shared
 * between them so the IMDS token is fetched and cached once.
 */
export function createAzureMediaStore(cfg: UploadsConfig, deps: MediaStoreDeps = {}): MediaBlobLike {
  const credential = deps.credential ?? new ManagedIdentityCredential();
  const base = createAzureBlobStore(cfg, { credential, now: deps.now });
  const container = new BlobServiceClient(blobEndpoint(cfg.account), credential).getContainerClient(
    cfg.container
  );

  return {
    ...base,
    async putStream(blobName, body, opts = {}) {
      let bytes = 0;
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, c) {
            bytes += chunk.byteLength;
            c.enqueue(chunk);
          },
        })
      );
      const readable = Readable.fromWeb(counted as unknown as NodeReadableStream<Uint8Array>);
      await container.getBlockBlobClient(blobName).uploadStream(
        readable,
        opts.blockBytes ?? MEDIA_BLOCK_BYTES,
        opts.parallel ?? MEDIA_UPLOAD_PARALLEL,
        {
          blobHTTPHeaders: {
            ...(opts.contentType ? { blobContentType: opts.contentType } : {}),
            ...(opts.contentDisposition ? { blobContentDisposition: opts.contentDisposition } : {}),
          },
        }
      );
      return { bytes };
    },
    async setMetadata(blobName, metadata) {
      await container.getBlockBlobClient(blobName).setMetadata(metadata);
    },
    async copyFromUrl(blobName, sourceUrl, totalBytes, opts = {}) {
      const client = container.getBlockBlobClient(blobName);
      const plan = copyBlockPlan(totalBytes, opts.blockBytes ?? MEDIA_COPY_BLOCK_BYTES);
      let next = 0;
      const workers = Array.from(
        { length: Math.max(1, Math.min(opts.parallel ?? MEDIA_COPY_PARALLEL, plan.length)) },
        async () => {
          for (;;) {
            const job = plan[next++];
            if (!job) return;
            // The SDK's `offset`/`count` are the SOURCE's byte range; the
            // destination order is decided by the block list below.
            await client.stageBlockFromURL(job.id, sourceUrl, job.offset, job.count);
          }
        }
      );
      await Promise.all(workers);
      await client.commitBlockList(
        plan.map((b) => b.id),
        {
          blobHTTPHeaders: {
            ...(opts.contentType ? { blobContentType: opts.contentType } : {}),
            ...(opts.contentDisposition ? { blobContentDisposition: opts.contentDisposition } : {}),
          },
        }
      );
      return { bytes: totalBytes };
    },
    async readRange(blobName, start, end) {
      // `download(offset, count)` — Azure's count is a LENGTH, the seam's
      // `end` is the last byte, as HTTP Range spells it.
      const res = await container
        .getBlockBlobClient(blobName)
        .download(start, Math.max(0, end - start + 1));
      const body = res.readableStreamBody;
      if (!body) throw new Error(`media-store: empty download body for ${blobName}`);
      return Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
    },
    async properties(blobName) {
      try {
        const p = await container.getBlockBlobClient(blobName).getProperties();
        return {
          bytes: p.contentLength ?? 0,
          contentType: p.contentType ?? null,
          metadata: p.metadata ?? {},
        };
      } catch (e) {
        if (typeof e === 'object' && e !== null && (e as { statusCode?: unknown }).statusCode === 404) {
          return null;
        }
        throw e;
      }
    },
  };
}

/**
 * ONE store per process (the user-delegation key cache lives inside the base
 * store). State on globalThis for the same reason `darth-uploads-store.ts`
 * does it: Next bundles a server module once per route graph.
 */
declare global {
  var __mwMediaStore: { store: MediaBlobLike | null } | undefined;
}

function build(): { store: MediaBlobLike | null } {
  let cfg;
  try {
    cfg = mediaConfigFromEnv();
  } catch (err) {
    console.error('[media-store] bad config — the media archive is disabled:', err);
    return { store: null };
  }
  if (!cfg) return { store: null };
  console.log(`[media-store] archive enabled (account ${cfg.account}, container ${cfg.container})`);
  return { store: createAzureMediaStore(cfg) };
}

/** The permanent media store, or null when this host has none configured. */
export function mediaStore(): MediaBlobLike | null {
  return (globalThis.__mwMediaStore ??= build()).store;
}

/** Tests / the integration check: swap the store (null = unconfigured). */
export function setMediaStoreForTests(store: MediaBlobLike | null): void {
  globalThis.__mwMediaStore = { store };
}

/**
 * `<recording_id>/<media_id><.ext>` — no user id, no filename, no meeting
 * title anywhere in the path (names leak; ids do not). The extension is
 * carried over from the stored filename so the Content-Type a Stage B
 * redirect serves matches the bytes.
 */
export function mediaBlobName(recordingId: string, mediaId: string, filename: string | null): string {
  const m = filename ? /\.[A-Za-z0-9]{1,8}$/.exec(filename) : null;
  return `${recordingId}/${mediaId}${m ? m[0]!.toLowerCase() : ''}`;
}

/**
 * Content-Type from the extension. Same table as the audio route's
 * `mimeFromPath` (an mp4 is served as `video/mp4`: `<audio>` and `<video>`
 * both play it) — kept here rather than imported because that one is private
 * to a route module.
 */
export function mediaContentType(filename: string | null): string {
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'aac':
      return 'audio/mp4';
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'mkv':
      return 'video/x-matroska';
    case 'wav':
      return 'audio/wav';
    case 'webm':
      return 'video/webm';
    case 'ogg':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    default:
      return 'application/octet-stream';
  }
}
