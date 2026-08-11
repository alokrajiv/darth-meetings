import 'server-only';
import { listVideoFetchCandidates, mergeGmeetContextForUser } from '@/db-ops/transcripts';
import { publishEvent } from '@/lib/server/event-bus';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { isGraphConfigured } from '@/lib/server/ms-graph';
import {
  fetchRecordingFromDrive,
  fetchRecordingFromTeams,
  fetchVideoPartFromDrive,
} from '@/lib/server/recording-fetch';
import type { GmeetContext } from '@/lib/format';

/**
 * Background video fetcher: rows whose recording is KNOWN (Meet videoFileId /
 * Teams recordingId) but whose bytes were never pulled get downloaded without
 * waiting for someone to open the detail page. Complements — does not
 * replace — the page-load auto-fetch (which stays as the retry of last
 * resort) and the recording-poller (which handles files Google is still
 * GENERATING; those rows are excluded here until the file id lands).
 *
 * Failure discipline: attempts are stamped into gmeet_context.videoAutoFetch
 * with exponential backoff (10m → 1h → 6h → 24h), giving up after
 * MAX_ATTEMPTS — a page visit or manual fetch still works after that.
 * Downloads run strictly one at a time (multi-GB pulls; a tick that's still
 * downloading skips itself), and the shared in-flight map means a
 * user-triggered fetch of the same row joins this download instead of
 * doubling it.
 */

const TICK_MS = 5 * 60 * 1000;
const MAX_PER_TICK = 2;
const MAX_ATTEMPTS = 5;
/** Delay before attempt N+1, indexed by N (attempts already made). */
const BACKOFF_MS = [0, 10 * 60_000, 60 * 60_000, 6 * 3600_000, 24 * 3600_000];

let started = false;
let ticking = false;

function eligible(ctx: GmeetContext, now: number): boolean {
  const st = ctx.videoAutoFetch;
  if (!st) return true;
  if (st.status !== 'pending') return false;
  const wait = BACKOFF_MS[Math.min(st.attempts, BACKOFF_MS.length - 1)]!;
  return now - Date.parse(st.lastAttemptAt) >= wait;
}

async function fetchRow(row: {
  user_id: string;
  assemblyai_id: string;
  local_audio_path: string | null;
  gmeet_context: GmeetContext;
}): Promise<void> {
  const ctx = row.gmeet_context;
  const now = Date.now();
  const teams = ctx.provider === 'teams' ? ctx.teams : null;

  // Extra recording segments (multi-video meetings) whose bytes are missing.
  const missingParts = (ctx.videoParts ?? [])
    .map((p, i) => ({ ...p, partNo: i + 2 }))
    .filter((p) => p.fileId && !p.filename);

  try {
    let bytes: number;
    if (teams?.recordingId) {
      if (!isGraphConfigured()) return; // config gap — don't burn attempts
      ({ bytes } = await fetchRecordingFromTeams({
        ownerUserId: row.user_id,
        assemblyaiId: row.assemblyai_id,
        organizerOid: teams.organizerOid,
        graphMeetingId: teams.graphMeetingId,
        recordingId: teams.recordingId,
      }));
    } else {
      const fileId = ctx.videoFileId ?? ctx.actuals?.recordings?.[0]?.fileId;
      if (!fileId && missingParts.length === 0) return;
      // Own-token rule: the OWNER's stored Google connection. Not connected
      // right now → skip without burning an attempt; their reconnect or a
      // viewer's page visit picks it up later.
      const minted = await getServerAccessToken(row.user_id);
      if (!minted) return;
      bytes = 0;
      if (fileId && !row.local_audio_path) {
        ({ bytes } = await fetchRecordingFromDrive({
          ownerUserId: row.user_id,
          assemblyaiId: row.assemblyai_id,
          fileId,
          accessToken: minted.token,
        }));
      }
      for (const part of missingParts) {
        const res = await fetchVideoPartFromDrive({
          ownerUserId: row.user_id,
          assemblyaiId: row.assemblyai_id,
          fileId: part.fileId,
          partNo: part.partNo,
          accessToken: minted.token,
        });
        bytes += res.bytes;
        console.log(
          `[video-fetch] ${row.assemblyai_id}: stored ${res.bytes} bytes (part ${part.partNo})`
        );
      }
    }
    console.log(`[video-fetch] ${row.assemblyai_id}: stored ${bytes} bytes`);
    // setLocalAudioPathForUser doesn't publish — tell open pages the video
    // is now playable.
    publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  } catch (err) {
    const attempts = (ctx.videoAutoFetch?.attempts ?? 0) + 1;
    const gaveUp = attempts >= MAX_ATTEMPTS;
    console.warn(
      `[video-fetch] ${row.assemblyai_id}: attempt ${attempts} failed${gaveUp ? ' (giving up)' : ''}:`,
      err
    );
    await mergeGmeetContextForUser(
      row.user_id,
      row.assemblyai_id,
      {
        videoAutoFetch: {
          attempts,
          lastAttemptAt: new Date(now).toISOString(),
          status: gaveUp ? 'gave-up' : 'pending',
          lastError: String(err).slice(0, 300),
        },
      },
      { quiet: true }
    ).catch(() => {});
  }
}

async function tick(): Promise<void> {
  if (ticking) return; // a multi-GB download can outlive the interval
  ticking = true;
  try {
    const rows = await listVideoFetchCandidates(50);
    const now = Date.now();
    const due = rows.filter((r) => eligible(r.gmeet_context, now)).slice(0, MAX_PER_TICK);
    for (const row of due) {
      await fetchRow(row); // strictly serial — never two big pulls at once
    }
  } catch (err) {
    console.warn('[video-fetch] tick failed:', err);
  } finally {
    ticking = false;
  }
}

export function startVideoFetchSweeper(): void {
  if (started) return;
  started = true;
  console.log(`[video-fetch] armed: every ${TICK_MS / 60000}m`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 90 * 1000).unref?.();
}

/** One immediate pass — dev/testing hook. */
export function triggerVideoFetchSweep(): Promise<void> {
  return tick();
}
