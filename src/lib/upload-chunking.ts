/**
 * Chunked-upload plan shared by the browser client and the /api/uploads
 * routes. Plain module — no server-only, no DOM.
 */

// Keep in sync with `proxyClientMaxBodySize` in next.config.ts and nginx
// `client_max_body_size`.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

/** Smaller chunks for small files (cheap retries, more parallelism on a
 * 30MB voice memo); 8MB for everything bigger. On a lossy mobile link a
 * lost chunk costs at most one chunk's worth of re-send. */
export function chunkPlanFor(size: number): { chunkSize: number; chunkCount: number } {
  const chunkSize = size <= 64 * 1024 * 1024 ? 4 * 1024 * 1024 : 8 * 1024 * 1024;
  return { chunkSize, chunkCount: Math.max(1, Math.ceil(size / chunkSize)) };
}

export function chunkByteRange(
  size: number,
  chunkSize: number,
  idx: number
): { start: number; end: number; length: number } {
  const start = idx * chunkSize;
  const end = Math.min(size, start + chunkSize);
  return { start, end, length: end - start };
}
