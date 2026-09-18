/**
 * darth uploads — Azure Blob transit storage for big uploads and downloads
 * (E8c-7, SPEC §20.23 (b)). The reusable unit: no Next imports, no app state,
 * so `../meetings` lifts this file verbatim with `container: "meetings"`.
 *
 * What it is: a browser uploads a big file straight to a block blob in the
 * account `darthuploads` (southeastasia — the VM's region) with a per-blob
 * user-delegation SAS the app mints; the app then pulls the committed blob
 * ONCE over the Azure backbone into the person's home (`pullBlob` → the
 * caller's sink, which is today's spool + `docker.copyIn` path), verifying the
 * sha256 on the way, and deletes it. Downloads push the other way (`pushBlob`
 * → a READ-only SAS the browser is redirected to). Transit storage, never a
 * filesystem: nothing is mounted anywhere; the account's lifecycle rule
 * (delete 1 day after last write) is only the safety net.
 *
 * Auth: the VM's system-assigned managed identity (IMDS token) holds Storage
 * Blob Data Contributor on the account; `getUserDelegationKey` (cached until
 * ~10 min before its expiry) signs every SAS. No account key exists on disk
 * or in `.env` (`allowSharedKeyAccess=false` on the account): config is the
 * ACCOUNT and CONTAINER names only. Unconfigured (no account) → `storeFromEnv`
 * answers null and the routes 503 UPLOADS_UNCONFIGURED_MESSAGE.
 *
 * `BlobLike` is the seam: `createAzureBlobStore` is the real thing;
 * test/helpers/fake-blob.ts is the in-memory fake every unit test uses;
 * darth-uploads-rest.ts is the plain-REST store the browser rig points at its
 * fake server (DARTH_UPLOADS_FAKE_URL). Everything above the seam
 * (`createUploadTicket`, `createDownloadSas`, `pullBlob`, `pushBlob`) is
 * exercised against the fake and proven live on .6 against the account.
 *
 * Node runtime only (`node:crypto`, `node:stream`): route modules run under
 * `next start`; no Bun globals.
 *
 * LIFTED VERBATIM from ../chat/src/lib/darth-uploads.ts (E8c-7, 2026-09-17)
 * into ../meetings on 2026-09-18 — only the two imports changed (the shared
 * constants live in src/lib/darth-uploads-shared.ts here, and the blob name
 * is keyed on the upload SESSION id — see that file). Keep the two copies in
 * step; the chat repo is the source of truth for everything below the seam.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ManagedIdentityCredential, type TokenCredential } from "@azure/identity";
import { BlobSASPermissions, BlobServiceClient, SASProtocol, generateBlobSASQueryParameters, type UserDelegationKey } from "@azure/storage-blob";
import { DARTH_UPLOADS_ACCOUNT_ENV, DARTH_UPLOADS_CONTAINER_DEFAULT, DARTH_UPLOADS_CONTAINER_ENV, UPLOAD_BLOB_SAS_TTL_MS as UPLOAD_TICKET_TTL_MS, sanitizeBlobFileName as sanitizeFileName, uploadBlobName } from "../darth-uploads-shared";

/** Read SAS lifetime for a staged download (unused by meetings today; kept so the module stays verbatim). */
export const DOWNLOAD_SAS_TTL_MS = 15 * 60_000;
export const UPLOAD_HASH_MISMATCH_TEXT = "the uploaded bytes do not match the file — pick it again";
const downloadBlobName = (userId: string, token: string, sanitisedName: string): string => `${userId}/downloads/${token}/${sanitisedName}`;

// ---------------------------------------------------------------------------
// The seam

/** The SAS permissions the app mints: `racw` on ONE blob for an upload ticket (read + add + create + write, no delete, no list), `r` for a download. */
export type BlobSasPermissions = "racw" | "r";

/** One uncommitted (staged) block of a block blob, as `Get Block List?blocklisttype=uncommitted` reports it. */
export type UncommittedBlock = { id: string; size: number };

/**
 * What the module needs from a blob container. Every method takes the blob
 * NAME (path inside the container); the container is fixed per store.
 */
