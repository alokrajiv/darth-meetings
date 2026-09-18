/**
 * The browser's half of darth uploads (lifted from ../chat's
 * upload-resumable.ts, E8c-7): PUT a file's 4 MiB blocks straight to the
 * session's SAS URL, `parallel` at a time, then commit the block list.
 * Plain module (fetch + Blob only, no DOM, no 'use client') so `bun test`
 * drives it against the fake blob server exactly as the browser would.
 *
 * Resume rules (the whole point): EVERY attempt starts by asking Blob for
 * the uncommitted block list with the SAS and skips the blocks already
 * there — so a network drop, a 5xx, a 408, `offline`, or a reload mid-way
 * never costs the bytes already acknowledged. After any failure the next
 * attempt waits UPLOAD_BLOB_RESUME_BACKOFF_S (1, 2, 4, 8, 15, 30 s; the last
 * repeats) unless the browser fires `online` first, and the attempts stop
 * after UPLOAD_BLOB_RESUME_WINDOW_MS — the next pick of the same file resumes
 * anyway because the blob is keyed on the upload session (same user +
 * fingerprint). A SAS past `expiresAt` (or a 401/403 from Blob) is replaced
 * through `renewTicket` — the same blob, a fresh signature.
 *
 * Azure REST subset used: PUT ?comp=block&blockid=, GET
 * ?comp=blocklist&blocklisttype=uncommitted, PUT ?comp=blocklist, HEAD
 * (committed?). Block ids are the zero-padded block index in base64. The
 * blob calls are cross-origin fetches with no credentials — the SAS is the
 * credential (CORS for this app's origin is set on the account).
 */
import {
  UPLOAD_BLOB_RESUME_BACKOFF_S,
  UPLOAD_BLOB_RESUME_WINDOW_MS,
  backoffSeconds,
  blockIdOf,
  blockListXml,
  blocksOf,
  parseUncommitted,
  withQuery,
  type BlobUploadTicket,
} from './darth-uploads-shared';

export class BlobUploadError extends Error {
  constructor(
    message: string,
    /** HTTP status of the failing blob call (0 = network). */
    public status = 0
  ) {
    super(message);
    this.name = 'BlobUploadError';
  }
}

export interface BlobBlocksOpts {
  file: Blob;
  ticket: BlobUploadTicket;
  /** A fresh SAS on the SAME blob (the current one expired or Blob answered 401/403). */
  renewTicket: () => Promise<BlobUploadTicket>;
  /** Bytes Blob has acknowledged, out of file.size. */
  onProgress?: (acked: number, total: number) => void;
  /** Blob already held this many bytes when an attempt started (a resume). */
  onResumed?: (acked: number, total: number) => void;
  /** Human-readable phase changes ("Paused — reconnecting…"). */
  onNote?: (note: string | null) => void;
  signal?: AbortSignal;
  // ---- seams (tests) ----
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isOnline?: () => boolean;
  /** Subscribe to `online`; returns the unsubscribe. */
  onOnline?: (fn: () => void) => () => void;
  backoffS?: readonly number[];
  resumeWindowMs?: number;
  /** Per-call timeout for one block PUT (default 180 s, like the chunk path). */
  blockTimeoutMs?: number;
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Upload cancelled', 'AbortError');
  return Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultOnOnline(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', fn);
  return () => window.removeEventListener('online', fn);
}

/** Wait for the backoff OR `online`, whichever first. */
async function pause(
  ms: number,
  o: { sleep: NonNullable<BlobBlocksOpts['sleep']>; onOnline: NonNullable<BlobBlocksOpts['onOnline']> },
  signal?: AbortSignal
): Promise<void> {
  let resolveOnline: (() => void) | null = null;
  const online = new Promise<void>((r) => {
    resolveOnline = r;
  });
  const off = o.onOnline(() => resolveOnline?.());
  try {
    await Promise.race([o.sleep(ms, signal), online]);
  } finally {
    off();
  }
}

/** A signal that fires when `outer` aborts OR after `ms`. */
function timeoutSignal(outer: AbortSignal, ms: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  outer.addEventListener('abort', onOuter, { once: true });
  const t = setTimeout(() => ac.abort(), ms);
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(t);
      outer.removeEventListener('abort', onOuter);
    },
  };
}

/**
 * Upload every block of `file` to the blob and commit it. Resolves once the
 * block list is committed (or was already — a HEAD finds the whole blob).
 * Rejects with an AbortError (`signal`) or the last BlobUploadError once
 * the resume window is spent.
 */
