'use client';

import type { StoredTranscript } from '@/lib/format';
import { chunkByteRange } from '@/lib/upload-chunking';

/**
 * Chunked, parallel, resumable browser upload against /api/uploads.
 *
 *   1. fingerprint the file (cheap: size + mtime + name + 3 sampled MBs)
 *   2. POST /api/uploads → session (existing one comes back with the chunks
 *      already on the server — that's resume)
 *   3. PUT the missing chunks, PARALLELISM at a time, each retried with
 *      backoff until the server acknowledges it (length + sha256 verified)
 *   4. POST …/complete → the transcript row (falls back to polling the
 *      session when the complete response itself gets lost)
 *
 * Why parallel: one TCP stream over a long, lossy mobile path (Indonesia →
 * SG) crawls no matter the bandwidth; 4 streams fill the pipe. Why chunks:
 * a drop costs one chunk, not the file — and a re-dropped file continues
 * where it stopped, even after a reload.
 */

export const PARALLELISM = 4;
const MAX_CHUNK_ATTEMPTS = 40;
const BACKOFF_CAP_MS = 15_000;
const SAMPLE_BYTES = 1024 * 1024;

export interface ChunkedUploadParams {
  languageCode?: string;
  linkedEvent?: unknown | null;
  reportPref?: string | null;
  sourceId?: string | null;
  multi?: { group: string; index: number; total: number; comment?: string } | null;
  /** Temporary transcript (migration 042): out of the archive, under the
   * Temporary tab, auto-trashed after 30 days. Server ignores it when
   * `linkedEvent` is set. */
  scratch?: boolean;
}

