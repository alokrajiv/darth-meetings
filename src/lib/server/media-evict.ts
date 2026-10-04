import 'server-only';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { getStorageDir } from '@/lib/server/audio-storage';
import { getAudioOnlyPath } from '@/lib/server/audio-only';
import {
  archiveMedia,
  archiveShouldYield,
  archiveStore,
  canaryGate,
  fmtBytes,
  localMediaPath,
  sha256OfFile,
} from '@/lib/server/media-archive';
import { localMediaHeld } from '@/lib/server/media-local';
import { redactSasInText } from '@/lib/server/media-serve';
import { mediaStore, type MediaBlobLike } from '@/lib/server/media-store';
import {
  clearMediaVerification,
  listEvictableMedia,
  markLocalAlreadyGone,
  mediaEvictionColumnsExist,
  recordLocalEviction,
  type RecordingMediaRow,
} from '@/db-ops/recordings';

/**
 * Stage D of DEC-3 — the VM becomes a cache (docs/recordings-stage-d-spec.md).
 *
 * Removes the LOCAL copy of a media file under `storage/audio/` or
 * `storage/audio-only/` once its blob has been read back from Azure and
 * matched (`verifyArchivedBlob`, media-archive.ts) at least
 * `MW_MEDIA_EVICT_AFTER_DAYS` (default 0: as soon as it is verified) days ago. Shared by the sweeper's
 * pass (`evictionPass`, only with `MW_MEDIA_EVICT=1`) and the operator script
 * (`scripts/media-evict.ts`, dry-run unless `--apply`). Work that needs the
 * bytes afterwards gets them from the bounded cache (`ensureLocalMedia`).
 *
 * The per-row procedure is the spec's "Decisions", in order, and every step
 * is a reason NOT to delete:
 *   1. the row is still eligible as passed (archived, verified FOR ITS CURRENT
 *      HASH, not evicted, a kind whose file lives under storage/audio*), and
 *      the path is inside `getStorageDir()` — nothing outside it is touched;
 *   2. nobody is using the recording: no meeting on it uploading / queued /
 *      processing at AssemblyAI or with a notes / report / speaker-ID pass
 *      `running`, no re-transcription processing, no audio extract / media
 *      prep / clip cut in flight in this process, no `ensureLocalMedia`
 *      handle open on the file (`localMediaHeld`);
 *   3. the file was not touched in the last hour (`MEDIA_EVICT_MTIME_MIN_MS`);
 *   4. its size equals `bytes` and — hashed right now, streamed — its sha256
 *      equals `sha256`. A different file means it was rewritten after the
 *      read-back: the VERIFICATION is cleared (not the stamp; the archive's
 *      own "rewritten since the stamp" path re-archives) and nothing goes;
 *   5. the blob is still there with that size and stored hash (one HEAD);
 *   6. the ledger row and `local_evicted_at` are written in ONE transaction,
 *      guarded on the hash, BEFORE the unlink; then the unlink.
 * A verified row whose file is already missing is marked evicted with an
 * `'already gone'` ledger note so it stops being a candidate.
 *
 * Read-lazily throughout: no env at module scope (`bun run build` has none),
 * and with no media account or no migration 051 the pass makes no query.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const MEDIA_EVICT_FLAG_ENV = 'MW_MEDIA_EVICT';
export const MEDIA_EVICT_AFTER_DAYS_ENV = 'MW_MEDIA_EVICT_AFTER_DAYS';
export const EVICT_FILES_PER_TICK_ENV = 'MW_EVICT_FILES_PER_TICK';
/** A file modified more recently than this is being worked on — leave it. */
export const MEDIA_EVICT_MTIME_MIN_MS = 60 * 60 * 1000;

const DEFAULT_EVICT_AFTER_DAYS = 0;
const DEFAULT_EVICT_FILES_PER_TICK = 20;
/** The pass re-asks `archiveShouldYield` every this many files (spec "Code"). */
const EVICT_YIELD_CHECK_EVERY = 5;
/** The kinds whose bytes live under storage/audio* (spec `listEvictableMedia`). */
const EVICTABLE_KINDS = new Set(['canonical', 'audio_only', 'part']);

