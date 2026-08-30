import 'server-only';
import {
  listDueScheduledReports,
  listRecordingPendingRows,
  mergeGmeetContextForUser,
} from '@/db-ops/transcripts';
import { publishEvent } from '@/lib/server/event-bus';
import { listRecordArtifacts } from '@/lib/server/gmeet';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { fetchRecordingFromDrive, fetchVideoPartFromDrive } from '@/lib/server/recording-fetch';
import { generateAutoReport } from '@/lib/server/auto-notes';
import type { GmeetContext } from '@/lib/format';

/**
 * Watches imports where Meet listed a recording Google was still generating
 * at import time (gmeet_context.recordingPending) and attaches each video the
 * moment it lands: re-list the record's artifacts with the OWNER's
 * server-minted token (own-token rule — same identity that proved access at
 * import), diff the listing against what's already attached (primary
 * videoFileId + videoParts), write newly-available fileIds into the context,
 * then pull the bytes from Drive so playback / video reports / frame-reading
 * work without anyone clicking.
 *
 * Multi-video meetings (stop-restart recordings → several Drive files, often
 * finishing at different times): the first file to land on a row with no
 * video yet becomes the primary; every other file becomes a videoParts entry.
 * The pending marker stays 'waiting' until NO listed recording is missing its
 * file, so a second video that finishes an hour after the first still gets
 * attached.
 *
 * Cadence: young rows (call just ended — the common case) are checked every
 * tick; after FAST_WINDOW they fall back to one check per SLOW_EVERY; after
 * GIVE_UP the row is marked 'gave-up' and never visited again. Rows whose
 * owner has no usable Google connection are skipped (not counted as a check)
 * until the TTL retires them.
 *
 * Started once per server boot from instrumentation.ts.
 */

const TICK_MS = 60 * 1000;
const FAST_WINDOW_MS = 3 * 3600 * 1000;
const SLOW_EVERY_MS = 10 * 60 * 1000;
const GIVE_UP_MS = 24 * 3600 * 1000;
const MAX_PER_TICK = 20;

let started = false;
let ticking = false;

/**
 * A detailed report queued while the recording was still being prepared
 * (gmeet_context.pendingVideoReport): clear the marker and start the run.
 * Called when the primary video lands — or when it never will ('gone' /
 * 'gave-up'), in which case the run degrades to text-only on its own.
 */
async function fireQueuedReport(
  row: { user_id: string; assemblyai_id: string; gmeet_context: GmeetContext },
  reason: string
): Promise<void> {
  const queued = row.gmeet_context.pendingVideoReport;
  if (!queued) return;
  // T4: a scheduled run (runAfter in the future) is NOT fired early just
  // because the recording landed — the schedule wins; the due-report pass
  // picks it up at its time (with the video now available).
  if (queued.runAfter && new Date(queued.runAfter).getTime() > Date.now()) {
    console.log(
      `[recording-poller] ${row.assemblyai_id}: recording landed but report is scheduled for ${queued.runAfter} — leaving it`
    );
    return;
  }
  console.log(`[recording-poller] ${row.assemblyai_id}: firing queued video report (${reason})`);
  await mergeGmeetContextForUser(row.user_id, row.assemblyai_id, { pendingVideoReport: null });
  void generateAutoReport(row.user_id, row.assemblyai_id, {
    triggeredBy: queued.triggeredBy,
    instructions: queued.instructions,
    useVideo: queued.useVideo ?? true,
  });
}

/**
 * T4: fire reports whose schedule (pendingVideoReport.runAfter) has come
 * due. Same clear-then-run shape as fireQueuedReport; serialized within a
 * tick so a backlog of schedules doesn't stampede the agent runner.
 */
async function fireDueScheduledReports(): Promise<void> {
  const due = await listDueScheduledReports(MAX_PER_TICK);
  for (const row of due) {
    try {
      await fireQueuedReport(row, `scheduled run due (${row.gmeet_context.pendingVideoReport?.runAfter})`);
    } catch (err) {
      console.warn(`[recording-poller] scheduled report failed for ${row.assemblyai_id}:`, err);
    }
  }
}

