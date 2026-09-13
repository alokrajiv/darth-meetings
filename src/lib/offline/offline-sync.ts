import {
  META_BUILD_ID,
  META_LAST_SYNC,
  OFFLINE_MODE_KEY,
  type OfflineMode,
  type OfflinePlan,
  type PinLevel,
  type PinRecord,
  type PlanMeeting,
  type SyncState,
} from './offline-types';
import { metaGet, metaSet } from './offline-db';
import {
  cacheDocument,
  emitOfflineChange,
  ensureOfflineOwner,
  listPins,
  offlineSupported,
  pinMeeting,
  pruneStaticCache,
  refreshPinContent,
  refreshPinDocument,
  unpinIfAuto,
  unpinMeeting,
} from './offline-pins';
import { levelRank, maxLevel } from './offline-urls';

/**
 * The auto-pin policy. One pass = read the account's plan
 * (GET /api/offline/plan), decide the desired level of every meeting the
 * counts cover, and reconcile the device's ledger with it:
 *
 *   - non-manual records: pin / upgrade / downgrade / evict to match;
 *   - manual records: never re-levelled, but kept fresh (rev) and dropped
 *     when the meeting is no longer visible to the caller (?ids= probe);
 *   - a new server build re-fetches every cached document + its chunks so
 *     the offline page never pairs old HTML with missing chunk hashes.
 *
 * Single-flight: a second caller while a pass runs gets the same promise.
 * Never runs in offline mode (the whole point is that the network is
 * unreliable then) or when the browser lacks the storage APIs.
 */

// ---------------------------------------------------------------------------
// Mode (localStorage) — plain functions so non-React code can read it.
// ---------------------------------------------------------------------------

export function getOfflineMode(): OfflineMode {
  if (typeof window === 'undefined') return 'online';
  try {
    return window.localStorage.getItem(OFFLINE_MODE_KEY) === 'offline' ? 'offline' : 'online';
  } catch {
    return 'online';
  }
}

export function setOfflineMode(mode: OfflineMode): void {
  if (typeof window === 'undefined') return;
  try {
    if (mode === 'offline') window.localStorage.setItem(OFFLINE_MODE_KEY, 'offline');
    else window.localStorage.removeItem(OFFLINE_MODE_KEY);
  } catch {
    /* private mode */
  }
}

// ---------------------------------------------------------------------------
// Session probe — connectivity AND identity in one round-trip. Shared by the
// provider (banner rules, owner binding) and the sync pass (owner binding
// before anything else, so a stale 'offline' mode can never keep another
// user's data alive).
// ---------------------------------------------------------------------------

export const PROBE_URL = '/api/auth/session';
export const PROBE_TIMEOUT_MS = 5_000;

export type ProbeResult = 'online' | 'offline' | 'unauthenticated';

export interface ProbeOutcome {
  result: ProbeResult;
  /** darth userId from the 200 body; null unless result === 'online'. */
  userId: string | null;
}

