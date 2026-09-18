/**
 * darth uploads — the constants and pure helpers the browser uploader and
 * the /api/uploads routes share for the Azure Blob transit path. Plain
 * module: no server-only, no DOM, no Next.
 *
 * Why this exists (lifted from ../chat, SPEC §20.23 (b), 2026-09-17): every
 * user reaches .6 through one WireGuard stream over the Singapore Tailscale
 * relay, and a multi-hundred-MB body through nginx + Next is one stall away
 * from a 408 (Ivan's phone; Alok's 1.3 GB tray recording on 2026-09-18). A
 * file at or above UPLOAD_BLOB_MIN_BYTES therefore goes browser → Azure Blob
 * (account `darthuploads`, the VM's own region) as parallel 4 MiB blocks
 * with a per-blob user-delegation SAS the app mints; .6 then pulls the
 * committed blob ONCE over the Azure backbone into the same temp file the
 * chunk path writes, and the shared finalize tail runs unchanged.
 *
 * In meetings the blob path is a byte-delivery MODE of the existing chunked
 * upload session (`upload_sessions.via = 'blob'`), not a separate route
 * family: one open call, one resume rule (same user + fingerprint → same
 * session → same blob), one complete, one sweeper. See docs/darth-uploads.md.
 */

/** Below this a file takes the chunk PUTs through the VM; at or above it the blob detour (when the host has it configured). */
export const UPLOAD_BLOB_MIN_BYTES = 8 * 1024 * 1024;
/** One `Put Block` per this many bytes (block ids = the zero-padded block index, base64). */
export const UPLOAD_BLOCK_BYTES = 4 * 1024 * 1024;
/** Blocks in flight at once (a laptop / desktop). */
export const UPLOAD_BLOB_PARALLEL_FINE = 6;
/** Blocks in flight at once on a coarse pointer (a phone; the client sends `coarse: true`). */
export const UPLOAD_BLOB_PARALLEL_COARSE = 3;
/** Write SAS lifetime; past `expiresAt` the client re-opens the session (same fingerprint) and gets a fresh SAS on the SAME blob. */
export const UPLOAD_BLOB_SAS_TTL_MS = 2 * 60 * 60_000;
/** How long the client keeps retrying after the first blob failure before giving up on this attempt (the next pick resumes anyway). */
export const UPLOAD_BLOB_RESUME_WINDOW_MS = 30 * 60_000;
/** Client backoff between resume attempts, seconds; the last value repeats. `online` resumes at once. */
export const UPLOAD_BLOB_RESUME_BACKOFF_S = [1, 2, 4, 8, 15, 30] as const;

export const DARTH_UPLOADS_ACCOUNT_ENV = 'DARTH_UPLOADS_ACCOUNT';
export const DARTH_UPLOADS_CONTAINER_ENV = 'DARTH_UPLOADS_CONTAINER';
/** This app's container in the account (`chat` is the chat app's). */
export const DARTH_UPLOADS_CONTAINER_DEFAULT = 'meetings';

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** What the open call hands the client for a blob session. */
export interface BlobUploadTicket {
  /** `https://<account>.blob.core.windows.net/<container>/<blobName>?<sas>` — Put Block / Get Block List / Put Block List go straight here (racw, this blob only). */
  sasUrl: string;
  blobName: string;
  blockBytes: number;
  parallel: number;
  /** ISO; past it the client re-opens the session for a fresh SAS instead of retrying with the dead one. */
  expiresAt: string;
}

/**
 * Blob name of an upload: `<userId>/<sessionId>/<sanitised name>`. The user
 * id in the path keeps a blob from ever being adopted by another user; the
 * session id (deterministic per open session, and the session is
 * deterministic per user + fingerprint) is what makes a resume find its
 * uncommitted blocks. Pure.
 */
export function uploadBlobName(userId: string, sessionId: string, sanitisedName: string): string {
  return `${userId}/${sessionId}/${sanitisedName || 'upload'}`;
}

/** File-name sanitiser shared with the server module (ASCII letters, digits, `.`, `_`, `-`; runs collapsed; capped). Pure. */
export function sanitizeBlobFileName(name: string, max = 120): string {
  let s = String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '');
  s = s.replace(/\.{2,}/g, '.');
  if (s.length > max) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, max - ext.length) + ext;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Azure Blob REST helpers the browser needs (pure)

/** Block id of block `index`: a zero-padded decimal in base64 — every id the same length, as Blob requires. Pure. */
export function blockIdOf(index: number): string {
  return base64(String(index).padStart(6, '0'));
}

function base64(s: string): string {
  if (typeof btoa === 'function') return btoa(s);
  return Buffer.from(s, 'binary').toString('base64');
}

/** `<sasUrl>&comp=…` — the SAS URL already carries a query string. Pure. */
export function withQuery(sasUrl: string, extra: Record<string, string>): string {
  const u = new URL(sasUrl);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

/** `<Name>…</Name><Size>…</Size>` pairs under `<UncommittedBlocks>`. Pure. */
export function parseUncommitted(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  const section = /<UncommittedBlocks>([\s\S]*?)<\/UncommittedBlocks>/.exec(xml)?.[1] ?? '';
  for (const m of section.matchAll(/<Block>\s*<Name>([^<]*)<\/Name>\s*<Size>(\d+)<\/Size>\s*<\/Block>/g)) {
    out.set(m[1]!, Number(m[2]));
  }
  return out;
}

/** The block list body for a commit: every block id in order, as `<Latest>`. Pure. */
export function blockListXml(ids: readonly string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
}

/** The blocks of a file: [index, start, end) per `blockBytes`-sized piece. Pure. */
export function blocksOf(size: number, blockBytes: number): Array<{ index: number; start: number; end: number }> {
  const out: Array<{ index: number; start: number; end: number }> = [];
  for (let i = 0, start = 0; start < size; i++, start += blockBytes) {
    out.push({ index: i, start, end: Math.min(size, start + blockBytes) });
  }
  return out;
}

/** Seconds to wait before attempt `n` (1-based) — the schedule, the last value repeating. Pure. */
export function backoffSeconds(
  attempt: number,
  schedule: readonly number[] = UPLOAD_BLOB_RESUME_BACKOFF_S
): number {
  const i = Math.max(0, Math.min(schedule.length - 1, attempt - 1));
  return schedule[i] ?? 30;
}
