/**
 * Reading a failure that came out of the AssemblyAI SDK.
 *
 * assemblyai@4 has no error class of its own. `BaseService.fetch`
 * (node_modules/assemblyai/dist/index.mjs:128-142) turns any response with
 * status >= 400 into a plain `Error` whose message is, in order:
 *   1. `json.error` from the response body (`"Transcript not found"`),
 *   2. the raw body text when it isn't JSON,
 *   3. `HTTP Error: <status> <statusText>` when the body is empty.
 * Nothing carries the status code as a property, so "was that a 404?" has to
 * be read back off the message — with the object inspected first in case a
 * future SDK (or a wrapper) does attach one.
 *
 * Why it matters: under DEC-4 (docs/recordings-first-class-design.md §7) a
 * 404 from AssemblyAI is the NORMAL end state of a job — we delete jobs
 * ourselves once the payload is stored, and AAI retention drops to 24 h.
 * A poller that treats it as a transient error retries it forever.
 *
 * Pure on purpose: no `server-only`, no SDK import, so it is unit-testable.
 * `@/lib/server/assemblyai` re-exports these as the typed helper callers use.
 */

export interface AaiErrorInfo {
  /** HTTP status when one could be recovered, else null. */
  status: number | null;
  /** The SDK message, whitespace-collapsed and capped (same shape as ingest.ts). */
  message: string;
  /** AssemblyAI does not have this job any more — a terminal answer. */
  notFound: boolean;
}

/** The empty-body branch of the SDK's error construction. */
const HTTP_ERROR_RE = /\bHTTP Error:\s*(\d{3})\b/i;

/**
 * Body-text shapes that mean "gone". `\b404\b` is kept (it is what
 * `deleteTranscript` matched on before this helper existed) and is safe
 * against ids: an AAI job id is a UUID, whose hex groups are 8/4/4/4/12
 * characters, so a bare `404` between word boundaries cannot come out of one.
 */
const NOT_FOUND_RE =
  /\b404\b|\bnot found\b|\bdoes ?n[o']?t exist\b|\bno such transcript\b|\bunknown transcript\b/i;

function httpStatusValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
    return value;
  }
  if (typeof value === 'string' && /^[1-5]\d{2}$/.test(value)) return Number(value);
  return null;
}

function messageOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
  return (raw || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function statusOf(error: unknown, message: string): number | null {
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    // `code` is deliberately NOT consulted: Node network errors put strings
    // like 'ECONNRESET' there and a libc errno would read as a bogus status.
    const direct = httpStatusValue(e.status) ?? httpStatusValue(e.statusCode);
    if (direct !== null) return direct;
    const resp = e.response;
    if (typeof resp === 'object' && resp !== null) {
      const r = resp as Record<string, unknown>;
      const nested = httpStatusValue(r.status) ?? httpStatusValue(r.statusCode);
      if (nested !== null) return nested;
    }
  }
  const m = HTTP_ERROR_RE.exec(message);
  return m ? Number(m[1]) : null;
}

export function describeAaiError(error: unknown): AaiErrorInfo {
  const message = messageOf(error);
  const status = statusOf(error, message);
  // A known 5xx is never read as "gone" even if its body mentions one —
  // AAI being broken is exactly the case we still want to retry.
  const notFound =
    status === 404 || ((status === null || status < 500) && NOT_FOUND_RE.test(message));
  return { status, message, notFound };
}

/** `true` when AssemblyAI answered "I don't have that job" — terminal. */
export function isAaiNotFound(error: unknown): boolean {
  return describeAaiError(error).notFound;
}
