import 'server-only';
import {
  listAutoImportEnabledSeries,
  listAutoImportLog,
  recordAutoImportFire,
  setSeriesAutoImport,
  type SeriesRow,
} from '@/db-ops/series';
import { sweepSeriesOccurrences, type SeriesOccurrence } from '@/lib/server/series-occurrences';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { executeGmeetImport } from '@/lib/server/gmeet-import-core';
import { executeTeamsImport } from '@/lib/server/teams-import-core';
import { notifyUser, APP_URL } from '@/lib/server/darth-notify';

/**
 * Series auto-import: for every series with auto_import enabled, re-run the
 * same occurrence sweep the series dialog uses (as the ENABLER — their
 * Google connection) and fire imports for new past occurrences that have
 * artifacts. Still-generating artifacts ride the existing deferred-import
 * machinery (defer: true); each fired row is stamped with
 * gmeet_context.autoImport + the configured report pref, which arms the
 * automatic speaker-review evaluation at completion (auto-review.ts).
 *
 * Fire-once: series_auto_import_log records every occurrence acted on;
 * 'failed' fires may retry after FAILED_RETRY_MS, everything else is final
 * (the deferred poller owns any waiting from there).
 *
 * Called from the gmeet poller's 30-minute pass. The dialog's external
 * sweep cache is 6h — too slow for "the call just ended", so this forces a
 * fresh external sweep once the config's lastSweepAt is older than
 * REFRESH_MS.
 */

const REFRESH_MS = 55 * 60 * 1000; // force a fresh external sweep hourly
const FAILED_RETRY_MS = 12 * 3600 * 1000;
const DOWNGRADE_AFTER_MS = 12 * 3600 * 1000; // 'both' waits this long for the missing half
const MAX_FIRES_PER_PASS = 4; // per series — video imports are heavy

export async function sweepAutoImportSeries(): Promise<void> {
  let list: SeriesRow[];
  try {
    list = await listAutoImportEnabledSeries();
  } catch (err) {
    console.warn('[series-auto-import] listing enabled series failed:', err);
    return;
  }
  for (const s of list) {
    try {
      await sweepOne(s);
    } catch (err) {
      console.warn(`[series-auto-import] sweep failed for series ${s.id}:`, err);
      const cfg = s.auto_import;
      if (cfg) {
        await setSeriesAutoImport(s.id, {
          ...cfg,
          lastSweepAt: new Date().toISOString(),
          lastError: err instanceof Error ? err.message : String(err),
        }).catch(() => {});
      }
    }
  }
}

function providerOf(o: SeriesOccurrence): 'teams' | 'gmeet' | null {
  if (o.teams?.joinWebUrl) return 'teams';
  if (o.meetingCode || o.videoFileId || o.transcriptDocId) return 'gmeet';
  return null;
}

async function sweepOne(series: SeriesRow): Promise<void> {
  const cfg = series.auto_import!;
  const caller = { userId: cfg.byUserId, email: cfg.byEmail };
  const now = Date.now();
  const forceRefresh = !cfg.lastSweepAt || now - Date.parse(cfg.lastSweepAt) > REFRESH_MS;

  const result = await sweepSeriesOccurrences(series.id, caller, { forceRefresh });
  if (!result) return;

  const log = await listAutoImportLog(series.id);
  const sinceMs = Date.parse(cfg.since);
  const wantVideo = cfg.mode !== 'transcript';
  const wantTranscript = cfg.mode !== 'video';

  const candidates = result.occurrences.filter((o) => {
    if (o.upcoming || o.imported.length > 0) return false;
    if (Date.parse(o.startIso) <= sinceMs) return false;
    const prior = log.get(o.key);
    if (prior && !(prior.outcome === 'failed' && now - Date.parse(prior.fired_at) > FAILED_RETRY_MS))
      return false;
    if (!providerOf(o)) return false;
    // At least one artifact the mode wants must be listed — bare occurrences
    // just wait (they stay visible in the dialog's coverage strip).
    return (wantVideo && o.hasRecording) || (wantTranscript && o.hasTranscript);
  });

  // Oldest first so a backlog drains in order across passes.
  candidates.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));

  let fired = 0;
  for (const o of candidates.slice(0, MAX_FIRES_PER_PASS)) {
    await fireOne(series, cfg, caller, o, now);
    fired += 1;
  }
  if (fired > 0) console.log(`[series-auto-import] series ${series.id}: fired ${fired} import(s)`);

  await setSeriesAutoImport(series.id, {
    ...cfg,
    lastSweepAt: new Date(now).toISOString(),
    lastError: null,
  });
}

