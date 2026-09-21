import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { getForUser, mergeGmeetContextForUser } from '@/db-ops/transcripts';
import { audioFileExists, getAudioDir } from '@/lib/server/audio-storage';
import { buildAudioOnly, getAudioOnlyDir } from '@/lib/server/audio-only';
import { ensureFaststart } from '@/lib/server/media-faststart';
import { queueDerivativeMediaDrop, queueRecordingGraphSync } from '@/lib/server/recording-sync';
import {
  archiveBudgetVerdict,
  archiveMedia,
  archiveShouldYield,
  archiveStore,
  drainPendingBlobDeletes,
  fmtBytes,
  localMediaPath,
} from '@/lib/server/media-archive';
import { listMediaToArchive } from '@/db-ops/recordings';
import type { GmeetContext } from '@/lib/format';

/**
 * Playback-media preparation (tech-debt A1 + A5).
 *
 * Every stored recording should be (1) progressive — mp4 index up front, so
 * a phone gets the first frame from one request and seeks without a
 * round trip (media-faststart.ts) — and (2) accompanied by its 64 kbps
 * mono audio-only extract, which the player streams whenever the video
 * toggle is off (audio-only.ts). Two entry points share one worker:
 *
 *   - `prepareMediaForPlayback(userId, id)` — fire-and-forget hook every
 *     import path calls the moment bytes land under their final name
 *     (ingest.ts for uploads / Meet & Teams video imports / Recorder /
 *     stitched uploads / ingest retries; recording-fetch.ts for the Drive
 *     primary, Teams recording and videoParts pulls). Never on the
 *     transcription path: AssemblyAI already has the bytes.
 *   - the 5-minute sweeper — backfills rows that predate this (or whose
 *     hook died with the process): up to MAX_PER_TICK rows per tick, ffmpeg
 *     under `nice -n 15`, one log line per row. Also the A5 lifecycle pass:
 *     `.m4a` derivatives whose source file is gone (permanent delete, a
 *     re-transcribe that renamed the source) are removed, one line each.
 *
 * The same tick also runs the MEDIA ARCHIVE backfill (DEC-3 Stage A.3,
 * `media-archive.ts`): local files with no blob yet are copied to the
 * permanent media container, oldest first, at most 2 GB / 5 files per tick and
 * never while an ingest or an AI run is in flight. It is last in the tick and
 * inert unless DARTH_MEDIA_ACCOUNT and MW_MEDIA_ARCHIVE are both set.
 *
 * State lives in `gmeet_context.media` (see GmeetContext): a row qualifies
 * while `faststart`/`audioOnly` are not both true or `parts` is below the
 * number of stored videoParts (a part fetched later re-qualifies the row).
 * A failing row is retried at most MAX_ATTEMPTS times, RETRY_AFTER apart.
 * Trashed rows, placeholders and non-completed rows are never touched.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const TICK_MS = 5 * 60 * 1000;
const MAX_PER_TICK = 3;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER = '6 hours';
/** A `.tmp` in the derivative dir older than this is a crashed transcode. */
const STALE_TMP_MS = 2 * 60 * 60 * 1000;
/**
 * The media-archive backfill's budget per tick (DEC-3 Stage A.3): 80 GB of
 * existing media at 2 GB per 5-minute tick is roughly 3–4 h of ticks, and the
 * file cap keeps a tick short when the files are small. A single file larger
 * than the byte budget is still archived — as the first file of a tick, alone.
 */
const ARCHIVE_MAX_BYTES_PER_TICK = 2 * 1024 * 1024 * 1024;
const ARCHIVE_MAX_FILES_PER_TICK = 5;
/** Candidates read per tick; the extra ones absorb rows whose file is gone. */
const ARCHIVE_SCAN_PER_TICK = 50;
/** Blobs whose rows are already gone, retried per tick. */
const ARCHIVE_DELETE_PER_TICK = 25;

interface MediaRow {
  user_id: string;
  assemblyai_id: string;
  local_audio_path: string | null;
  gmeet_context: GmeetContext | null;
}

