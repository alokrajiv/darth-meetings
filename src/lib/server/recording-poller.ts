import 'server-only';
import {
  listDueScheduledReports,
  listRecordingPendingRows,
  listResumeWatchRows,
  mergeGmeetContextForUser,
} from '@/db-ops/transcripts';
import { identityForUser } from '@/db-ops/transcript-activity';
import { publishEvent } from '@/lib/server/event-bus';
import {
  listConferenceRecords,
  listRecordArtifacts,
  recordFilterForOccurrence,
} from '@/lib/server/gmeet';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { fetchRecordingFromDrive, fetchVideoPartFromDrive } from '@/lib/server/recording-fetch';
import { generateAutoReport } from '@/lib/server/auto-notes';
import { notifyUser } from '@/lib/server/darth-notify';
import { dm, meetingLine, openLink, whenLine } from '@/lib/server/dm-copy';
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
 * The tick also runs the RESUME SWEEP (gmeet_context.resumeWatch): hanging
 * up and rejoining the same Meet link opens a SECOND conferenceRecord, whose
 * artifacts neither this poller (pinned to the imported recordName) nor
 * discovery (nearestRecord picks one record per occurrence) nor auto-sync
 * (occKey already claimed) would ever surface. For a few hours after each
 * import the sweep re-lists the meeting code's records; an ended sibling
 * with recordings is adopted by re-arming recordingPending against it, and
 * the ordinary diff-attach path above turns its videos into videoParts.
 *
 * Started once per server boot from instrumentation.ts.
 */

const TICK_MS = 60 * 1000;
const FAST_WINDOW_MS = 3 * 3600 * 1000;
const SLOW_EVERY_MS = 10 * 60 * 1000;
const GIVE_UP_MS = 24 * 3600 * 1000;
const MAX_PER_TICK = 20;

/** Resume sweep: watch this long past the imported conference's end. */
const RESUME_WATCH_WINDOW_MS = 6 * 3600 * 1000;
/** Per-row Meet API cadence while watching. */
const RESUME_CHECK_EVERY_MS = 5 * 60 * 1000;
/** A resume must START within this of the imported sitting's end — beyond
 * it, a record on the same (reused) link is a different meeting. */
const RESUME_SIBLING_SLOP_MS = 3 * 3600 * 1000;
/** A just-ended sibling listing zero recordings may simply not have them
 * indexed yet — only conclude "wasn't recorded" after this grace. */
const RESUME_EMPTY_GRACE_MS = 15 * 60 * 1000;
const MAX_RESUME_SIBLINGS = 4;
const MAX_RESUME_PER_TICK = 15;

let started = false;
let ticking = false;

/**
 * Union a freshly-listed record's recordings into the actuals snapshot.
 * With resume adoption the snapshot spans MULTIPLE conference records, so a
 * plain replace would erase the other records' entries. The fresh listing
 * wins for its own fileIds; fileId-less placeholders from older listings
 * drop (they only matter while their record is the one being polled).
 */
function mergeActualsRecordings(
  existing: Array<{ fileId?: string; startTime?: string; endTime?: string }> | undefined,
  listed: Array<{ fileId: string | null; startTime?: string; endTime?: string }>
): Array<{ fileId?: string; startTime?: string; endTime?: string }> {
  const listedIds = new Set(listed.map((r) => r.fileId).filter((x): x is string => !!x));
  return [
    ...(existing ?? []).filter((r) => r.fileId && !listedIds.has(r.fileId)),
    ...listed.map((r) => ({ fileId: r.fileId ?? undefined, startTime: r.startTime, endTime: r.endTime })),
  ].sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
}

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
          recordings: mergeActualsRecordings(ctx.actuals.recordings, listed),
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

// ---------------------------------------------------------------------------
// Resume sweep — hang-up-and-rejoin detection (gmeet_context.resumeWatch)
// ---------------------------------------------------------------------------

type ResumeRow = Awaited<ReturnType<typeof listResumeWatchRows>>[number];

/** Everyone who should hear about a resumed session: whoever's automation or
 * queued import created the row (+ auto-sync watchers), else the row owner's
 * last known identity (there is no users table). */
