import 'server-only';
import { listRecordingPendingRows, mergeGmeetContextForUser } from '@/db-ops/transcripts';
import { publishEvent } from '@/lib/server/event-bus';
import { listRecordArtifacts } from '@/lib/server/gmeet';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { fetchRecordingFromDrive } from '@/lib/server/recording-fetch';
import type { GmeetContext } from '@/lib/format';

/**
 * Watches imports whose Meet recording Google was still generating at import
 * time (gmeet_context.recordingPending) and attaches the video the moment it
 * lands: re-list the record's artifacts with the OWNER's server-minted token
 * (own-token rule — same identity that proved access at import), write the
 * discovered fileId into the context, then pull the bytes from Drive so
 * playback / video reports / frame-reading work without anyone clicking.
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
    return;
  }

  const lastChecked = pending.lastCheckedAt ? new Date(pending.lastCheckedAt).getTime() : 0;
  if (age > FAST_WINDOW_MS && now - lastChecked < SLOW_EVERY_MS) return;

  const minted = await getServerAccessToken(row.user_id);
  if (!minted) return; // owner not connected right now — TTL retires it eventually

  const artifacts = await listRecordArtifacts(minted.token, pending.recordName);
  const fileId = artifacts.recordings.find((r) => r.fileId)?.fileId ?? null;

  if (!fileId) {
    // Zero recordings listed = Google no longer acknowledges one (discarded /
    // never saved) — stop asking. Entries without files = still processing.
    const gone = artifacts.recordings.length === 0;
    if (gone) console.log(`[recording-poller] recording gone for ${row.assemblyai_id}`);
    await mergeGmeetContextForUser(
      row.user_id,
      row.assemblyai_id,
      {
        recordingPending: {
          ...pending,
          lastCheckedAt: new Date(now).toISOString(),
          attempts: (pending.attempts ?? 0) + 1,
          ...(gone ? { status: 'gone' as const, resolvedAt: new Date(now).toISOString() } : {}),
        },
      },
      { quiet: !gone } // heartbeat writes shouldn't reload every open page
    );
    return;
  }

  console.log(
    `[recording-poller] ${row.assemblyai_id}: file ${fileId} ready after ${Math.round(age / 60000)}m, fetching from Drive`
  );
  await mergeGmeetContextForUser(row.user_id, row.assemblyai_id, {
    videoFileId: fileId,
    // jsonb || is shallow — carry the whole actuals object, gaps filled.
    actuals: ctx.actuals
      ? {
          ...ctx.actuals,
          recordings: artifacts.recordings.map((r) => ({
            fileId: r.fileId ?? undefined,
            startTime: r.startTime,
            endTime: r.endTime,
          })),
        }
      : ctx.actuals,
    recordingPending: {
      ...pending,
      status: 'fetched',
      resolvedAt: new Date(now).toISOString(),
      lastCheckedAt: new Date(now).toISOString(),
      attempts: (pending.attempts ?? 0) + 1,
    },
  });

  try {
    const { bytes } = await fetchRecordingFromDrive({
      ownerUserId: row.user_id,
      assemblyaiId: row.assemblyai_id,
      fileId,
      accessToken: minted.token,
    });
    console.log(`[recording-poller] ${row.assemblyai_id}: stored ${bytes} bytes`);
    // setLocalAudioPathForUser doesn't publish — tell open pages the video
    // is now playable.
    publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  } catch (err) {
    // Context already has the fileId — the detail page's auto-fetch on next
    // visit (or the manual button) retries with the viewer's token.
    console.warn(`[recording-poller] Drive fetch failed for ${row.assemblyai_id}:`, err);
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