export async function probeSession(): Promise<ProbeOutcome> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { result: 'offline', userId: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(PROBE_URL, { cache: 'no-store', credentials: 'include', signal: ctrl.signal });
    if (res.status === 401) return { result: 'unauthenticated', userId: null };
    if (res.status >= 500) {
      // Our worker answers 503 { offline: true } when the network is gone;
      // the route itself answers 503 { transient: true } when darth-auth is
      // down; an upstream 5xx is equally "can't reach the app".
      return { result: 'offline', userId: null };
    }
    let userId: string | null = null;
    try {
      const body = (await res.json()) as { userId?: unknown };
      if (typeof body?.userId === 'string' && body.userId) userId = body.userId;
    } catch {
      /* not JSON — still reachable */
    }
    return { result: 'online', userId };
  } catch {
    return { result: 'offline', userId: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe + owner binding in one step: when the session belongs to someone
 * other than the ledger's owner, the previous user's data is wiped and the
 * mode reset before anything else reads it. Returns the probe outcome plus
 * whether a wipe happened.
 */
export async function probeAndBindOwner(): Promise<ProbeOutcome & { wiped: boolean }> {
  const outcome = await probeSession();
  let wiped = false;
  if (outcome.result === 'online' && outcome.userId && offlineSupported()) {
    wiped = await ensureOfflineOwner(outcome.userId);
    if (wiped) setOfflineMode('online');
  }
  return { ...outcome, wiped };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const PLAN_URL = '/api/offline/plan';
const PLAN_IDS_CHUNK = 200;

export async function fetchOfflinePlan(ids?: string[]): Promise<OfflinePlan> {
  const url = ids && ids.length > 0 ? `${PLAN_URL}?ids=${encodeURIComponent(ids.join(','))}` : PLAN_URL;
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
  if (!res.ok) {
    let msg = `plan → ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; offline?: boolean };
      if (body.offline) msg = 'offline';
      else if (body.error) msg = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const plan = (await res.json()) as OfflinePlan;
  if (!plan || !Array.isArray(plan.meetings)) throw new Error('plan → malformed response');
  return plan;
}

/**
 * Desired auto levels: the newest prefs.transcripts at 'transcript'; of
 * those with a stored recording the first prefs.audio at 'audio'; of those
 * whose recording has video the first prefs.video at 'video'. Max wins.
 * Exported for tests / the settings card preview.
 */
export function desiredAutoLevels(plan: OfflinePlan): Map<string, { level: PinLevel; meta: PlanMeeting }> {
  const out = new Map<string, { level: PinLevel; meta: PlanMeeting }>();
  const set = (m: PlanMeeting, level: PinLevel) => {
    const cur = out.get(m.id);
    out.set(m.id, { level: cur ? maxLevel(cur.level, level) : level, meta: m });
  };
  const { prefs, meetings } = plan;
  for (const m of meetings.slice(0, Math.max(0, prefs.transcripts))) set(m, 'transcript');
  const withMedia = meetings.filter((m) => m.media?.hasLocal);
  for (const m of withMedia.slice(0, Math.max(0, prefs.audio))) set(m, 'audio');
  const withVideo = withMedia.filter((m) => m.media.isVideo || m.media.parts.some((p) => p.isVideo));
  for (const m of withVideo.slice(0, Math.max(0, prefs.video))) set(m, 'video');
  return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: SyncState = { running: false, done: 0, total: 0, current: null, lastSync: null, error: null };
let inflight: Promise<void> | null = null;
let lastSyncLoaded = false;

export function getSyncState(): SyncState {
  return { ...state };
}

function publish(): void {
  emitOfflineChange('sync', { state: getSyncState() });
}

async function loadLastSync(): Promise<void> {
  if (lastSyncLoaded) return;
  lastSyncLoaded = true;
  try {
    state.lastSync = (await metaGet<string>(META_LAST_SYNC)) ?? null;
  } catch {
    state.lastSync = null;
  }
}

/** Runs `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function label(m: { title: string | null; id: string }): string {
  return m.title?.trim() || m.id;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** Shell documents kept so the listing and settings open in offline mode. */
export const SHELL_PAGES = ['/', '/settings', '/offline'] as const;

export function runOfflineSync(reason: string): Promise<void> {
  if (inflight) return inflight;
  inflight = syncOnce(reason).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function syncOnce(reason: string): Promise<void> {
  if (!offlineSupported()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  // Owner binding comes BEFORE the offline-mode early return: a browser
  // left in offline mode by user A must not serve A's archive to user B
  // just because the sync never got past this line.
  const probe = await probeAndBindOwner();
  if (probe.result !== 'online') return;
  if (getOfflineMode() === 'offline') return;
  await loadLastSync();

  state.running = true;
  state.done = 0;
  state.total = 0;
  state.current = null;
  publish();

  try {
    const plan = await fetchOfflinePlan();
    const desired = desiredAutoLevels(plan);
    const records = await listPins();
    const byId = new Map(records.map((r) => [r.id, r]));

    // Work list --------------------------------------------------------------
    type Job = { id: string; title: string; run: () => Promise<void> };
    const jobs: Job[] = [];

    // 1. Auto records: reconcile with the desired set.
    for (const [id, { level, meta }] of desired) {
      const rec = byId.get(id);
      if (rec?.manual) continue; // user decided; only the rev refresh below applies
      if (!rec) {
        jobs.push({ id, title: label(meta), run: () => pinMeeting(id, level, { manual: false, meta }).then(() => undefined) });
      } else if (rec.level !== level) {
        jobs.push({ id, title: label(meta), run: () => pinMeeting(id, level, { manual: false, meta }).then(() => undefined) });
      } else if (rec.rev !== meta.rev) {
        jobs.push({ id, title: label(meta), run: () => refreshPinContent(id, meta).then(() => undefined) });
      } else if (rec.status !== 'ready') {
        jobs.push({ id, title: label(meta), run: () => pinMeeting(id, level, { manual: false, meta }).then(() => undefined) });
      }
    }
    for (const rec of records) {
      if (rec.manual || desired.has(rec.id)) continue;
      // unpinIfAuto re-checks `manual` when the job actually runs — the user
      // may have pinned it by hand while earlier jobs were downloading.
      jobs.push({ id: rec.id, title: label(rec), run: () => unpinIfAuto(rec.id) });
    }

    // 2. Manual records: still visible? still current?
    const manual = records.filter((r) => r.manual);
    if (manual.length > 0) {
      const seen = new Map<string, PlanMeeting>();
      for (let i = 0; i < manual.length; i += PLAN_IDS_CHUNK) {
        const chunk = manual.slice(i, i + PLAN_IDS_CHUNK).map((r) => r.id);
        const sub = await fetchOfflinePlan(chunk);
        for (const m of sub.meetings) seen.set(m.id, m);
      }
      for (const rec of manual) {
        const row = seen.get(rec.id);
        if (!row) {
          jobs.push({ id: rec.id, title: label(rec), run: () => unpinMeeting(rec.id) });
        } else if (rec.level !== 'none' && (rec.rev !== row.rev || rec.status !== 'ready')) {
          const level = rec.level;
          jobs.push({
            id: rec.id,
            title: label(row),
            run: () =>
              rec.status === 'ready'
                ? refreshPinContent(rec.id, row).then(() => undefined)
                : pinMeeting(rec.id, level, { manual: true, meta: row }).then(() => undefined),
          });
        }
      }
    }

    // 3. Build change: every cached document + its chunks again.
    const storedBuild = await metaGet<string>(META_BUILD_ID).catch(() => undefined);
    const buildChanged = storedBuild !== plan.buildId;
    const refreshedThisPass = new Set(jobs.map((j) => j.id));
    if (buildChanged) {
      for (const rec of records) {
        if (rec.level === 'none' || refreshedThisPass.has(rec.id)) continue;
        if (!desired.has(rec.id) && !rec.manual) continue; // being evicted anyway
        jobs.push({ id: rec.id, title: label(rec), run: () => refreshPinDocument(rec.id) });
      }
    }

    state.total = jobs.length;
    publish();

    // Media-heavy jobs queue on their own limiter inside pinMeeting; four
    // pin jobs at a time keeps the transcript-tier limiter busy.
    await pool(jobs, 4, async (job) => {
      state.current = job.title;
      publish();
      try {
        await job.run();
      } catch (err) {
        console.warn('[offline-sync] job failed', job.id, err);
      }
      state.done += 1;
      publish();
    });

    // 4. Shell pages (cheap; assets are cache-first) — after the meetings so
    // a slow connection puts the content first.
    if (buildChanged || reason === 'mount' || reason === 'manual') {
      await Promise.allSettled(SHELL_PAGES.map((p) => cacheDocument(p)));
    }

    if (buildChanged) {
      // Every document now references the new build's chunks; drop the old
      // build's leftovers so the static cache doesn't grow per deploy.
      const pruned = await pruneStaticCache();
      if (pruned.dropped > 0) console.info(`[offline-sync] pruned ${pruned.dropped} stale static chunks`);
      await metaSet(META_BUILD_ID, plan.buildId).catch(() => undefined);
    }
    state.lastSync = new Date().toISOString();
    state.error = null;
    await metaSet(META_LAST_SYNC, state.lastSync).catch(() => undefined);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    console.warn(`[offline-sync] ${reason}:`, state.error);
  } finally {
    state.running = false;
    state.current = null;
    publish();
    emitOfflineChange('storage');
  }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const MOUNT_DELAY_MS = 10_000;
const PERIOD_MS = 30 * 60_000;

/**
 * Arms the schedule: 10 s after mount (page work first), on window
 * 'online', and every 30 min. Returns a stop function for the provider's
 * effect cleanup. Idempotent per call site; the sync itself is single-flight.
 */
export function startOfflineScheduler(): () => void {
  if (typeof window === 'undefined' || !offlineSupported()) return () => undefined;
  const mountTimer = window.setTimeout(() => {
    if (navigator.onLine !== false) void runOfflineSync('mount');
  }, MOUNT_DELAY_MS);
  const interval = window.setInterval(() => {
    if (navigator.onLine !== false && document.visibilityState !== 'hidden') void runOfflineSync('interval');
  }, PERIOD_MS);
  const onOnline = () => {
    // Give the browser a moment — 'online' fires before DNS is really back.
    window.setTimeout(() => void runOfflineSync('online'), 3_000);
  };
  window.addEventListener('online', onOnline);
  return () => {
    window.clearTimeout(mountTimer);
    window.clearInterval(interval);
    window.removeEventListener('online', onOnline);
  };
}

/** Records the auto policy would keep, for a preview (settings card). */
export function previewAutoSet(plan: OfflinePlan, records: PinRecord[]): Array<{ meeting: PlanMeeting; level: PinLevel; manual: boolean }> {
  const desired = desiredAutoLevels(plan);
  const byId = new Map(records.map((r) => [r.id, r]));
  const out: Array<{ meeting: PlanMeeting; level: PinLevel; manual: boolean }> = [];
  for (const [id, { level, meta }] of desired) {
    const rec = byId.get(id);
    if (rec?.manual) out.push({ meeting: meta, level: rec.level, manual: true });
    else out.push({ meeting: meta, level, manual: false });
  }
  return out.sort((a, b) => levelRank(b.level) - levelRank(a.level));
}