async function resumeRecipients(row: ResumeRow): Promise<string[]> {
  const ctx = row.gmeet_context;
  const set = new Set<string>();
  for (const e of [ctx.autoSync?.byEmail, ctx.autoImport?.byEmail, ctx.deferredImport?.ownerEmail]) {
    if (e) set.add(e.toLowerCase());
  }
  for (const w of ctx.autoSync?.watchers ?? []) if (w) set.add(w.toLowerCase());
  if (set.size === 0) {
    const id = await identityForUser(row.user_id).catch(() => null);
    if (id?.email) set.add(id.email.toLowerCase());
  }
  return [...set];
}

async function checkResumeRow(row: ResumeRow): Promise<void> {
  const ctx = row.gmeet_context;
  const importedRecord = ctx.actuals?.conferenceRecordName;
  const code = ctx.meetingCode;
  if (!importedRecord || !code) return; // SQL guarantees these; belt only

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const watch: NonNullable<GmeetContext['resumeWatch']> = ctx.resumeWatch ?? {
    knownRecords: [importedRecord],
    since: nowIso,
    status: 'watching',
  };
  if (watch.status !== 'watching') return;

  // The watch clock runs from the imported sitting's end (fallbacks for rows
  // missing actuals timing: event end/start, then row creation). A detected
  // sibling that is not adopted yet keeps the watch open past the base
  // window — its recording only starts generating when ITS sitting ends.
  const confEndIso = ctx.actuals?.conferenceEnd ?? ctx.endTime ?? ctx.startTime ?? null;
  const anchorMs = confEndIso ? Date.parse(confEndIso) : new Date(row.created_at).getTime();
  const expiryMs =
    Math.max(
      anchorMs,
      ...(watch.found ?? [])
        .filter((f) => !f.adoptedAt)
        .map((f) => Date.parse(f.endTime ?? f.startTime ?? ''))
        .filter((t) => Number.isFinite(t))
    ) + RESUME_WATCH_WINDOW_MS;
  if (!Number.isFinite(anchorMs) || now > expiryMs) {
    await mergeGmeetContextForUser(
      row.user_id,
      row.assemblyai_id,
      { resumeWatch: { ...watch, status: 'done', resolvedAt: nowIso } },
      { quiet: true }
    );
    return;
  }

  const lastChecked = watch.lastCheckedAt ? Date.parse(watch.lastCheckedAt) : 0;
  if (now - lastChecked < RESUME_CHECK_EVERY_MS) return;

  const minted = await getServerAccessToken(row.user_id);
  if (!minted) return; // owner not connected — the window retires the row

  const heartbeat = (extra?: Partial<NonNullable<GmeetContext['resumeWatch']>>) =>
    mergeGmeetContextForUser(
      row.user_id,
      row.assemblyai_id,
      {
        resumeWatch: {
          ...watch,
          ...extra,
          lastCheckedAt: nowIso,
          attempts: (watch.attempts ?? 0) + 1,
        },
      },
      { quiet: true }
    );

  const eventStartIso = ctx.startTime ?? ctx.actuals?.conferenceStart ?? confEndIso;
  const records = await listConferenceRecords(
    minted.token,
    recordFilterForOccurrence(code, eventStartIso)
  );
  if (!records) {
    await heartbeat(); // API refused — not evidence of anything
    return;
  }

  const known = new Set([importedRecord, ...watch.knownRecords]);
  if (ctx.recordingPending?.recordName) known.add(ctx.recordingPending.recordName);

  // Same-sitting guards: a sibling must start AFTER the imported record began
  // (an earlier record on the same code is a previous meeting on a reused
  // link) and within the slop of the sitting's end (far beyond it, someone is
  // reusing the link for a different meeting).
  const confStartMs = Date.parse(ctx.actuals?.conferenceStart ?? ctx.startTime ?? '') || anchorMs;
  const sittingEndMs = Math.max(
    anchorMs,
    ...[ctx.actuals?.conferenceEnd, ctx.endTime]
      .map((t) => (t ? Date.parse(t) : NaN))
      .filter((t) => Number.isFinite(t))
  );
  const siblings = records.filter((r) => {
    if (known.has(r.name) || !r.startTime) return false;
    const s = Date.parse(r.startTime);
    return s >= confStartMs - 30 * 60 * 1000 && s <= sittingEndMs + RESUME_SIBLING_SLOP_MS;
  });

  const found = [...(watch.found ?? [])];
  const byName = new Map(found.map((f) => [f.recordName, f]));
  for (const s of siblings) {
    const f = byName.get(s.name);
    if (f) {
      f.startTime = s.startTime;
      f.endTime = s.endTime;
    } else {
      const fresh = { recordName: s.name, startTime: s.startTime, endTime: s.endTime };
      found.push(fresh);
      byName.set(s.name, fresh);
    }
  }

  // Adopt at most ONE ended sibling per visit — recordingPending is a
  // single-record machine, so a second adoption waits until it resolves.
  const candidate = siblings.find((s) => s.endTime && !byName.get(s.name)?.adoptedAt);
  if (!candidate) {
    await heartbeat({ found });
    return;
  }
  if (watch.knownRecords.length > MAX_RESUME_SIBLINGS) {
    console.warn(`[resume-sweep] ${row.assemblyai_id}: sibling cap hit — closing the watch`);
    await mergeGmeetContextForUser(
      row.user_id,
      row.assemblyai_id,
      { resumeWatch: { ...watch, found, status: 'done', resolvedAt: nowIso } },
      { quiet: true }
    );
    return;
  }
  if (ctx.recordingPending?.status === 'waiting') {
    await heartbeat({ found }); // busy attaching another record — next visit
    return;
  }

  const arts = await listRecordArtifacts(minted.token, candidate.name);
  if (arts.checkFailed) {
    await heartbeat({ found });
    return;
  }
  const entry = byName.get(candidate.name)!;
  if (arts.recordings.length === 0) {
    if (now - Date.parse(candidate.endTime!) < RESUME_EMPTY_GRACE_MS) {
      await heartbeat({ found }); // may not be indexed yet — give it a beat
      return;
    }
    // Ended, nothing recorded — account for it silently.
    entry.adoptedAt = nowIso;
    entry.empty = true;
    await heartbeat({ found, knownRecords: [...watch.knownRecords, candidate.name] });
    return;
  }

  // Adopt: re-arm recordingPending on the sibling — the ordinary poller path
  // above lists its artifacts, appends its videos as videoParts (the row has
  // a primary already) and pulls the bytes.
  entry.adoptedAt = nowIso;
  console.log(
    `[resume-sweep] ${row.assemblyai_id}: meeting resumed — adopting ${candidate.name} ` +
      `(started ${candidate.startTime}, ${arts.recordings.length} recording(s) listed)`
  );
  await mergeGmeetContextForUser(row.user_id, row.assemblyai_id, {
    resumeWatch: {
      ...watch,
      knownRecords: [...watch.knownRecords, candidate.name],
      found,
      lastCheckedAt: nowIso,
      attempts: (watch.attempts ?? 0) + 1,
    },
    recordingPending: { recordName: candidate.name, since: nowIso, status: 'waiting' },
    // Keep the sibling's transcript Docs on the snapshot — re-transcribe and
    // evidence flows read from here.
    ...(ctx.actuals && arts.transcriptDocIds.length > 0
      ? {
          actuals: {
            ...ctx.actuals,
            transcriptDocIds: [
              ...new Set([...(ctx.actuals.transcriptDocIds ?? []), ...arts.transcriptDocIds]),
            ],
          },
        }
      : {}),
  });

  const link = await openLink(row.assemblyai_id, 'Open the meeting');
  const resumedAt = whenLine(candidate.startTime);
  for (const to of await resumeRecipients(row)) {
    void notifyUser({
      kind: 'resume',
      toEmail: to,
      text: dm(
        `🔁 *This meeting resumed after a break — grabbing the extra recording*`,
        meetingLine({
          title: row.title ?? ctx.eventTitle,
          when: row.recorded_at ?? ctx.startTime,
          duration: row.duration,
          speakerCount: row.speaker_count,
        }),
        `The call restarted${resumedAt ? ` at ${resumedAt}` : ''} as a fresh Meet session — Google keeps a separate recording for it, and it will attach here as an extra video on its own.`,
        `For one combined transcript afterwards, use “Combine all videos & re-transcribe” → ${link}`
      ),
      dedupeKey: `mw-resume:${row.assemblyai_id}:${candidate.name}:${to}`,
    });
  }
}

async function sweepResumeWatches(): Promise<void> {
  const rows = await listResumeWatchRows(MAX_RESUME_PER_TICK);
  for (const row of rows) {
    try {
      await checkResumeRow(row);
    } catch (err) {
      console.warn(`[resume-sweep] check failed for ${row.assemblyai_id}:`, err);
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
    await sweepResumeWatches();
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
