import 'server-only';
import {
  listDeferredImportRows,
  markDeferredImportFailed,
  mergeGmeetContextForUser,
} from '@/db-ops/transcripts';
import { listRecordArtifacts } from '@/lib/server/gmeet';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { executeGmeetImport } from '@/lib/server/gmeet-import-core';
import { executeTeamsImport } from '@/lib/server/teams-import-core';
import { notifyUser, APP_URL } from '@/lib/server/darth-notify';
import type { GmeetContext } from '@/lib/format';

/**
 * Runs imports that were queued while the provider was still preparing the
 * needed artifact (gmeet_context.deferredImport on a `defer-…` placeholder
 * row).
 *
 * Google Meet rows: every tick it re-lists the conference record's artifacts
 * with the OWNER's server-minted token (own-token rule — same identity that
 * queued it) and, once the mode's dependency is generated, replays the
 * frozen import request through executeGmeetImport:
 *
 *  - 'transcript' waits for a transcript Doc (or structured API entries).
 *  - 'video' waits for the first recording file.
 *  - 'both' waits for BOTH — running early would silently drop the Meet
 *    transcript (Doc failures are swallowed in that mode). If the video is
 *    ready but the Doc still hasn't appeared after BOTH_TRANSCRIPT_WAIT_MS
 *    (or Google stopped listing any transcript), it proceeds video-only.
 *
 * Teams rows (gmeet_context.provider === 'teams'): Graph is app-only — no
 * owner token needed. There is no separate "listed but file pending" state
 * on Graph either, so each check simply replays executeTeamsImport; a 422
 * carrying `notReady` means the artifact still isn't there (cheap — two
 * Graph list calls) and counts as a listing check, anything else is a real
 * execution outcome handled like the Meet path.
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

// Guard state lives on globalThis, NOT in module scope: Next.js compiles
// instrumentation.ts and each API route into separate bundles that can each
// load their own COPY of this module, so module-level flags give every copy
// its own `ticking` guard. Observed 2026-08-20: a route-kicked tick (route
// bundle's copy) and the interval tick (instrumentation's copy) each saw a
// queued row still 'waiting' — the marker only resolves after execution —
// and imported the same meeting twice. globalThis is per-process and
// therefore genuinely shared across bundle copies.
const pollerState = ((globalThis as unknown as Record<string, { started: boolean; ticking: boolean }>)
  .__mwDeferredImportPoller ??= { started: false, ticking: false });

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

/**
 * Shared post-execution bookkeeping: 201 resolves the marker (transcript
 * mode already deleted the placeholder; video modes promoted it — stamp
 * 'done' on the promoted row), 409 and other terminal statuses fail the row
 * for good, anything else counts an exec attempt and backs off.
 */