/** `MW_MEDIA_EVICT` is `1` / `true`: the sweeper's pass may delete. */
export function mediaEvictFlagOn(): boolean {
  const raw = (process.env[MEDIA_EVICT_FLAG_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Days between the read-back and the deletion. 0 by default (Alok, 2026-10-04:
 * "just delete already verified after adding to db") — the read-back + ledger
 * are the safety, not time; a rewrite after the stamp is caught by the
 * pre-delete re-hash and re-archived (`rewritten`). Set >0 for a cooling-off.
 */
export function evictAfterDays(): number {
  const raw = (process.env[MEDIA_EVICT_AFTER_DAYS_ENV] ?? '').trim();
  const n = Number.parseFloat(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_EVICT_AFTER_DAYS;
}

/** Files the sweeper's pass may evict per 5-minute tick. */
export function evictFilesPerTick(): number {
  const n = Number.parseInt(process.env[EVICT_FILES_PER_TICK_ENV] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EVICT_FILES_PER_TICK;
}

export type EvictOutcome =
  | { status: 'evicted'; mediaId: string; bytes: number; path: string }
  | { status: 'already-gone'; mediaId: string; path: string }
  | { status: 'rewritten'; mediaId: string; reason: string }
  | { status: 'skipped'; mediaId: string; reason: string }
  | { status: 'failed'; mediaId: string; error: string };

/** True when `abs` is strictly inside `root` (no `..`, not the root itself). */
function isInside(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface RecordingWork {
  /** `transcripts.assemblyai_id` of every live meeting on the recording. */
  meetings: string[];
  busy: string | null;
}

/**
 * The per-recording variant of `archiveShouldYield`'s DB half. The meetings of
 * a recording are the `transcripts` rows its `meeting_clips` point at (plus a
 * row naming the stored file directly, for a schema mid-backfill). Unlike the
 * pass-level check this is NOT time-bounded: a status stuck at `processing`
 * after a pm2 restart keeps that one recording's file on disk, which is the
 * safe direction — the cost is a file not freed, never a file a job needed.
 */
async function recordingWork(row: RecordingMediaRow): Promise<RecordingWork> {
  const rows = await sql<
    Array<{ meetings: string[] | null; transcribing: boolean | null; ai: boolean | null; retranscribing: boolean }>
  >`
    SELECT
      array_agg(DISTINCT t.assemblyai_id) FILTER (WHERE t.assemblyai_id IS NOT NULL) AS meetings,
      bool_or(t.status IN ('uploading', 'queued', 'processing')) AS transcribing,
      bool_or(
        t.auto_notes_status = 'running'
        OR t.auto_report_status = 'running'
        OR t.speaker_id_status = 'running'
      ) AS ai,
      EXISTS (
        SELECT 1 FROM ${sql(SCHEMA)}.recording_transcriptions rt
        WHERE rt.recording_id = ${row.recording_id}::uuid AND rt.status = 'processing'
      ) AS retranscribing
    FROM ${sql(SCHEMA)}.transcripts t
    WHERE t.deleted_at IS NULL
      AND (
        t.id IN (
          SELECT c.transcript_id FROM ${sql(SCHEMA)}.meeting_clips c
          WHERE c.recording_id = ${row.recording_id}::uuid
        )
        OR t.local_audio_path = ${row.filename}
      )
  `;
  const r = rows[0];
  const meetings = r?.meetings ?? [];
  let busy: string | null = null;
  if (r?.transcribing) busy = 'a meeting on this recording is uploading or transcribing';
  else if (r?.ai) busy = 'an AI run on this recording is in flight';
  else if (r?.retranscribing) busy = 'a re-transcription of this recording is processing';
  return { meetings, busy };
}

/**
 * This process's own in-flight work on the file — the maps the other modules
 * keep on globalThis precisely so other bundles can see them. Read, never
 * written.
 */
function inProcessHold(row: RecordingMediaRow, abs: string, meetings: string[]): string | null {
  if (localMediaHeld(abs)) return 'held';
  const gl = globalThis as unknown as {
    __mwAudioOnlyInflight?: Map<string, unknown>;
    __mwMediaPrepInflight?: Map<string, unknown>;
    __mwClipPrecut?: { queue: Map<string, string>; running: boolean };
    __mwClipCutInflight?: Map<string, unknown>;
  };
  // audio-only.ts keys its transcodes by the OUTPUT path: the extract being
  // written from this source, or this extract itself.
  let derivative: string | null = null;
  try {
    derivative = row.kind === 'audio_only' ? abs : getAudioOnlyPath(row.filename ?? '');
  } catch {
    derivative = null;
  }
  if (derivative && gl.__mwAudioOnlyInflight?.has(derivative)) return 'an audio extract of it is running';
  if (meetings.some((m) => gl.__mwMediaPrepInflight?.has(m))) return 'media prep is running on it';
  const precut = gl.__mwClipPrecut;
  // The pre-cut queue does not say which meeting it is cutting right now, so a
  // running drain holds every recording until it is idle (cuts take seconds).
  if (precut?.running) return 'a clip cut pass is running';
  if (meetings.some((m) => precut?.queue.has(m))) return 'a clip cut is queued for it';
  // clip-cut.ts keys a job `<storage>/clips/<meeting>/<variant>.<plan>.<md5(source)[0:8]>`.
  const cuts = gl.__mwClipCutInflight;
  if (cuts && cuts.size > 0) {
    const src = createHash('md5').update(row.filename ?? '').digest('hex').slice(0, 8);
    for (const key of cuts.keys()) {
      if (key.endsWith(`.${src}`)) return 'a clip cut of it is running';
      if (meetings.some((m) => key.includes(`${path.sep}clips${path.sep}${m}${path.sep}`))) {
        return 'a clip cut of its meeting is running';
      }
    }
  }
  return null;
}

/**
 * Remove ONE media row's local copy, or say why not. Never throws for a
 * per-row problem (the outcome carries it); a database outage does throw, and
 * the pass logs it.
 */
export async function evictLocalCopy(
  row: RecordingMediaRow,
  opts: { by: string; store?: MediaBlobLike | null }
): Promise<EvictOutcome> {
  const mediaId = row.id;
  const skip = (reason: string): EvictOutcome => ({ status: 'skipped', mediaId, reason });

  const store = opts.store === undefined ? mediaStore() : opts.store;
  if (!store) return skip('no media store on this host');
  if (!(await mediaEvictionColumnsExist().catch(() => false))) {
    return skip('migration 051 (media_local_eviction) is not applied');
  }

  // 1. Still eligible as passed in (the list may be minutes old).
  if (!EVICTABLE_KINDS.has(row.kind)) return skip(`kind ${row.kind} is never evicted`);
  if (!row.blob_name || !row.sha256 || row.bytes == null || !row.filename) {
    return skip('row is not archived');
  }
  if (!row.blob_verified_at || row.blob_verified_sha256 !== row.sha256) {
    return skip('blob not read-back-verified for the current hash');
  }
  if (row.local_evicted_at) return skip('already evicted');
  const abs = localMediaPath(row);
  if (!abs || !isInside(getStorageDir(), abs)) {
    return skip(`stored name ${row.filename} does not resolve inside the storage dir`);
  }

  // A canary that has vanished means a lifecycle rule is eating the container:
  // the blob is the only copy we would be left with, so nothing goes.
  try {
    const gate = await canaryGate(store);
    if (!gate.ok) return skip(gate.reason);
  } catch (err) {
    return skip(`canary check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Nobody is using it.
  const work = await recordingWork(row);
  if (work.busy) return skip(work.busy);
  const held = inProcessHold(row, abs, work.meetings);
  if (held) return skip(held);

  // 3. The file itself.
  const st = await fsp.lstat(abs).catch((err: NodeJS.ErrnoException) => err);
  if (st instanceof Error) {
    if (st.code !== 'ENOENT') return { status: 'failed', mediaId, error: `stat failed: ${st.message}` };
    const marked = await markLocalAlreadyGone(mediaId, 'already gone: no local file when the eviction came for it', {
      localPath: abs,
      by: opts.by,
    });
    return marked ? { status: 'already-gone', mediaId, path: abs } : skip('row changed under us');
  }
  if (!st.isFile()) return skip('not a regular file');
  if (Date.now() - st.mtimeMs < MEDIA_EVICT_MTIME_MIN_MS) return skip('modified within the last hour');

  // 4. The bytes on disk are the bytes that were verified.
  if (st.size !== row.bytes) {
    return rewritten(row, `local file is ${st.size} B, the verified blob is ${row.bytes} B — rewritten after the read-back`);
  }
  const localSha256 = await sha256OfFile(abs);
  if (localSha256 !== row.sha256) {
    return rewritten(row, `local sha256 ${localSha256} is not the verified ${row.sha256} — rewritten after the read-back`);
  }
  // Hashing a 3 GB file takes a while; a write during it shows up here.
  const again = await fsp.lstat(abs).catch(() => null);
  if (!again || again.size !== st.size || again.mtimeMs !== st.mtimeMs) {
    return skip('the file changed while it was being hashed');
  }

  // 5. The blob is still there, the same size, with the same stored hash.
  let props: Awaited<ReturnType<MediaBlobLike['properties']>>;
  try {
    props = await store.properties(row.blob_name);
  } catch (err) {
    return skip(`blob properties failed: ${redactSasInText(err instanceof Error ? err.message : String(err))}`);
  }
  if (!props || props.bytes !== row.bytes || props.metadata.sha256 !== row.sha256) {
    const seen = props ? `${props.bytes} B / ${props.metadata.sha256 ?? 'no hash'}` : 'missing';
    const error = `blob ${row.blob_name} disagrees with its verified row (${seen}, expected ${row.bytes} B / ${row.sha256})`;
    await clearMediaVerification(mediaId);
    console.error(`[media-evict] ${error} — verification cleared, the local file is KEPT`);
    return { status: 'failed', mediaId, error };
  }

  // Last look at this process's own work before committing to the delete.
  const heldNow = inProcessHold(row, abs, work.meetings);
  if (heldNow) return skip(heldNow);

  // 6. Ledger first, unlink second.
  const recorded = await recordLocalEviction({
    mediaId,
    recordingId: row.recording_id,
    kind: row.kind,
    filename: row.filename,
    localPath: abs,
    bytes: st.size,
    localSha256,
    blobName: row.blob_name,
    blobSha256: row.sha256,
    blobVerifiedAt: row.blob_verified_at,
    evictedBy: opts.by,
  });
  if (!recorded) return skip('row changed under us (re-archived or already evicted)');
  try {
    await fsp.unlink(abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      // The ledger says gone and the file is still there: harmless, listed by
      // `scripts/media-evict.ts --orphans`.
      return { status: 'failed', mediaId, error: `ledger written but unlink failed: ${e.message}` };
    }
  }
  return { status: 'evicted', mediaId, bytes: st.size, path: abs };
}

export interface EvictionPassSummary {
  evicted: number;
  bytes: number;
  alreadyGone: number;
  rewritten: number;
  skipped: number;
  failed: number;
  /** Why the pass did not run (or stopped early), if it did not / did. */
  stopped: string | null;
}

/**
 * The sweeper's eviction pass (only with `MW_MEDIA_EVICT=1`): the oldest
 * evictable rows, at most `files` deletions per tick, yielding to an ingest or
 * an AI run like the archive backfill — at the start and every 5 files. One
 * log line per tick, and only when something happened. Inert — not one query
 * — without an archive store; inert after one probe without migration 051.
 */
/**
 * The file on disk is not the file that was read back: something rewrote it in
 * place AFTER the stamp (the faststart remux, the 2026-09-25 track-disposition
 * fix run with `--skip-archive`, …). The local file is the newer truth, so the
 * blob is brought up to date from it — `archiveMedia` with `rehash` overwrites
 * the blob under the same name and re-stamps the row (sha256, bytes, Stage D
 * columns reset). The verify pass then reads it back, and the eviction after
 * that deletes the local copy — without this the row would bounce between
 * "verified" and "rewritten" every tick, forever. Nothing is deleted here.
 */
async function rewritten(row: RecordingMediaRow, reason: string): Promise<EvictOutcome> {
  await clearMediaVerification(row.id);
  let tail: string;
  try {
    const re = await archiveMedia(row, { rehash: true });
    tail =
      re.status === 'archived' || re.status === 'adopted'
        ? `; re-archived from the local file (${fmtBytes(re.bytes)}, ${re.sha256.slice(0, 12)}…)`
        : re.status === 'skipped'
          ? `; re-archive skipped (${re.reason})`
          : re.status === 'failed'
            ? `; re-archive failed (${redactSasInText(re.error)})`
            : '; re-archive off';
  } catch (err) {
    tail = `; re-archive failed (${redactSasInText(err instanceof Error ? err.message : String(err))})`;
  }
  console.warn(`[media-evict] ${row.kind} ${row.filename}: ${reason}; verification cleared, nothing deleted${tail}`);
  return { status: 'rewritten', mediaId: row.id, reason: reason + tail };
}

export async function evictionPass(opts: { files: number; by: string }): Promise<EvictionPassSummary> {
  const summary: EvictionPassSummary = {
    evicted: 0,
    bytes: 0,
    alreadyGone: 0,
    rewritten: 0,
    skipped: 0,
    failed: 0,
    stopped: null,
  };
  const store = archiveStore();
  if (!store) return { ...summary, stopped: 'no archive store' };
  if (!(await mediaEvictionColumnsExist().catch(() => false))) {
    return { ...summary, stopped: 'migration 051 not applied' };
  }
  const yieldTo = await archiveShouldYield();
  if (yieldTo) {
    console.log(`[media-evict] pass skipped — ${yieldTo}`);
    return { ...summary, stopped: yieldTo };
  }

  const candidates = await listEvictableMedia({
    minAgeDays: evictAfterDays(),
    limit: opts.files + 25,
  });
  const reasons = new Map<string, number>();
  let worked = 0;
  for (const row of candidates) {
    if (worked >= opts.files) break;
    if (worked > 0 && worked % EVICT_YIELD_CHECK_EVERY === 0) {
      const now = await archiveShouldYield();
      if (now) {
        summary.stopped = `paused — ${now}`;
        break;
      }
    }
    let out: EvictOutcome;
    try {
      out = await evictLocalCopy(row, { by: opts.by, store });
    } catch (err) {
      out = { status: 'failed', mediaId: row.id, error: err instanceof Error ? err.message : String(err) };
    }
    switch (out.status) {
      case 'evicted':
        summary.evicted += 1;
        summary.bytes += out.bytes;
        worked += 1;
        break;
      case 'already-gone':
        summary.alreadyGone += 1;
        break;
      case 'rewritten':
        summary.rewritten += 1;
        worked += 1;
        break;
      case 'failed':
        summary.failed += 1;
        worked += 1;
        console.warn(`[media-evict] ${row.kind} ${row.filename}: ${redactSasInText(out.error)}`);
        break;
      case 'skipped':
        summary.skipped += 1;
        reasons.set(out.reason, (reasons.get(out.reason) ?? 0) + 1);
        // A vanished canary stops everything, not just this row.
        if (out.reason.startsWith('CANARY GONE')) summary.stopped = out.reason;
        break;
    }
    if (summary.stopped?.startsWith('CANARY GONE')) break;
  }

  const anything =
    summary.evicted + summary.alreadyGone + summary.rewritten + summary.failed + summary.skipped > 0 ||
    summary.stopped;
  if (anything) {
    const skipped = [...reasons.entries()].map(([r, n]) => `${n}× ${r}`).join('; ');
    console.log(
      `[media-evict] tick: ${summary.evicted} file(s) evicted, ${fmtBytes(summary.bytes)} freed` +
        (summary.alreadyGone > 0 ? `, ${summary.alreadyGone} already gone` : '') +
        (summary.rewritten > 0 ? `, ${summary.rewritten} rewritten since the read-back (kept)` : '') +
        (summary.failed > 0 ? `, ${summary.failed} failed` : '') +
        (summary.skipped > 0 ? ` | skipped: ${skipped}` : '') +
        (summary.stopped ? ` | ${summary.stopped}` : '')
    );
  }
  return summary;
}