export async function uploadBlobBlocks(opts: BlobBlocksOpts): Promise<void> {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const isOnline =
    opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const onOnline = opts.onOnline ?? defaultOnOnline;
  const backoffS = opts.backoffS ?? UPLOAD_BLOB_RESUME_BACKOFF_S;
  const windowMs = opts.resumeWindowMs ?? UPLOAD_BLOB_RESUME_WINDOW_MS;
  const blockTimeoutMs = opts.blockTimeoutMs ?? 180_000;
  const { file, signal } = opts;
  let ticket = opts.ticket;
  const total = file.size;
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };

  const blocks = blocksOf(total, ticket.blockBytes);
  const ids = blocks.map((b) => blockIdOf(b.index));

  let attempt = 0;
  let firstFailureAt: number | null = null;
  let acked = 0;
  for (;;) {
    throwIfAborted();
    const attemptAc = new AbortController();
    const onOuterAbort = () => attemptAc.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      if (new Date(ticket.expiresAt).getTime() <= now()) ticket = await opts.renewTicket();
      // Already committed (a previous attempt got past the block list, or a
      // reload after the commit)? Straight to complete.
      const head = await fetchFn(ticket.sasUrl, { method: 'HEAD', signal: attemptAc.signal });
      if (head.status === 200 && Number(head.headers.get('content-length')) === total) {
        acked = total;
        opts.onProgress?.(acked, total);
        break;
      }
      if (head.status === 403 || head.status === 401) {
        throw new BlobUploadError('the upload link expired', head.status);
      }
      // The uncommitted blocks Blob already holds: skipped below.
      const listed = await fetchFn(withQuery(ticket.sasUrl, { comp: 'blocklist', blocklisttype: 'uncommitted' }), {
        signal: attemptAc.signal,
      });
      let have = new Map<string, number>();
      if (listed.status === 200) have = parseUncommitted(await listed.text());
      else if (listed.status === 403 || listed.status === 401) {
        throw new BlobUploadError('the upload link expired', listed.status);
      } else if (listed.status !== 404) {
        throw new BlobUploadError(`block list failed (${listed.status})`, listed.status);
      }
      const done = new Set<number>();
      acked = 0;
      for (const b of blocks) {
        if (have.get(ids[b.index]!) === b.end - b.start) {
          done.add(b.index);
          acked += b.end - b.start;
        }
      }
      if (acked > 0) opts.onResumed?.(acked, total);
      opts.onProgress?.(acked, total);
      opts.onNote?.(null);

      const pending = blocks.filter((b) => !done.has(b.index));
      let next = 0;
      let failed: unknown = null;
      const worker = async () => {
        while (next < pending.length && !failed && !attemptAc.signal.aborted) {
          const b = pending[next++]!;
          const t = timeoutSignal(attemptAc.signal, blockTimeoutMs);
          let res: Response;
          try {
            res = await fetchFn(withQuery(ticket.sasUrl, { comp: 'block', blockid: ids[b.index]! }), {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: file.slice(b.start, b.end),
              signal: t.signal,
            });
          } catch (e) {
            if (isAbortError(e) && !attemptAc.signal.aborted && !signal?.aborted) {
              throw new BlobUploadError(`block ${b.index + 1} timed out`, 0);
            }
            throw e;
          } finally {
            t.clear();
          }
          if (!(res.status >= 200 && res.status < 300)) {
            throw new BlobUploadError(`block ${b.index + 1}/${blocks.length} failed (${res.status})`, res.status);
          }
          acked += b.end - b.start;
          opts.onProgress?.(acked, total);
        }
      };
      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.max(1, ticket.parallel); i++) {
        workers.push(
          worker().catch((e) => {
            failed = failed ?? e;
            attemptAc.abort();
          })
        );
      }
      await Promise.all(workers);
      if (failed) throw failed;
      throwIfAborted();
      // Commit.
      const commit = await fetchFn(withQuery(ticket.sasUrl, { comp: 'blocklist' }), {
        method: 'PUT',
        headers: {
          'content-type': 'application/xml',
          'x-ms-blob-content-type': file.type || 'application/octet-stream',
        },
        body: blockListXml(ids),
        signal: signal ?? attemptAc.signal,
      });
      if (!(commit.status >= 200 && commit.status < 300)) {
        throw new BlobUploadError(`commit failed (${commit.status})`, commit.status);
      }
      break;
    } catch (e) {
      if (signal?.aborted) throw abortError();
      attempt += 1;
      firstFailureAt = firstFailureAt ?? now();
      const message = e instanceof Error ? e.message : String(e);
      if (now() - firstFailureAt > windowMs) {
        throw e instanceof BlobUploadError ? e : new BlobUploadError(message);
      }
      opts.onNote?.(`Connection hiccup — reconnecting (attempt ${attempt + 1})`);
      // A dead SAS: a new ticket for the same blob on the next attempt.
      if (e instanceof BlobUploadError && (e.status === 403 || e.status === 401)) {
        ticket = await opts.renewTicket();
      }
      const wait = isOnline() ? backoffSeconds(attempt, backoffS) * 1000 : windowMs;
      await pause(wait, { sleep, onOnline }, signal);
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
  opts.onNote?.(null);
}