async function fireOne(
  series: SeriesRow,
  cfg: NonNullable<SeriesRow['auto_import']>,
  caller: { userId: string; email: string },
  o: SeriesOccurrence,
  now: number
): Promise<void> {
  // 'both' downgrades to whichever half exists once the other half is
  // clearly never coming (mirrors the deferred poller's stance).
  const ageMs = now - Date.parse(o.startIso);
  let mode = cfg.mode;
  if (mode === 'both' && ageMs > DOWNGRADE_AFTER_MS) {
    if (!o.hasRecording && o.hasTranscript) mode = 'transcript';
    else if (!o.hasTranscript && o.hasRecording) mode = 'video';
  }

  const contextExtra = {
    autoImport: {
      seriesId: series.id,
      seriesTitle: series.title,
      occKey: o.key,
      byUserId: cfg.byUserId,
      byEmail: cfg.byEmail,
      at: new Date(now).toISOString(),
    },
    uploadPrefs: { report: cfg.report },
  };
  const event = {
    id: o.eventId ?? undefined,
    title: o.title ?? undefined,
    startTime: o.startIso,
    endTime: o.endIso ?? undefined,
    meetingCode: o.meetingCode ?? undefined,
    recurringEventId: o.recurringEventId ?? undefined,
    iCalUID: o.iCalUID ?? undefined,
    organizerEmail: o.organizerEmail ?? undefined,
    attendees: o.attendees,
  };

  let outcome: { status: number; body: Record<string, unknown> };
  try {
    if (providerOf(o) === 'teams') {
      outcome = await executeTeamsImport(
        caller,
        { url: o.teams!.joinWebUrl, mode, defer: true, event, contextExtra }
      );
    } else {
      const minted = await getServerAccessToken(cfg.byUserId);
      if (!minted) {
        throw new Error(`Google not connected for ${cfg.byEmail} — cannot auto-import`);
      }
      outcome = await executeGmeetImport(caller, {
        accessToken: minted.token,
        mode,
        videoFileId: o.videoFileId ?? undefined,
        transcriptDocId: o.transcriptDocId ?? undefined,
        defer: true,
        event,
        contextExtra,
      });
    }
  } catch (err) {
    outcome = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }

  const imported = outcome.body.transcript as { assemblyai_id?: string } | undefined;
  const kind =
    outcome.status === 201
      ? 'imported'
      : outcome.status === 202
        ? 'deferred'
        : outcome.status === 409
          ? 'already'
          : 'failed';
  await recordAutoImportFire({
    seriesId: series.id,
    occKey: o.key,
    occStart: o.startIso,
    title: o.title,
    outcome: kind,
    assemblyaiId: imported?.assemblyai_id ?? null,
    detail:
      kind === 'failed'
        ? String((outcome.body.error as string | undefined) ?? `status ${outcome.status}`)
        : null,
  });
  console.log(
    `[series-auto-import] series ${series.id} "${o.title ?? o.key}": ${kind}` +
      (kind === 'failed' ? ` — ${outcome.body.error}` : '')
  );

  if (kind === 'imported' || kind === 'deferred') {
    const when = o.startIso.slice(0, 10);
    const link = imported?.assemblyai_id
      ? `<${APP_URL}/transcript/${imported.assemblyai_id}|open>`
      : `<${APP_URL}/series|series>`;
    void notifyUser({
      kind: 'auto_import',
      toEmail: cfg.byEmail,
      text:
        kind === 'imported'
          ? `Auto-imported *${o.title ?? 'a meeting'}* (${when}) from series *${series.title}* → ${link}`
          : `Queued auto-import of *${o.title ?? 'a meeting'}* (${when}) from series *${series.title}* — artifacts still generating, it will land on its own → ${link}`,
      dedupeKey: `mw-autoimport:${series.id}:${o.key}`,
    });
  }
}