export interface BlobLike {
  readonly account: string;
  readonly container: string;
  /** A URL to `blobName` carrying a SAS with `perms`, valid until `expiresAt` (HTTPS only on the real account). */
  sasUrl(blobName: string, perms: BlobSasPermissions, expiresAt: Date): Promise<string>;
  /** The committed blob's size, or null when it does not exist (uncommitted blocks alone do not make a blob). */
  stat(blobName: string): Promise<{ bytes: number } | null>;
  /** The staged blocks of a blob (the client asks Blob directly with its SAS on a resume; the server uses this for tests and diagnostics). */
  uncommittedBlocks(blobName: string): Promise<UncommittedBlock[]>;
  /** The committed blob's bytes as a stream. Rejects when it does not exist. */
  read(blobName: string): Promise<ReadableStream<Uint8Array>>;
  /** Create / replace the blob from a stream (block blob). Resolves with the bytes written. */
  write(blobName: string, body: ReadableStream<Uint8Array>, opts?: { contentType?: string }): Promise<{ bytes: number }>;
  /** Delete the blob (committed or staged blocks only); true when something was there. Never throws on a missing blob. */
  delete(blobName: string): Promise<boolean>;
}

export type UploadsConfig = { account: string; container: string };

/** Anything env-shaped: process.env or a plain record in a test. */
export type EnvSource = Record<string, string | undefined>;

/** `DARTH_UPLOADS_ACCOUNT` / `DARTH_UPLOADS_CONTAINER` (default "chat"); null while the account is unset — names only, never a key. */
export function uploadsConfigFromEnv(e: EnvSource = process.env, defaultContainer = DARTH_UPLOADS_CONTAINER_DEFAULT): UploadsConfig | null {
  const account = (e[DARTH_UPLOADS_ACCOUNT_ENV] ?? "").trim();
  if (account === "") return null;
  if (!/^[a-z0-9]{3,24}$/.test(account)) throw new Error(`${DARTH_UPLOADS_ACCOUNT_ENV} must be a storage account name (3–24 lowercase letters/digits), got ${JSON.stringify(account)}`);
  const container = (e[DARTH_UPLOADS_CONTAINER_ENV] ?? "").trim() || defaultContainer;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(container)) throw new Error(`${DARTH_UPLOADS_CONTAINER_ENV} must be a container name, got ${JSON.stringify(container)}`);
  return { account, container };
}

// ---------------------------------------------------------------------------
// The real store: @azure/storage-blob over the VM's managed identity

/** The blob endpoint of an account (the public cloud; nothing here runs elsewhere). */
export const blobEndpoint = (account: string): string => `https://${account}.blob.core.windows.net`;

/** User-delegation keys are requested for this long; a key is re-fetched when less than the longest SAS TTL + 10 min remains. */
export const DELEGATION_KEY_TTL_MS = 8 * 60 * 60_000;
export const DELEGATION_KEY_REFRESH_MARGIN_MS = UPLOAD_TICKET_TTL_MS + 10 * 60_000;
/** SAS `startsOn` is backdated by this much: the VM's clock vs the storage front end. */
export const SAS_CLOCK_SKEW_MS = 5 * 60_000;

export type AzureStoreDeps = {
  /** Test seam: the credential (default ManagedIdentityCredential — IMDS on the VM). */
  credential?: TokenCredential;
  now?: () => number;
};