async function checkRow(row: {
  user_id: string;
  assemblyai_id: string;
  gmeet_context: GmeetContext;
}): Promise<void> {
  const ctx = row.gmeet_context;
  const pending = ctx.recordingPending;
  if (!pending || pending.status !== 'waiting') return;

  const now = Date.now();
  const age = now - new Date(pending.since).getTime();

  if (age > GIVE_UP_MS) {
    console.log(`[recording-poller] giving up on ${row.assemblyai_id} after 24h`);
    await mergeGmeetContextForUser(row.user_id, row.assemblyai_id, {
      recordingPending: {
        ...pending,
        status: 'gave-up',
        resolvedAt: new Date(now).toISOString(),
      },
    });
    await fireQueuedReport(row, 'gave up waiting — report degrades to text-only');
    return;
  }

  const lastChecked = pending.lastCheckedAt ? new Date(pending.lastCheckedAt).getTime() : 0;
  if (age > FAST_WINDOW_MS && now - lastChecked < SLOW_EVERY_MS) return;

  const minted = await getServerAccessToken(row.user_id);
  if (!minted) return; // owner not connected right now — TTL retires it eventually

  const artifacts = await listRecordArtifacts(minted.token, pending.recordName);
  const listed = artifacts.recordings;

  // Zero recordings listed = Google no longer acknowledges any (discarded /
  // never saved) — stop asking. Entries without files = still processing.
  if (listed.length === 0) {
    console.log(`[recording-poller] recording gone for ${row.assemblyai_id}`);
    await mergeGmeetContextForUser(row.user_id, row.assemblyai_id, {
      recordingPending: {
        ...pending,
        lastCheckedAt: new Date(now).toISOString(),
        attempts: (pending.attempts ?? 0) + 1,
        status: 'gone',
        resolvedAt: new Date(now).toISOString(),
      },
    });
    await fireQueuedReport(row, 'recording gone — report degrades to text-only');
    return;
  }

  // Diff the listing against what this row already knows about.
  const parts = [...(ctx.videoParts ?? [])];
  const attached = new Set(
    [ctx.videoFileId, ...parts.map((p) => p.fileId)].filter((x): x is string => !!x)
  );
  const newFiles = listed
    .filter((r) => r.fileId && !attached.has(r.fileId))
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const stillGenerating = listed.some((r) => !r.fileId);

  if (newFiles.length === 0 && stillGenerating) {
    // Nothing new yet — heartbeat only.
    await mergeGmeetContextForUser(
      row.user_id,
      row.assemblyai_id,
      {
        recordingPending: {
          ...pending,
          lastCheckedAt: new Date(now).toISOString(),
          attempts: (pending.attempts ?? 0) + 1,
        },
      },
      { quiet: true } // heartbeat writes shouldn't reload every open page
    );
    return;
  }

  // The earliest new file becomes the primary when the row has none yet;
  // everything else lands in videoParts (appended — never reordered, part
  // filenames are index-derived and must stay stable).
  let primaryFileId = ctx.videoFileId ?? null;
  let newPrimary: string | null = null;
  for (const r of newFiles) {
    if (!primaryFileId) {
      primaryFileId = r.fileId!;
      newPrimary = r.fileId!;
    } else {
      parts.push({ fileId: r.fileId!, startTime: r.startTime, endTime: r.endTime });
    }
  }

  const resolved = !stillGenerating;
  console.log(
    `[recording-poller] ${row.assemblyai_id}: ${newFiles.length} new file(s) after ${Math.round(age / 60000)}m` +
      `${newPrimary ? ' (incl. primary)' : ''}${resolved ? ', all generated' : ', more still generating'}`
  );
  await mergeGmeetContextForUser(row.user_id, row.assemblyai_id, {
    ...(newPrimary ? { videoFileId: newPrimary } : {}),
    ...(parts.length > 0 ? { videoParts: parts } : {}),
    // jsonb || is shallow — carry the whole actuals object, gaps filled.
    actuals: ctx.actuals
      ? {
          ...ctx.actuals,
          recordings: listed.map((r) => ({
            fileId: r.fileId ?? undefined,
            startTime: r.startTime,
            endTime: r.endTime,
          })),
        }
      : ctx.actuals,
    recordingPending: {
      ...pending,
      ...(resolved
        ? { status: 'fetched' as const, resolvedAt: new Date(now).toISOString() }
        : {}),
      lastCheckedAt: new Date(now).toISOString(),
      attempts: (pending.attempts ?? 0) + 1,
    },
  });

  // Bytes, best-effort: context already has every fileId, so the sweeper /
  // page-visit auto-fetch retries anything that fails here.
  if (newPrimary) {
    try {
      const { bytes } = await fetchRecordingFromDrive({
        ownerUserId: row.user_id,
        assemblyaiId: row.assemblyai_id,
        fileId: newPrimary,
        accessToken: minted.token,
      });
      console.log(`[recording-poller] ${row.assemblyai_id}: stored ${bytes} bytes (primary)`);
      // setLocalAudioPathForUser doesn't publish — tell open pages the video
      // is now playable.
      publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
    } catch (err) {
      console.warn(`[recording-poller] Drive fetch failed for ${row.assemblyai_id}:`, err);
    }
    // Queued-while-preparing report: the primary video just landed (context
    // has its fileId even if the byte pull above failed — the run re-pulls
    // with the requester's token, joining any in-flight download).
    await fireQueuedReport(row, 'primary video landed');
  }
  for (const [i, part] of parts.entries()) {
    if (part.filename) continue; // already stored (or a prior visit's fetch)
    try {
      const { bytes } = await fetchVideoPartFromDrive({
        ownerUserId: row.user_id,
        assemblyaiId: row.assemblyai_id,
        fileId: part.fileId,
        partNo: i + 2,
        accessToken: minted.token,
      });
      console.log(
        `[recording-poller] ${row.assemblyai_id}: stored ${bytes} bytes (part ${i + 2})`
      );
    } catch (err) {
      console.warn(
        `[recording-poller] part ${i + 2} fetch failed for ${row.assemblyai_id}:`,
        err
      );
    }
  }
}

async function tick(): Promise<void> {
  if (ticking) return; // a multi-GB Drive pull can outlive the interval
  ticking = true;
  try {
    const rows = await listRecordingPendingRows(MAX_PER_TICK);
    for (const row of rows) {
      try {
        await checkRow(row);
      } catch (err) {
        console.warn(`[recording-poller] check failed for ${row.assemblyai_id}:`, err);
      }
    }
    await fireDueScheduledReports();
  } catch (err) {
    console.warn('[recording-poller] tick failed:', err);
  } finally {
    ticking = false;
  }
}

export function startRecordingPoller(): void {
  if (started) return;
  started = true;
  console.log(`[recording-poller] armed: every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 15 * 1000).unref?.();
}
