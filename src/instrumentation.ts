/**
 * Next.js server-boot hook. Runs once per server process (node runtime only —
 * skipped for the edge/proxy bundle, which can't hold timers or DB handles).
 *
 * `MW_DISABLE_POLLERS=1` starts NONE of the background sweepers/pollers. It is
 * for a local dev server: that server points at the PROD schema, and every
 * poller below writes to it (status flips, imports, deletes at AssemblyAI) the
 * moment it boots. With the switch set the app still serves every route; only
 * the timers are not armed. Never set it on the VM.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (pollersDisabled()) {
      console.warn('[instrumentation] MW_DISABLE_POLLERS is set — no background pollers or sweepers started');
      return;
    }
    const { startAutoNotesSweeper } = await import('@/lib/server/auto-notes-sweeper');
    startAutoNotesSweeper();
    const { startGmeetPoller } = await import('@/lib/server/gmeet-poller');
    startGmeetPoller();
    const { startRecordingPoller } = await import('@/lib/server/recording-poller');
    startRecordingPoller();
    const { startVideoFetchSweeper } = await import('@/lib/server/video-fetch-sweeper');
    startVideoFetchSweeper();
    const { startDeferredImportPoller } = await import('@/lib/server/deferred-import-poller');
    startDeferredImportPoller();
    const { startIngestRetrySweeper } = await import('@/lib/server/ingest-retry');
    startIngestRetrySweeper();
    const { startMediaSweeper } = await import('@/lib/server/media-sweeper');
    startMediaSweeper();
  }
}

/** Lazy, per boot — `bun run build` must pass with no env at all. */
export function pollersDisabled(): boolean {
  const raw = (process.env.MW_DISABLE_POLLERS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