export function createAzureBlobStore(cfg: UploadsConfig, deps: AzureStoreDeps = {}): BlobLike {
  const now = deps.now ?? (() => Date.now());
  const credential = deps.credential ?? new ManagedIdentityCredential();
  const service = new BlobServiceClient(blobEndpoint(cfg.account), credential);
  const container = service.getContainerClient(cfg.container);
  let key: { value: UserDelegationKey; expiresAt: number } | null = null;
  let keyInflight: Promise<UserDelegationKey> | null = null;

  /** The cached user-delegation key, refreshed while at least DELEGATION_KEY_REFRESH_MARGIN_MS remains. Single-flight. */
  async function delegationKey(): Promise<UserDelegationKey> {
    if (key && key.expiresAt - now() > DELEGATION_KEY_REFRESH_MARGIN_MS) return key.value;
    if (keyInflight) return keyInflight;
    keyInflight = (async () => {
      const startsOn = new Date(now() - SAS_CLOCK_SKEW_MS);
      const expiresOn = new Date(now() + DELEGATION_KEY_TTL_MS);
      const value = await service.getUserDelegationKey(startsOn, expiresOn);
      key = { value, expiresAt: expiresOn.getTime() };
      return value;
    })();
    try {
      return await keyInflight;
    } finally {
      keyInflight = null;
    }
  }

  return {
    account: cfg.account,
    container: cfg.container,
    async sasUrl(blobName, perms, expiresAt) {
      const k = await delegationKey();
      const sas = generateBlobSASQueryParameters(
        {
          containerName: cfg.container,
          blobName,
          permissions: BlobSASPermissions.parse(perms),
          startsOn: new Date(now() - SAS_CLOCK_SKEW_MS),
          expiresOn: expiresAt,
          protocol: SASProtocol.Https,
        },
        k,
        cfg.account,
      ).toString();
      return `${container.getBlockBlobClient(blobName).url}?${sas}`;
    },
    async stat(blobName) {
      const client = container.getBlockBlobClient(blobName);
      try {
        const p = await client.getProperties();
        return { bytes: p.contentLength ?? 0 };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async uncommittedBlocks(blobName) {
      const client = container.getBlockBlobClient(blobName);
      try {
        const list = await client.getBlockList("uncommitted");
        return (list.uncommittedBlocks ?? []).map((b) => ({ id: b.name, size: b.size }));
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
    },
    async read(blobName) {
      const res = await container.getBlockBlobClient(blobName).download();
      const body = res.readableStreamBody;
      if (!body) throw new Error(`darth-uploads: empty download body for ${blobName}`);
      return Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
    },
    async write(blobName, body, opts = {}) {
      let bytes = 0;
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, c) {
            bytes += chunk.byteLength;
            c.enqueue(chunk);
          },
        }),
      );
      const readable = Readable.fromWeb(counted as unknown as NodeReadableStream<Uint8Array>);
      await container.getBlockBlobClient(blobName).uploadStream(readable, 4 * 1024 * 1024, 4, opts.contentType ? { blobHTTPHeaders: { blobContentType: opts.contentType } } : undefined);
      return { bytes };
    },
    async delete(blobName) {
      const r = await container.getBlockBlobClient(blobName).deleteIfExists();
      return r.succeeded;
    },
  };
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { statusCode?: unknown }).statusCode === 404;
}

// ---------------------------------------------------------------------------
// Above the seam: tickets, SAS, pull, push

export type UploadTicketInput = {
  userId: string;
  /** The sent name; sanitised into the blob name (the finalising route sanitises again for the home). */
  name: string;
  /** meetings: the upload session id — the blob name is `<userId>/<sessionId>/<name>` (chat keys on sha256 + size instead). */
  sessionId: string;
  ttlMs?: number;
  now?: () => number;
};

export type UploadTicketOut = { blobName: string; sasUrl: string; expiresAt: Date };

/**
 * A write ticket: blob name `<userId>/<sessionId>/<sanitised name>` (deterministic —
 * the same open session always maps to the same blob, which is what makes a
 * resume find its uncommitted blocks) and a `racw` SAS on that one blob for
 * `ttlMs` (default UPLOAD_TICKET_TTL_MS = UPLOAD_BLOB_SAS_TTL_MS).
 */
export async function createUploadTicket(store: BlobLike, o: UploadTicketInput): Promise<UploadTicketOut> {
  const now = o.now ?? (() => Date.now());
  const blobName = uploadBlobName(o.userId, o.sessionId, sanitizeFileName(o.name));
  const expiresAt = new Date(now() + (o.ttlMs ?? UPLOAD_TICKET_TTL_MS));
  const sasUrl = await store.sasUrl(blobName, "racw", expiresAt);
  return { blobName, sasUrl, expiresAt };
}

export type DownloadSasInput = { blobName: string; ttlMs?: number; now?: () => number };

/** A READ-only SAS on one staged download blob for `ttlMs` (default DOWNLOAD_SAS_TTL_MS). */
export async function createDownloadSas(store: BlobLike, o: DownloadSasInput): Promise<{ url: string; expiresAt: Date }> {
  const now = o.now ?? (() => Date.now());
  const expiresAt = new Date(now() + (o.ttlMs ?? DOWNLOAD_SAS_TTL_MS));
  return { url: await store.sasUrl(o.blobName, "r", expiresAt), expiresAt };
}

/** Where a staged download lives: `<userId>/downloads/<token>/<sanitised name>` (the token is the caller's random id). */
export function stagedDownloadName(userId: string, token: string, name: string): string {
  return downloadBlobName(userId, token, sanitizeFileName(name));
}