export interface ChunkedUploadHooks {
  /** Bytes confirmed or in flight, out of file.size. */
  onProgress?: (loaded: number, total: number) => void;
  /** The server already held this many bytes — the upload is resuming. */
  onResumed?: (receivedBytes: number, total: number) => void;
  /** Human-readable phase changes ("Retrying chunk 12…", "Finalizing…"). */
  onNote?: (note: string | null) => void;
  signal?: AbortSignal;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

interface SessionReply {
  id: string;
  chunkSize: number;
  chunkCount: number;
  received: number[];
  resumed: boolean;
  transcript: StoredTranscript;
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Content fingerprint without reading the whole file: size, mtime, name and
 * three 1MB samples (head, middle, tail) hashed together. Whole-file
 * integrity is guaranteed separately — every chunk is SHA-256 verified on
 * the server before it is acknowledged. Multi-file group parts add the
 * group id so a fresh stitch attempt never resumes into an old group.
 */
export async function fingerprintFile(
  file: File,
  multi?: ChunkedUploadParams['multi']
): Promise<string> {
  const parts: BlobPart[] = [];
  const meta = `${file.size}|${file.lastModified}|${file.name}`;
  parts.push(meta);
  if (file.size <= SAMPLE_BYTES * 3) {
    parts.push(file);
  } else {
    const mid = Math.floor(file.size / 2);
    parts.push(file.slice(0, SAMPLE_BYTES));
    parts.push(file.slice(mid, mid + SAMPLE_BYTES));
    parts.push(file.slice(file.size - SAMPLE_BYTES));
  }
  const buf = await new Blob(parts).arrayBuffer();
  const digest = hex(await crypto.subtle.digest('SHA-256', buf));
  return multi ? `v1:${digest}|g:${multi.group}:${multi.index}` : `v1:${digest}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new UploadError('Upload cancelled'));
      },
      { once: true }
    );
  });

/** Don't burn retries while the browser knows it is offline. */
const waitOnline = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (typeof navigator === 'undefined' || navigator.onLine) return resolve();
    const done = () => {
      window.removeEventListener('online', done);
      resolve();
    };
    window.addEventListener('online', done);
    signal?.addEventListener('abort', done, { once: true });
  });

async function apiJson<T>(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { ...init, signal });
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text || `HTTP ${res.status}` };
  }
  return { status: res.status, body: body as T };
}

async function openSession(
  file: File,
  fingerprint: string,
  params: ChunkedUploadParams,
  signal?: AbortSignal
): Promise<SessionReply> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await waitOnline(signal);
      const { status, body } = await apiJson<SessionReply & { error?: string }>(
        '/api/uploads',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fingerprint,
            size: file.size,
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            languageCode: params.languageCode || undefined,
            linkedEvent: params.linkedEvent ?? undefined,
            reportPref: params.reportPref ?? undefined,
            sourceId: params.sourceId ?? undefined,
            multi: params.multi ?? undefined,
            scratch: params.scratch ? true : undefined,
          }),
        },
        signal
      );
      if (status >= 200 && status < 300) return body;
      // 4xx other than 429: the request itself is wrong — don't retry.
      if (status >= 400 && status < 500 && status !== 429) {
        throw new UploadError(body?.error ?? `Upload failed (${status})`, status);
      }
      if (attempt >= 8) throw new UploadError(body?.error ?? `Upload failed (${status})`, status);
    } catch (err) {
      if (err instanceof UploadError) throw err;
      if (signal?.aborted) throw new UploadError('Upload cancelled');
      if (attempt >= 8) throw new UploadError('Upload failed: network error');
    }
    await sleep(Math.min(BACKOFF_CAP_MS, 1000 * 2 ** (attempt - 1)), signal);
  }
}

class SessionGone extends Error {}

/** PUT one chunk via XHR (gives in-flight progress). Resolves when the
 * server acknowledges it; rejects with SessionGone on 404/410. */
function putChunk(
  sessionId: string,
  idx: number,
  blob: Blob,
  sha256: string,
  onLoaded: (n: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${sessionId}/chunks/${idx}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-chunk-sha256', sha256);
    xhr.timeout = 180_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onLoaded(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      if (xhr.status === 404 || xhr.status === 410) return reject(new SessionGone(xhr.responseText));
      let detail = xhr.responseText || String(xhr.status);
      try {
        detail = (JSON.parse(xhr.responseText) as { error?: string }).error ?? detail;
      } catch {
        // raw text
      }
      reject(new UploadError(detail, xhr.status));
    };
    xhr.onerror = () => reject(new UploadError('network error'));
    xhr.ontimeout = () => reject(new UploadError('timeout'));
    xhr.onabort = () => reject(new UploadError('Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

async function sendMissingChunks(
  file: File,
  session: SessionReply,
  hooks: ChunkedUploadHooks
): Promise<void> {
  const { signal } = hooks;
  const have = new Set(session.received);
  const queue: number[] = [];
  for (let i = 0; i < session.chunkCount; i++) if (!have.has(i)) queue.push(i);

  let ackedBytes = 0;
  for (const i of session.received) ackedBytes += chunkByteRange(file.size, session.chunkSize, i).length;
  const inflight = new Map<number, number>();
  const report = () => {
    let loaded = ackedBytes;
    for (const n of inflight.values()) loaded += n;
    hooks.onProgress?.(Math.min(loaded, file.size), file.size);
  };
  report();

  let failure: unknown = null;
  const worker = async () => {
    while (queue.length > 0 && !failure) {
      const idx = queue.shift()!;
      const range = chunkByteRange(file.size, session.chunkSize, idx);
      const blob = file.slice(range.start, range.end);
      const sha256 = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          await waitOnline(signal);
          await putChunk(
            session.id,
            idx,
            blob,
            sha256,
            (n) => {
              inflight.set(idx, n);
              report();
            },
            signal
          );
          inflight.delete(idx);
          ackedBytes += range.length;
          report();
          break;
        } catch (err) {
          inflight.delete(idx);
          report();
          if (err instanceof SessionGone) throw err;
          if (signal?.aborted) throw new UploadError('Upload cancelled');
          const status = err instanceof UploadError ? err.status : undefined;
          // Auth problems and malformed requests won't fix themselves.
          if (status === 401 || status === 403 || status === 409 || status === 413) throw err;
          if (attempt >= MAX_CHUNK_ATTEMPTS) {
            throw new UploadError(
              `Upload failed: chunk ${idx + 1}/${session.chunkCount} did not go through after ${attempt} attempts (${err instanceof Error ? err.message : String(err)})`
            );
          }
          hooks.onNote?.(`Connection hiccup — retrying chunk ${idx + 1}/${session.chunkCount} (attempt ${attempt + 1})`);
          await sleep(Math.min(BACKOFF_CAP_MS, 500 * 2 ** Math.min(attempt, 6)), signal);
          hooks.onNote?.(null);
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(PARALLELISM, queue.length || 1) }, () =>
    worker().catch((err) => {
      failure = failure ?? err;
    })
  );
  await Promise.all(workers);
  if (failure) throw failure;
}

async function completeSession(
  session: SessionReply,
  hooks: ChunkedUploadHooks
): Promise<StoredTranscript> {
  const { signal } = hooks;
  hooks.onNote?.('Finalizing…');
  type Done = { transcript?: StoredTranscript; status?: string; transcriptId?: string | null; error?: string; missing?: number[] };
  let attempt = 0;
  for (;;) {
    attempt++;
    let lost = false;
    try {
      await waitOnline(signal);
      const { status, body } = await apiJson<Done>(
        `/api/uploads/${session.id}/complete`,
        { method: 'POST' },
        signal
      );
      if (status >= 200 && status < 300) {
        if (body.transcript) return body.transcript;
        if (body.transcriptId) return fetchTranscript(body.transcriptId, signal);
        throw new UploadError('Upload finished but the server returned no transcript');
      }
      if (status === 409 && body.status === 'completing') {
        lost = true; // someone (an earlier attempt of ours) is finalizing — poll
      } else if (status === 409 && body.missing) {
        throw new SessionGone(JSON.stringify(body)); // caller re-syncs chunks
      } else if (status === 404 || status === 410) {
        throw new SessionGone(body.error ?? 'session gone');
      } else if (status >= 400 && status < 500) {
        throw new UploadError(body.error ?? `Upload failed (${status})`, status);
      } else if (status >= 500) {
        // 502 = the ingest itself failed (AAI rejected, stitch failed) — the
        // server already tore the placeholder down. Not retryable.
        throw new UploadError(body.error ?? `Upload failed (${status})`, status);
      }
    } catch (err) {
      if (err instanceof UploadError || err instanceof SessionGone) throw err;
      if (signal?.aborted) throw new UploadError('Upload cancelled');
      lost = true; // network dropped while the server may still be finalizing
    }
    if (lost) {
      const outcome = await pollSession(session.id, signal);
      if (outcome.kind === 'done') return fetchTranscript(outcome.transcriptId, signal);
      if (outcome.kind === 'failed') throw new UploadError(outcome.error);
      // still 'open' (our complete never reached the server) → retry
    }
    if (attempt >= 20) throw new UploadError('Upload failed: could not finalize');
    await sleep(Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.min(attempt, 4)), signal);
  }
}

type SessionOutcome =
  | { kind: 'done'; transcriptId: string }
  | { kind: 'failed'; error: string }
  | { kind: 'open' };

async function pollSession(id: string, signal?: AbortSignal): Promise<SessionOutcome> {
  // Finalize can legitimately run for many minutes (AAI re-upload of a
  // multi-GB file) — poll patiently, bail only on a clear terminal state.
  for (let i = 0; i < 400; i++) {
    await sleep(3000, signal);
    try {
      await waitOnline(signal);
      const res = await fetch(`/api/uploads/${id}`, { signal });
      if (res.status === 404) return { kind: 'failed', error: 'Upload session vanished' };
      if (!res.ok) continue;
      const s = (await res.json()) as {
        status: string;
        error: string | null;
        transcriptId: string | null;
      };
      if (s.status === 'done' && s.transcriptId) return { kind: 'done', transcriptId: s.transcriptId };
      if (s.status === 'failed') return { kind: 'failed', error: s.error ?? 'Upload failed' };
      if (s.status === 'open') return { kind: 'open' };
    } catch {
      if (signal?.aborted) throw new UploadError('Upload cancelled');
    }
  }
  return { kind: 'failed', error: 'Upload failed: finalize did not finish' };
}

async function fetchTranscript(id: string, signal?: AbortSignal): Promise<StoredTranscript> {
  const res = await fetch(`/api/transcripts/${id}`, { signal });
  if (!res.ok) throw new UploadError(`Uploaded, but loading the transcript failed (${res.status})`);
  return ((await res.json()) as { transcript: StoredTranscript }).transcript;
}

/**
 * Upload one file. Resolves with the transcript row the server created
 * (the promoted placeholder, or the group row for non-final parts of a
 * multi-file group). Restarts the session once if the server says it is
 * gone (reaped while the tab sat idle for a day).
 */
export async function uploadFileChunked(
  file: File,
  params: ChunkedUploadParams,
  hooks: ChunkedUploadHooks = {}
): Promise<StoredTranscript> {
  const fingerprint = await fingerprintFile(file, params.multi);
  let restarts = 0;
  for (;;) {
    const session = await openSession(file, fingerprint, params, hooks.signal);
    if (session.resumed) {
      let bytes = 0;
      for (const i of session.received) bytes += chunkByteRange(file.size, session.chunkSize, i).length;
      hooks.onResumed?.(bytes, file.size);
    }
    try {
      // Re-sync + send until the server confirms it has everything; a
      // {missing} 409 from complete means an ack raced — loop once more.
      for (let sync = 0; sync < 3; sync++) {
        await sendMissingChunks(file, session, hooks);
        try {
          return await completeSession(session, hooks);
        } catch (err) {
          if (err instanceof SessionGone && err.message.startsWith('{') && sync < 2) {
            const fresh = await openSession(file, fingerprint, params, hooks.signal);
            session.received = fresh.received;
            continue;
          }
          throw err;
        }
      }
      throw new UploadError('Upload failed: chunks kept going missing');
    } catch (err) {
      if (err instanceof SessionGone && restarts < 1) {
        restarts++;
        hooks.onNote?.('Upload session expired — starting over');
        continue;
      }
      if (err instanceof SessionGone) throw new UploadError('Upload session expired — please try again');
      throw err;
    } finally {
      hooks.onNote?.(null);
    }
  }
}
