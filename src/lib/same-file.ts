import { sha256Hex } from '@/lib/sha256';

/**
 * "The same file is never transcribed twice by accident" — the pure half
 * (docs/recordings-same-file-spec.md, Phase 2c).
 *
 * The rule: at upload time, if the SAME OWNER already has a live recording
 * with the same bytes, say so before spending anything and let them decide.
 * Never automatic refusal, never silent.
 *
 * PRIVACY (absolute, and the reason half this module exists): the lookup is
 * owner-scoped, and a match against ANOTHER user's recording must be
 * indistinguishable from "no match". The hash of a file is a fingerprint of
 * its content — "somebody else already uploaded this" is a leak, and shared
 * meetings do not widen it. Nothing here takes an owner id, so nothing here
 * can widen it either; the scoping lives in the ONE db-op
 * (`src/db-ops/same-file.ts`) and is there by construction.
 *
 * Pure on purpose — no `server-only`, no db, no fs, no `node:` import — so the
 * browser upload client, the API routes, the tray's contract and the unit
 * tests all share ONE definition of the wire and of the group hash.
 */

/** 64 lowercase hex characters. The one shape a whole-file hash may take. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A group's identity is `sha256(part hashes joined by this, in part order)`.
 * A newline, so the joined value cannot be confused with a plain
 * concatenation of the hashes and stays greppable in a log.
 */
export const GROUP_HASH_SEPARATOR = '\n';

/**
 * Above this the browser does not hash a file just for the duplicate check.
 * Bigger files either take the blob path — which hashes in a Web Worker
 * anyway and therefore gets the check at open for free — or are checked at
 * complete, on the VM, straight off the temp file (~1 s/GB).
 */
export const BROWSER_HASH_MAX_BYTES = 200 * 1024 * 1024;

/** The one server flag. Read lazily, never at module scope. */
export const SAME_FILE_FLAG_ENV = 'MW_SAME_FILE_CHECK';

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * What the server says instead of opening a session / finalizing one: HTTP
 * **200** with nothing created (open), or the session left OPEN and nothing
 * submitted to AssemblyAI (complete).
 */
export interface DuplicateMatch {
  /** `transcripts.assemblyai_id` — what /m/… and /transcript/<id> take. */
  meetingId: string;
  title: string | null;
  /** When the meeting happened (recorded_at, else created_at), ISO. */
  when: string | null;
  /** The meeting's own status: 'completed' | 'processing' | 'queued' | … */
  status: string;
  durationSec: number | null;
  /**
   * Every meeting on the matching recording is in the trash. Still reported —
   * restoring one is cheaper than re-transcribing — and the client offers
   * "Restore it" instead of "Open it".
   */
  trashed: boolean;
}

export interface DuplicateAnswer {
  duplicate: DuplicateMatch;
}

/**
 * The two fields a client adds to `POST /api/uploads` and
 * `POST /api/uploads/:id/complete`.
 *
 * `dupAware` is the whole backwards-compatibility story: the server answers
 * `duplicate` ONLY to a request that says it understands the answer. An older
 * tray, an older darth-cli and an older tab keep today's behaviour exactly,
 * byte for byte.
 */
export interface DupAwareRequest {
  /** "I understand a `{duplicate}` answer." */
  dupAware?: boolean;
  /** "I have seen the match — upload anyway." */
  force?: boolean;
}

/**
 * The part hashes a multi-part group declares at OPEN of part 1 (`multi`).
 * The tray — and any client holding every segment before it starts — knows
 * them all up front, so the whole group is checked before a byte moves.
 * Without it the group is checked at the LAST part's complete instead.
 */
export interface MultiPartHashes {
  /** One 64-hex sha256 per part, in part order (index 1..total). */
  partSha256?: string[];
}

export function wantsDuplicateAnswer(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as DupAwareRequest).dupAware === true;
}

export function wantsForce(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as DupAwareRequest).force === true;
}