async function settleExecOutcome(
  row: { user_id: string; assemblyai_id: string },
  marker: DeferredMarker,
  nowIso: string,
  outcome: { status: number; body: Record<string, unknown> },
  terminalStatuses: number[] = [409]
): Promise<void> {
  const title = marker.request.event?.title?.trim() || 'a queued meeting import';
  if (outcome.status === 201) {
    const imported = outcome.body.transcript as { assemblyai_id?: string } | undefined;
    console.log(
      `[deferred-import] ${row.assemblyai_id}: imported as ${imported?.assemblyai_id ?? '?'}`
    );
    if (marker.mode !== 'transcript' && imported?.assemblyai_id) {
      await mergeGmeetContextForUser(row.user_id, imported.assemblyai_id, {
        deferredImport: {
          ...marker,
          lastCheckedAt: nowIso,
          status: 'done',
          resolvedAt: nowIso,
        },
      });
    }
    // Background imports land minutes after the user clicked Import and the
    // listing shows the progress — a "landed" DM would be noise. Deferred
    // imports resolve hours later, so those DO get told. Failures always DM.
    if (!marker.background) {
      void notifyUser({
        kind: 'deferred_import',
        toEmail: marker.ownerEmail,
        text: `Your queued import landed: *${title}* → <${APP_URL}/transcript/${imported?.assemblyai_id ?? row.assemblyai_id}|open>`,
        dedupeKey: `mw-deferred-landed:${row.assemblyai_id}`,
      });
    }
    return;
  }

  const errText =
    typeof outcome.body.error === 'string' ? outcome.body.error : `Import failed (${outcome.status})`;
  if (terminalStatuses.includes(outcome.status)) {
    // 409: someone imported this meeting while we waited — retrying can
    // never succeed. Leave the failed row pointing at what happened.
    await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
      ...marker,
      lastCheckedAt: nowIso,
      status: 'failed',
      error: errText,
      resolvedAt: nowIso,
    });
    if (outcome.status !== 409) {
      // 409 means the meeting IS in the app (someone else beat the queue) —
      // nothing for the owner to act on, so stay quiet.
      void notifyUser({
        kind: 'deferred_import',
        toEmail: marker.ownerEmail,
        text: `Your queued import for *${title}* failed for good: ${errText}`,
        dedupeKey: `mw-deferred-failed:${row.assemblyai_id}`,
      });
    }
    return;
  }

  console.warn(`[deferred-import] execution failed for ${row.assemblyai_id}: ${errText}`);
  await heartbeat(row.user_id, row.assemblyai_id, marker, {
    lastCheckedAt: nowIso,
    attempts: (marker.attempts ?? 0) + 1,
    execAttempts: (marker.execAttempts ?? 0) + 1,
    lastExecAt: nowIso,
    error: errText,
  });
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

  const vendor = row.gmeet_context.provider === 'teams' ? 'Microsoft' : 'Google';
  if (age > GIVE_UP_MS) {
    console.log(`[deferred-import] giving up on ${row.assemblyai_id} after 24h`);
    await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
      ...marker,
      status: 'gave-up',
      error:
        marker.error ??
        `${vendor} never finished preparing the files within 24 hours — import it again once they appear.`,
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

  // ---- Teams: replay the import outright — a `notReady` 422 is the cheap
  // "artifact still isn't there" signal (two Graph list calls, app-only). ---
  if (row.gmeet_context.provider === 'teams') {
    const url = marker.request.url;
    if (!url) {
      await markDeferredImportFailed(row.user_id, row.assemblyai_id, {
        ...marker,
        status: 'failed',
        error: 'Queued without a Teams link to watch.',
        resolvedAt: nowIso,
      });
      return;
    }
    const outcome = await executeTeamsImport(
      { userId: row.user_id, email: marker.ownerEmail },
      {
        url,
        mode: marker.mode,
        languageCode: marker.request.languageCode,
        force: marker.request.force,
        event: marker.request.event,
        contextExtra: marker.request.contextExtra,
      },
      { placeholderAssemblyaiId: row.assemblyai_id }
    );
    if (outcome.status === 422 && typeof outcome.body.notReady === 'string') {
      await heartbeat(row.user_id, row.assemblyai_id, marker, {
        lastCheckedAt: nowIso,
        attempts: (marker.attempts ?? 0) + 1,
      });
      return;
    }
    if (outcome.status === 201) {
      console.log(
        `[deferred-import] ${row.assemblyai_id}: teams dependency ready after ${Math.round(age / 60000)}m`
      );
    }
    // 404 = the meeting was deleted on Microsoft 365 — waiting can't fix it.
    await settleExecOutcome(row, marker, nowIso, outcome, [409, 404]);
    return;
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

  // Background rows were queued with the artifacts ALREADY ready and the
  // file id frozen in the request — there is nothing to wait for, so skip
  // the artifact-listing gate entirely. The gate would even lie here: for a
  // meeting the owner didn't organize, the Meet API lists zero artifacts
  // under their token, which reads as "the recording never appeared" and
  // would kill a perfectly good import (the Drive download itself works —
  // Drive sharing, not Meet API access, is what gates the file).
  const mode = marker.mode;
  let readyVideo: string | null = null;
  if (!(marker.background && marker.request.videoFileId)) {
    const artifacts = await listRecordArtifacts(minted.token, recordName);
    readyVideo = artifacts.recordings.find((r) => r.fileId)?.fileId ?? null;
    const videoGone = artifacts.recordings.length === 0;
    const transcriptReady = artifacts.transcriptDocIds.length > 0;
    const transcriptGone = artifacts.transcriptsListed === 0;

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
  await settleExecOutcome(row, marker, nowIso, outcome);
}

async function tick(): Promise<void> {
  if (pollerState.ticking) return; // a video execution can far outlive the interval
  pollerState.ticking = true;
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
    pollerState.ticking = false;
  }
}

/**
 * Run a tick soon — the import routes call this right after queueing a
 * background import so it starts in seconds instead of on the next interval.
 * The short delay lets the HTTP response flush first; the `ticking` guard
 * dedupes overlap with the interval.
 */
export function kickDeferredImportPoller(): void {
  setTimeout(() => void tick(), 500).unref?.();
}

export function startDeferredImportPoller(): void {
  if (pollerState.started) return;
  pollerState.started = true;
  console.log(`[deferred-import] armed: every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 20 * 1000).unref?.();
}
