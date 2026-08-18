import 'server-only';
import {
  listDeferredImportRows,
  markDeferredImportFailed,
  mergeGmeetContextForUser,
} from '@/db-ops/transcripts';
import { listRecordArtifacts } from '@/lib/server/gmeet';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { executeGmeetImport } from '@/lib/server/gmeet-import-core';
import type { GmeetContext } from '@/lib/format';

/**
 * Runs imports that were queued while Google was still preparing the needed
 * artifact (gmeet_context.deferredImport on a `defer-…` placeholder row).
 * Every tick it re-lists the conference record's artifacts with the OWNER's
 * server-minted token (own-token rule — same identity that queued it) and,
 * once the mode's dependency is generated, replays the frozen import request
 * through executeGmeetImport:
 *
 *  - 'transcript' waits for a transcript Doc (or structured API entries).
 *  - 'video' waits for the first recording file.
 *  - 'both' waits for BOTH — running early would silently drop the Meet
 *    transcript (Doc failures are swallowed in that mode). If the video is
 *    ready but the Doc still hasn't appeared after BOTH_TRANSCRIPT_WAIT_MS
 *    (or Google stopped listing any transcript), it proceeds video-only.
 *
 * Execution failures back off separately from the cheap listing checks
 * (EXEC_BACKOFF_MS); a 409 means someone imported the meeting while we
 * waited and is terminal. Artifacts Google stops listing entirely are
 * terminal too ('never appeared'). 24h with no dependency → give up, row
 * flips to 'error' so the listing shows Failed instead of a forever-spinner.
 *
 * Cadence mirrors the recording poller: young rows every tick, FAST_WINDOW →
 * one check per SLOW_EVERY. Started once per server boot from
 * instrumentation.ts.
 */

const TICK_MS = 60 * 1000;
const FAST_WINDOW_MS = 3 * 3600 * 1000;
const SLOW_EVERY_MS = 10 * 60 * 1000;
const GIVE_UP_MS = 24 * 3600 * 1000;
// 'both': how long to hold a ready video hostage to a missing transcript Doc.
const BOTH_TRANSCRIPT_WAIT_MS = 6 * 3600 * 1000;
const EXEC_BACKOFF_MS = [0, 10 * 60 * 1000, 3600 * 1000, 6 * 3600 * 1000];
const MAX_EXEC_ATTEMPTS = 4;
// Imports are heavy (a video execution downloads gigabytes) — keep the
// per-tick batch small; the queue drains across ticks.
const MAX_PER_TICK = 5;

let started = false;
let ticking = false;

type DeferredMarker = NonNullable<GmeetContext['deferredImport']>;

async function heartbeat(
  userId: string,
  assemblyaiId: string,
  marker: DeferredMarker,
  patch: Partial<DeferredMarker>
): Promise<void> {
  await mergeGmeetContextForUser(
    userId,
    assemblyaiId,
    { deferredImport: { ...marker, ...patch } },
    { quiet: true }
  );
}