/** Narrow a parsed response body — the web client and the tests use this. */
export function isDuplicateAnswer(body: unknown): body is DuplicateAnswer {
  if (!body || typeof body !== 'object') return false;
  const dup = (body as DuplicateAnswer).duplicate;
  return !!dup && typeof dup === 'object' && typeof dup.meetingId === 'string';
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** `null` = not a usable sha256. Upper case is accepted and folded down. */
export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return SHA256_HEX_RE.test(v) ? v : null;
}

/** A group may hold at most this many parts (`parseMultiParams`' own cap). */
export const MAX_GROUP_PARTS = 12;

/**
 * `undefined` = absent (fine, the check moves to the last complete), `null` =
 * present but not a list of hashes (a 400 — a wrong identity is worse than
 * none), otherwise the normalized list. `expect` is the declared part count
 * when the caller knows it.
 */
export function normalizePartSha256(
  value: unknown,
  expect?: number
): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_GROUP_PARTS) return null;
  const out: string[] = [];
  for (const raw of value) {
    const one = normalizeSha256(raw);
    if (!one) return null;
    out.push(one);
  }
  if (expect !== undefined && out.length !== expect) return null;
  return out;
}

/**
 * The exact bytes a group's identity hashes. Separate from `combinedGroupHash`
 * so the rule can be asserted without hashing, and so a log line can show what
 * went in.
 */
export function groupHashInput(partSha256: string[]): string {
  return partSha256.join(GROUP_HASH_SEPARATOR);
}

/**
 * A multi-part recording's identity: `sha256(part hashes joined by '\n', in
 * order)`. Deliberately NOT the hash of the stitched bytes — the stitch is an
 * ffmpeg output whose bytes depend on which codec path was taken (stream-copy
 * vs re-encode), while the parts are exactly what the user handed us.
 *
 * Synchronous: the input is at most 12 × 65 bytes, and `lib/sha256`'s
 * vendored implementation is the same one the upload worker uses.
 *
 * A one-element group hashes to `sha256("<h>")`, NOT to `h`: a group of one
 * does not exist (`multi.total >= 2`), and a uniform formula is one a caller
 * cannot half-apply.
 */
export function combinedGroupHash(partSha256: string[]): string {
  const parts = partSha256.map((p) => {
    const one = normalizeSha256(p);
    if (!one) throw new TypeError(`combinedGroupHash: ${String(p)} is not a sha256`);
    return one;
  });
  if (parts.length === 0) throw new TypeError('combinedGroupHash: no part hashes');
  return sha256Hex(new TextEncoder().encode(groupHashInput(parts)));
}

/**
 * The identity of ONE upload: the file's own hash for a single file, the
 * combined hash for a group that has declared every part. `null` = not
 * knowable yet (a group whose parts are not all hashed), which is not an
 * error — the check simply moves to the last part's complete.
 */
export function uploadIdentityHash(input: {
  sha256?: string | null;
  partSha256?: string[] | null;
}): string | null {
  if (input.partSha256 && input.partSha256.length > 0) return combinedGroupHash(input.partSha256);
  return normalizeSha256(input.sha256);
}

/**
 * Every part hash of a group, in index order, or `null` when one is still
 * missing. Fed from the group row's `uploadGroup.parts` as they land.
 */
export function partHashesInOrder(
  parts: Array<{ index: number; sha256?: string | null }>,
  total: number
): string[] | null {
  const byIndex = new Map<number, string>();
  for (const p of parts) {
    const one = normalizeSha256(p.sha256);
    if (one) byIndex.set(p.index, one);
  }
  const out: string[] = [];
  for (let i = 1; i <= total; i += 1) {
    const one = byIndex.get(i);
    if (!one) return null;
    out.push(one);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The browser's small-file fast path
// ---------------------------------------------------------------------------

/**
 * Should the web client hash this file itself so the check runs at OPEN?
 * Only for files it can read without stalling the tab, and only where
 * `Blob.arrayBuffer` exists at all (the chunked read the caller does).
 */
export function shouldHashInBrowser(sizeBytes: number): boolean {
  if (!(sizeBytes > 0) || sizeBytes > BROWSER_HASH_MAX_BYTES) return false;
  try {
    return typeof Blob === 'function' && typeof Blob.prototype.arrayBuffer === 'function';
  } catch {
    return false;
  }
}
