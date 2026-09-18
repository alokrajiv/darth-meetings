import 'server-only';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import {
  DARTH_UPLOADS_CONTAINER_DEFAULT,
  UPLOAD_BLOB_MIN_BYTES,
  UPLOAD_BLOB_PARALLEL_COARSE,
  UPLOAD_BLOB_PARALLEL_FINE,
  UPLOAD_BLOCK_BYTES,
  type BlobUploadTicket,
} from '@/lib/darth-uploads-shared';
import {
  BlobHashMismatchError,
  createAzureBlobStore,
  createUploadTicket,
  pullBlob,
  uploadsConfigFromEnv,
  type BlobLike,
} from './darth-uploads';
import { createRestBlobStore } from './darth-uploads-rest';
import { ensureAudioDir, resolveAudioPath } from './audio-storage';

/**
 * The meetings app's handle on the darth-uploads transit store: ONE
 * `BlobLike` per process (the user-delegation key cache lives inside it),
 * built lazily from `DARTH_UPLOADS_ACCOUNT` / `DARTH_UPLOADS_CONTAINER`
 * (default "meetings"). Unset account → null → every upload takes the chunk
 * path through the VM, exactly as before. Never touched at build time.
 *
 * `DARTH_UPLOADS_FAKE_URL` (loopback only) swaps the real account for the
 * REST fake so an E2E on the laptop can run the real request shapes against
 * a fake blob server; refused for any non-loopback URL.
 *
 * State lives on globalThis: Next bundles a server module more than once, so
 * a module-level singleton would be per-bundle (and mint one delegation key
 * per bundle).
 */
declare global {
  var __mwDarthUploadsStore: { store: BlobLike | null; fake: boolean } | undefined;
}

export const DARTH_UPLOADS_FAKE_URL_ENV = 'DARTH_UPLOADS_FAKE_URL';

function build(): { store: BlobLike | null; fake: boolean } {
  let config;
  try {
    config = uploadsConfigFromEnv(process.env, DARTH_UPLOADS_CONTAINER_DEFAULT);
  } catch (err) {
    console.error('[darth-uploads] bad config — blob transit disabled:', err);
    return { store: null, fake: false };
  }
  if (!config) return { store: null, fake: false };
  const fakeUrl = (process.env[DARTH_UPLOADS_FAKE_URL_ENV] ?? '').trim();
  if (fakeUrl !== '') {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(fakeUrl)) {
      console.error(`[darth-uploads] ${DARTH_UPLOADS_FAKE_URL_ENV} must be a loopback http URL — blob transit disabled`);
      return { store: null, fake: false };
    }
    console.log(`[darth-uploads] FAKE blob endpoint ${fakeUrl} (E2E)`);
    return {
      store: createRestBlobStore({ baseUrl: fakeUrl, container: config.container, account: config.account }),
      fake: true,
    };
  }
  console.log(`[darth-uploads] blob transit enabled (account ${config.account}, container ${config.container})`);
  return { store: createAzureBlobStore(config), fake: false };
}

/** The transit store, or null when this host has none configured. */
export function uploadsStore(): BlobLike | null {
  return (globalThis.__mwDarthUploadsStore ??= build()).store;
}

/** Tests / E2E: swap the store (null = unconfigured). */
export function setUploadsStoreForTests(store: BlobLike | null, fake = true): void {
  globalThis.__mwDarthUploadsStore = { store, fake };
}

/** Whether an upload of `size` bytes takes the blob detour on this host. */
export function blobTransitFor(size: number): BlobLike | null {
  if (size < UPLOAD_BLOB_MIN_BYTES) return null;
  return uploadsStore();
}

/** Mint (or re-mint) the write SAS for a blob session — same blob name every time. */
export async function mintBlobTicket(
  store: BlobLike,
  p: { userId: string; sessionId: string; filename: string | null; coarse: boolean }
): Promise<BlobUploadTicket> {
  const minted = await createUploadTicket(store, {
    userId: p.userId,
    sessionId: p.sessionId,
    name: p.filename ?? 'upload',
  });
  return {
    sasUrl: minted.sasUrl,
    blobName: minted.blobName,
    blockBytes: UPLOAD_BLOCK_BYTES,
    parallel: p.coarse ? UPLOAD_BLOB_PARALLEL_COARSE : UPLOAD_BLOB_PARALLEL_FINE,
    expiresAt: minted.expiresAt.toISOString(),
  };
}

export type PullOutcome =
  | { ok: true; bytes: number; sha256: string; ms: number }
  | { ok: false; kind: 'mismatch' | 'error'; error: string };

/**
 * Pull the committed blob into the session's temp file in the audio dir,
 * hashing on the way. A size or sha256 mismatch deletes the blob (never
 * adopt bytes that are not the file) and reports `mismatch`; any other
 * failure leaves the blob for a retry. The temp file is (re)created from
 * scratch — a blob session never has partial bytes on the VM.
 */
export async function pullBlobToTemp(
  store: BlobLike,
  p: { blobName: string; sha256: string; size: number; tempFilename: string; onProgress?: (bytes: number) => void }
): Promise<PullOutcome> {
  await ensureAudioDir();
  const abs = resolveAudioPath(p.tempFilename);
  const ws = createWriteStream(abs, { flags: 'w' });
  const writable = Writable.toWeb(ws) as unknown as WritableStream<Uint8Array>;
  const writer = writable.getWriter();
  try {
    const pulled = await pullBlob(store, {
      blobName: p.blobName,
      sha256: p.sha256,
      size: p.size,
      sink: {
        write: (c) => writer.write(c),
        end: () => writer.close(),
        abort: async () => {
          await writer.abort().catch(() => {});
        },
      },
      onProgress: p.onProgress,
    });
    return { ok: true, ...pulled };
  } catch (err) {
    if (err instanceof BlobHashMismatchError) {
      return {
        ok: false,
        kind: 'mismatch',
        error: `${err.message} (expected ${err.expected.size} B / ${err.expected.sha256.slice(0, 12)}…, got ${err.actual.size} B / ${err.actual.sha256?.slice(0, 12) ?? '?'}…)`,
      };
    }
    return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