// globalThis: this module is imported from route graphs (ingest.ts) AND the
// instrumentation graph; Next bundles it once per graph, so module-scope
// state would not dedupe work across them.
const g = globalThis as unknown as {
  __mwMediaPrepInflight?: Map<string, Promise<void>>;
  __mwMediaSweeperStarted?: boolean;
  __mwMediaSweeperTicking?: boolean;
};
const inflight = (g.__mwMediaPrepInflight ??= new Map<string, Promise<void>>());

/** Stored filenames a row plays: the primary plus every fetched part. */
function storedFiles(row: MediaRow): { primary: string | null; parts: string[] } {
  const parts = (row.gmeet_context?.videoParts ?? [])
    .map((p) => p.filename)
    .filter((f): f is string => !!f);
  return { primary: row.local_audio_path, parts };
}

function short(e: string): string {
  return e.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Faststart + audio extract for every file of one row, then stamp the
 * marker. Serial per row; rows are deduped on assemblyai_id so the import
 * hook and the sweeper never run ffmpeg twice on one file.
 */
async function prepareRow(row: MediaRow, opts: { nice: boolean; tag: string }): Promise<void> {
  const { primary, parts } = storedFiles(row);
  if (!primary) return;
  const files = [primary, ...parts];
  const started = Date.now();
  let faststartOk = true;
  let audioOk = true;
  const errors: string[] = [];
  const report: string[] = [];

  for (const [i, f] of files.entries()) {
    const label = i === 0 ? 'primary' : `part${i + 1}`;
    if (!(await audioFileExists(f))) {
      faststartOk = false;
      audioOk = false;
      errors.push(`${label}: file missing (${f})`);
      report.push(`${label} MISSING`);
      continue;
    }
    // Faststart FIRST: the extract is mtime-compared with its source, and
    // ensureFaststart touches an existing extract after the remux.
    const fs = await ensureFaststart(f, { nice: opts.nice });
    if (fs.status === 'error') {
      faststartOk = false;
      errors.push(`${label} faststart: ${fs.error}`);
    }
    const fsText =
      fs.status === 'remuxed'
        ? `remuxed ${(fs.ms / 1000).toFixed(1)}s`
        : fs.status === 'error'
          ? `ERROR ${short(fs.error)}`
          : fs.status;
    let aoText: string;
    try {
      const ao = await buildAudioOnly(f, { nice: opts.nice });
      if (ao.status === 'error') {
        audioOk = false;
        errors.push(`${label} audio-only: ${ao.error}`);
        aoText = `ERROR ${short(ao.error)}`;
      } else {
        aoText = !ao.derived
          ? 'not-needed'
          : ao.built
            ? `built ${((ao.ms ?? 0) / 1000).toFixed(1)}s`
            : 'exists';
      }
    } catch (e) {
      audioOk = false;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${label} audio-only: ${msg}`);
      aoText = `ERROR ${short(msg)}`;
    }
    report.push(`${label} faststart=${fsText} audio=${aoText}`);
  }

  const prevAttempts = row.gmeet_context?.media?.attempts ?? 0;
  const ok = faststartOk && audioOk;
  const media: NonNullable<GmeetContext['media']> = {
    faststart: faststartOk,
    audioOnly: audioOk,
    parts: parts.length,
    at: new Date().toISOString(),
    ...(ok ? {} : { attempts: prevAttempts + 1, error: errors.join('; ').slice(0, 300) }),
  };
  await mergeGmeetContextForUser(row.user_id, row.assemblyai_id, { media }, { quiet: true });
  // The extracts that exist now become `audio_only` media rows (the sync
  // stats the disk). The faststart remux gets NO row on purpose: it rewrites
  // the source file in place, so there is no second file to point at — the
  // canonical row already describes those bytes.
  queueRecordingGraphSync(row.user_id, row.assemblyai_id, 'media-prep');
  console.log(
    `${opts.tag} ${row.assemblyai_id}: ${report.join(' | ')} (${((Date.now() - started) / 1000).toFixed(1)}s` +
      (ok ? ')' : `, attempt ${media.attempts}/${MAX_ATTEMPTS})`)
  );
}

function runDeduped(id: string, job: () => Promise<void>): Promise<void> {
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = job().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/**
 * Import-time hook: prepare a row's media in the background and stamp the
 * marker. Re-reads the row so a videoParts stamp that just landed is
 * included. Never throws, never awaited by callers.
 */
export function prepareMediaForPlayback(userId: string, assemblyaiId: string): void {
  void runDeduped(assemblyaiId, async () => {
    const row = await getForUser(userId, assemblyaiId);
    if (!row || !row.local_audio_path || row.deleted_at) return;
    await prepareRow(row, { nice: false, tag: '[media-prep]' });
  }).catch((err) => {
    console.warn(`[media-prep] ${assemblyaiId} failed:`, err);
  });
}

/**
 * Backfill candidates. Kept here rather than in db-ops/transcripts.ts:
 * this is the only reader of the marker. Recent rows first — that is
 * where people press play.
 */
async function listMediaPrepCandidates(limit: number): Promise<MediaRow[]> {
  return sql<MediaRow[]>`
    SELECT user_id, assemblyai_id, local_audio_path, gmeet_context
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'completed'
      AND deleted_at IS NULL
      AND local_audio_path IS NOT NULL
      AND assemblyai_id NOT LIKE 'up-%'
      AND assemblyai_id NOT LIKE 'defer-%'
      AND (
        (gmeet_context->'media'->>'faststart') IS DISTINCT FROM 'true'
        OR (gmeet_context->'media'->>'audioOnly') IS DISTINCT FROM 'true'
        OR COALESCE((gmeet_context->'media'->>'parts')::int, 0) < (
          SELECT count(*)
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(gmeet_context->'videoParts') = 'array'
              THEN gmeet_context->'videoParts' ELSE '[]'::jsonb END
          ) p
          WHERE p->>'filename' IS NOT NULL
        )
      )
      AND COALESCE((gmeet_context->'media'->>'attempts')::int, 0) < ${MAX_ATTEMPTS}
      AND (
        gmeet_context->'media'->>'error' IS NULL
        OR (gmeet_context->'media'->>'at')::timestamptz < now() - ${RETRY_AFTER}::interval
      )
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/**
 * A5: derivatives with no live source. The audio dir is read once and every
 * `audio-only/<stem>.m4a` whose `<stem>.<anything>` is absent from it goes
 * (permanent delete already drops the derivative; this catches renames —
 * ingest-retry promotions, re-transcribes — and anything that slipped).
 * Crashed transcodes leave `<stem>.m4a.tmp`; those are removed once stale.
 */
async function sweepOrphanDerivatives(): Promise<void> {
  const dir = getAudioOnlyDir();
  const entries = await fsp.readdir(dir).catch(() => null);
  if (!entries || entries.length === 0) return;
  const sources = await fsp.readdir(getAudioDir()).catch(() => null);
  if (!sources) return; // can't tell what is live — do nothing
  const liveStems = new Set(sources.map((f) => path.parse(f).name));
  const now = Date.now();
  /** Files removed below, so their `recording_media` rows can go too. */
  const dropped: string[] = [];
  for (const f of entries) {
    const abs = path.join(dir, f);
    if (f.endsWith('.tmp')) {
      const st = await fsp.stat(abs).catch(() => null);
      if (st && now - st.mtimeMs > STALE_TMP_MS) {
        await fsp.unlink(abs).catch(() => {});
        console.log(`[media-sweeper] removed stale transcode temp ${f}`);
      }
      continue;
    }
    if (!f.endsWith('.m4a')) continue;
    const stem = path.parse(f).name;
    if (liveStems.has(stem)) continue;
    await fsp.unlink(abs).catch(() => {});
    dropped.push(f);
    console.log(`[media-sweeper] removed orphan derivative ${f} (no source ${stem}.* in the audio dir)`);
  }
  queueDerivativeMediaDrop(dropped, '[media-sweeper]');
}

/**
 * DEC-3 Stage A.3 — the archive backfill. Media rows we hold locally and have
 * no blob for, oldest capture first, paced so the copy never competes with
 * something a person is waiting for: the whole pass is skipped while an ingest
 * or an AI run is in flight, and it stops at ARCHIVE_MAX_BYTES_PER_TICK /
 * ARCHIVE_MAX_FILES_PER_TICK.
 *
 * One line per tick in the pm2 log; `scripts/media-archive-status.ts` has the
 * totals. Inert (not one query) unless DARTH_MEDIA_ACCOUNT and
 * MW_MEDIA_ARCHIVE are both set.
 */
async function archiveBackfillPass(): Promise<void> {
  if (!archiveStore()) return;
  const yieldTo = await archiveShouldYield();
  if (yieldTo) {
    console.log(`[media-archive] backfill skipped — ${yieldTo}`);
    return;
  }

  const candidates = await listMediaToArchive(ARCHIVE_SCAN_PER_TICK);
  if (candidates.length === 0) {
    await drainPendingBlobDeletes(ARCHIVE_DELETE_PER_TICK);
    return;
  }

  let files = 0;
  let bytes = 0;
  let noFile = 0;
  let failed = 0;
  const report: string[] = [];
  const caps = { maxFiles: ARCHIVE_MAX_FILES_PER_TICK, maxBytes: ARCHIVE_MAX_BYTES_PER_TICK };
  for (const row of candidates) {
    if (archiveBudgetVerdict({ files, bytes }, 0, caps) === 'stop') break;
    const abs = localMediaPath(row);
    const st = abs ? await fsp.stat(abs).catch(() => null) : null;
    if (!st?.isFile() || st.size === 0) {
      // Nothing to copy. The row keeps its NULL blob_name and shows up in the
      // verifier's INFO section; this pass simply steps over it.
      noFile += 1;
      continue;
    }
    if (archiveBudgetVerdict({ files, bytes }, st.size, caps) === 'stop') break;

    const outcome = await archiveMedia(row);
    if (outcome.status === 'archived') {
      files += 1;
      bytes += outcome.bytes;
      report.push(`${row.kind} ${fmtBytes(outcome.bytes)} ${(outcome.ms / 1000).toFixed(1)}s`);
    } else if (outcome.status === 'adopted') {
      files += 1;
      bytes += outcome.bytes;
      report.push(`${row.kind} ${fmtBytes(outcome.bytes)} adopted`);
    } else if (outcome.status === 'failed') {
      failed += 1;
      console.warn(`[media-archive] ${outcome.blobName}: ${outcome.error}`);
    } else if (outcome.status === 'skipped') {
      report.push(`skipped (${outcome.reason})`);
      // A canary failure stops the whole pass, not just this file.
      if (outcome.reason.startsWith('CANARY GONE')) break;
    }
  }

  if (files > 0 || failed > 0 || report.length > 0) {
    console.log(
      `[media-archive] tick: ${files} file(s), ${fmtBytes(bytes)}` +
        (noFile > 0 ? `, ${noFile} row(s) with no local file` : '') +
        (failed > 0 ? `, ${failed} failed` : '') +
        (report.length > 0 ? ` | ${report.join(' | ')}` : '')
    );
  }
  await drainPendingBlobDeletes(ARCHIVE_DELETE_PER_TICK);
}

async function tick(): Promise<void> {
  if (g.__mwMediaSweeperTicking) return; // a long extract can outlive the interval
  g.__mwMediaSweeperTicking = true;
  try {
    const rows = await listMediaPrepCandidates(MAX_PER_TICK);
    for (const row of rows) {
      await runDeduped(row.assemblyai_id, () =>
        prepareRow(row, { nice: true, tag: '[media-sweeper]' })
      ).catch((err) => console.warn(`[media-sweeper] ${row.assemblyai_id} failed:`, err));
    }
  } catch (err) {
    console.warn('[media-sweeper] candidate query failed:', err);
  }
  try {
    await sweepOrphanDerivatives();
  } catch (err) {
    console.warn('[media-sweeper] derivative sweep failed:', err);
  }
  try {
    // Last: the derivatives this tick just built are candidates too, and the
    // archive must never delay the playback preparation people wait for.
    await archiveBackfillPass();
  } catch (err) {
    console.warn('[media-archive] backfill pass failed:', err);
  } finally {
    g.__mwMediaSweeperTicking = false;
  }
}

export function startMediaSweeper(): void {
  if (g.__mwMediaSweeperStarted) return;
  g.__mwMediaSweeperStarted = true;
  console.log(`[media-sweeper] armed: every ${TICK_MS / 60000}m, ${MAX_PER_TICK} rows/tick, nice -n 15`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 2 * 60 * 1000).unref?.();
}

/** One immediate pass — dev/testing hook. */
export function triggerMediaSweep(): Promise<void> {
  return tick();
}