async function checkRow(row: {
  user_id: string;
  assemblyai_id: string;
  gmeet_context: GmeetContext;
}): Promise<void> {
  const marker = row.gmeet_context.deferredImport;
  if (!marker || marker.status !== 'waiting') return;

  const now = Date.now();
  const age = now - new Date(marker.since).getTime();
  const nowIso = new Date(now).toISOString();

  if (age > GIVE_UP_MS) {
    console.log(`[deferred-import] giving up on ${row.assemblyai_id} after 24h`);
    await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
      ...marker,
      status: 'gave-up',
      error:
        marker.error ??
        'Google never finished preparing the files within 24 hours — import it again once they appear.',
      resolvedAt: nowIso,
    });
    return;
  }

  const lastChecked = marker.lastCheckedAt ? new Date(marker.lastCheckedAt).getTime() : 0;
  if (age > FAST_WINDOW_MS && now - lastChecked < SLOW_EVERY_MS) return;

  // A prior EXECUTION failed (dependency was there, import blew up) — back
  // off harder than the cheap listing cadence before burning another run.
  const execAttempts = marker.execAttempts ?? 0;
  if (execAttempts > 0) {
    if (execAttempts >= MAX_EXEC_ATTEMPTS) {
      await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
        ...marker,
        status: 'failed',
        error: marker.error ?? 'The import kept failing — see server logs.',
        resolvedAt: nowIso,
      });
      return;
    }
    const lastExec = marker.lastExecAt ? new Date(marker.lastExecAt).getTime() : 0;
    const holdOff = EXEC_BACKOFF_MS[Math.min(execAttempts, EXEC_BACKOFF_MS.length - 1)]!;
    if (now - lastExec < holdOff) return;
  }

  const minted = await getServerAccessToken(row.user_id);
  if (!minted) return; // owner not connected right now — TTL retires it eventually

  const recordName = marker.request.conferenceRecordName;
  if (!recordName) {
    // Can't happen (deferral requires a record) — but never loop on it.
    await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
      ...marker,
      status: 'failed',
      error: 'Queued without a conference record to watch.',
      resolvedAt: nowIso,
    });
    return;
  }

  const artifacts = await listRecordArtifacts(minted.token, recordName);
  const readyVideo = artifacts.recordings.find((r) => r.fileId)?.fileId ?? null;
  const videoGone = artifacts.recordings.length === 0;
  const transcriptReady = artifacts.transcriptDocIds.length > 0;
  const transcriptGone = artifacts.transcriptsListed === 0;

  const mode = marker.mode;
  let ready = false;
  let terminalError: string | null = null;
  if (mode === 'transcript') {
    if (transcriptReady) ready = true;
    else if (transcriptGone) {
      terminalError =
        'The transcript never appeared — Google stopped listing it (discarded or never saved).';
    }
  } else if (mode === 'video') {
    if (readyVideo) ready = true;
    else if (videoGone) {
      terminalError =
        'The recording never appeared — Google stopped listing it (discarded or never saved).';
    }
  } else {
    // 'both'
    if (videoGone) {
      terminalError =
        'The recording never appeared — Google stopped listing it (discarded or never saved).';
    } else if (readyVideo) {
      // Hold for the Doc, but not forever: gone or overdue → video-only run
      // (executeGmeetImport swallows a missing transcript in 'both' mode).
      ready = transcriptReady || transcriptGone || age > BOTH_TRANSCRIPT_WAIT_MS;
    }
  }

  if (terminalError) {
    console.log(`[deferred-import] ${row.assemblyai_id}: ${terminalError}`);
    await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
      ...marker,
      lastCheckedAt: nowIso,
      attempts: (marker.attempts ?? 0) + 1,
      status: 'failed',
      error: terminalError,
      resolvedAt: nowIso,
    });
    return;
  }

  if (!ready) {
    await heartbeat(row.user_id, row.assemblyai_id, marker, {
      lastCheckedAt: nowIso,
      attempts: (marker.attempts ?? 0) + 1,
    });
    return;
  }

  console.log(
    `[deferred-import] ${row.assemblyai_id}: dependency ready after ${Math.round(age / 60000)}m — running ${mode} import`
  );
  const outcome = await executeGmeetImport(
    { userId: row.user_id, email: marker.ownerEmail },
    {
      ...marker.request,
      mode,
      accessToken: minted.token,
      // A still-generating video had no file id at queue time — use what
      // just landed (earliest segment = the primary, matching import order).
      videoFileId:
        marker.request.videoFileId ??
        ((mode === 'video' || mode === 'both') ? (readyVideo ?? undefined) : undefined),
    },
    { placeholderAssemblyaiId: row.assemblyai_id }
  );

  if (outcome.status === 201) {
    const imported = outcome.body.transcript as { assemblyai_id?: string } | undefined;
    console.log(
      `[deferred-import] ${row.assemblyai_id}: imported as ${imported?.assemblyai_id ?? '?'}`
    );
    // Transcript mode deleted the placeholder (marker died with it); video
    // modes promoted it — resolve the marker on the promoted row.
    if (mode !== 'transcript' && imported?.assemblyai_id) {
      await mergeGmeetContextForUser(row.user_id, imported.assemblyai_id, {
        deferredImport: {
          ...marker,
          lastCheckedAt: nowIso,
          status: 'done',
          resolvedAt: nowIso,
        },
      });
    }
    return;
  }

  const errText =
    typeof outcome.body.error === 'string' ? outcome.body.error : `Import failed (${outcome.status})`;
  if (outcome.status === 409) {
    // Someone imported this meeting while we waited — retrying can never
    // succeed. Leave the failed row pointing at what happened.
    await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
      ...marker,
      lastCheckedAt: nowIso,
      status: 'failed',
      error: errText,
      resolvedAt: nowIso,
    });
    return;
  }

  console.warn(`[deferred-import] execution failed for ${row.assemblyai_id}: ${errText}`);
  await heartbeat(row.user_id, row.assemblyai_id, marker, {
    lastCheckedAt: nowIso,
    attempts: (marker.attempts ?? 0) + 1,
    execAttempts: execAttempts + 1,
    lastExecAt: nowIso,
    error: errText,
  });
}

async function tick(): Promise<void> {
  if (ticking) return; // a video execution can far outlive the interval
  ticking = true;
  try {
    const rows = await listDeferredImportRows(MAX_PER_TICK);
    for (const row of rows) {
      try {
        await checkRow(row);
      } catch (err) {
        console.warn(`[deferred-import] check failed for ${row.assemblyai_id}:`, err);
      }
    }
  } catch (err) {
    console.warn('[deferred-import] tick failed:', err);
  } finally {
    ticking = false;
  }
}

export function startDeferredImportPoller(): void {
  if (started) return;
  started = true;
  console.log(`[deferred-import] armed: every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 20 * 1000).unref?.();
}