/** Thrown by pullBlob when the committed blob's bytes do not hash to the ticket's sha256 (or the size differs); the blob is deleted first. */
export class BlobHashMismatchError extends Error {
  constructor(
    readonly blobName: string,
    readonly expected: { sha256: string; size: number },
    readonly actual: { sha256: string | null; size: number },
  ) {
    super(UPLOAD_HASH_MISMATCH_TEXT);
    this.name = "BlobHashMismatchError";
  }
}

/** Where pullBlob writes: today's spool file (SpoolWriter-like), or anything the caller wants. `abort` discards what was written. */
export type PullSink = {
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
};

export type PullInput = {
  blobName: string;
  sha256: string;
  size: number;
  sink: PullSink;
  /** Bytes pulled so far (every chunk). */
  onProgress?: (bytes: number) => void;
  now?: () => number;
};

/**
 * Stream the committed blob into `sink`, hashing on the way. The size is
 * checked as bytes arrive (a blob larger than the ticket is cut off at once)
 * and the sha256 at the end; a mismatch aborts the sink, DELETES the blob
 * (never adopt bytes that are not the file) and throws BlobHashMismatchError.
 * Any other failure aborts the sink and rethrows; the blob stays for a retry.
 */
export async function pullBlob(store: BlobLike, o: PullInput): Promise<{ bytes: number; sha256: string; ms: number }> {
  const now = o.now ?? (() => Date.now());
  const t0 = now();
  const hash = createHash("sha256");
  let bytes = 0;
  let mismatch: BlobHashMismatchError | null = null;
  const reader = (await store.read(o.blobName)).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      bytes += value.byteLength;
      if (bytes > o.size) {
        mismatch = new BlobHashMismatchError(o.blobName, { sha256: o.sha256, size: o.size }, { sha256: null, size: bytes });
        break;
      }
      hash.update(value);
      await o.sink.write(value);
      o.onProgress?.(bytes);
    }
    if (!mismatch) {
      const digest = hash.digest("hex");
      if (bytes !== o.size || digest !== o.sha256) mismatch = new BlobHashMismatchError(o.blobName, { sha256: o.sha256, size: o.size }, { sha256: digest, size: bytes });
      else {
        await o.sink.end();
        return { bytes, sha256: digest, ms: now() - t0 };
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    await o.sink.abort().catch(() => {});
    throw e;
  }
  await reader.cancel().catch(() => {});
  await o.sink.abort().catch(() => {});
  await store.delete(o.blobName).catch(() => {});
  throw mismatch;
}

export type PushInput = {
  blobName: string;
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  /** Bytes pushed so far (every chunk). */
  onProgress?: (bytes: number) => void;
  now?: () => number;
};

/**
 * Stream bytes (a `docker exec cat` out of the container, already through
 * the creds scanner) into a block blob for a staged download. A failure
 * mid-way deletes what was staged and rethrows.
 */
export async function pushBlob(store: BlobLike, o: PushInput): Promise<{ bytes: number; ms: number }> {
  const now = o.now ?? (() => Date.now());
  const t0 = now();
  let seen = 0;
  const counted = o.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        seen += chunk.byteLength;
        o.onProgress?.(seen);
        c.enqueue(chunk);
      },
    }),
  );
  try {
    const { bytes } = await store.write(o.blobName, counted, { contentType: o.contentType });
    return { bytes, ms: now() - t0 };
  } catch (e) {
    await store.delete(o.blobName).catch(() => {});
    throw e;
  }
}

/** Delete a blob (idempotent; a missing blob is fine). */
export async function deleteBlob(store: BlobLike, blobName: string): Promise<boolean> {
  return store.delete(blobName);
}

/**
 * Delete `blobName` after `afterMs` (a staged download once its SAS expired).
 * In-process, `unref`'d so it never keeps the process alive; the account's
 * lifecycle rule is the safety net for a process that restarted meanwhile.
 */
export function scheduleBlobDelete(store: BlobLike, blobName: string, afterMs: number, log?: (line: string) => void): () => void {
  const t = setTimeout(() => {
    void store.delete(blobName).catch((e) => log?.(`darth-uploads: sweep of ${blobName} failed: ${e instanceof Error ? e.message : String(e)}`));
  }, afterMs);
  t.unref?.();
  return () => clearTimeout(t);
}
