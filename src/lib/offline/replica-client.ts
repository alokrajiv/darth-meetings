/**
 * The Meetings desktop replica, as the pages use it (browser only). Inside
 * the Darth desktop shell with a store bridge this opens the per-app SQLite
 * once per page load, keyed by the signed-in person; on the web every call
 * resolves to "nothing stored" and nothing is ever written.
 *
 * Owner: the darth user id from GET /api/auth/session (5 s cap). Offline that
 * call fails, so the store opens UNKEYED for reading only; the next call made
 * while online re-opens it keyed (another person's rows are wiped then — the
 * shell itself wipes every store on Sign out).
 *
 * Background sync (`syncReplicaSoon`, called after the listing loads while
 * online): the newest LISTING_KEEP listing rows → the store; their page URLs
 * → `offlineCache.warm`; the offline plan's `rev` for those meetings →
 * fetch the meetings whose stored copy is missing or stale, at most two at a
 * time, through the same read routes the page uses (the detail route with
 * `?replica=1` so a sync is not logged as a view). Never while the shell
 * says offline; at most once per SYNC_MIN_INTERVAL_MS unless forced; every
 * step stops at the first network failure (no retry loops).
 */

import { useSyncExternalStore } from 'react';
import type {
  LabelRef,
  SpeakerLabel,
  StoredTranscript,
  TranscriptAccess,
  TranscriptEditMap,
  TranscriptListRow,
  TranscriptListV2Response,
  TranscriptResponse,
} from '@/lib/format';
import { desktopStoreBridge, openReplicaDb, type DesktopStoreBridge, type ReplicaDb } from './replica-db';
import {
  LISTING_KEEP,
  compactMeeting,
  metaSet,
  readDoc,
  readListing,
  readListRow,
  saveDoc,
  saveListing,
  searchReplica,
  setDocRev,
  storedRevs,
  type LocalSearchResult,
  type MeetingSources,
  type StoredListing,
  type StoredReplicaDoc,
} from './replica';
import { isShellOffline, meetingPageUrl, warmPages } from './shell-offline';

const SESSION_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 20_000;
/** The plan probes media it has not seen yet (server side): give it longer. */
const PLAN_TIMEOUT_MS = 60_000;
export const SYNC_MIN_INTERVAL_MS = 15 * 60_000;
export const SYNC_CONCURRENCY = 2;
const LISTING_PAGE_DAYS = 60;
const LISTING_MAX_PAGES = 4;

let bridgeOverride: DesktopStoreBridge | null | undefined;
let fetchOverride: typeof fetch | undefined;

/** Test seams: a fake bridge and a fake fetch (undefined = the real ones). */
export function setReplicaEnvForTests(env: { bridge?: DesktopStoreBridge | null; fetch?: typeof fetch }): void {
  bridgeOverride = env.bridge;
  fetchOverride = env.fetch;
  opened = null;
  syncing = null;
  lastSyncAt = 0;
}

function bridge(): DesktopStoreBridge | null {
  return bridgeOverride !== undefined ? bridgeOverride : desktopStoreBridge();
}

function doFetch(input: string, init?: RequestInit): Promise<Response> {
  const f = fetchOverride ?? fetch;
  return f(input, init);
}

/** True inside a shell that has a store bridge (the replica can exist). */
export function replicaAvailable(): boolean {
  return bridge() !== null;
}

const noSubscribe = () => () => {};
/** `replicaAvailable()` for render: false at SSR and during hydration (the
 * server cannot know), the real answer on the client right after — and at
 * once on a client-side navigation, so no live screen flashes first. */
export function useReplicaAvailable(): boolean {
  return useSyncExternalStore(noSubscribe, replicaAvailable, () => false);
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(url, { credentials: 'include', signal: ctrl?.signal });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sessionUserId(): Promise<string | null> {
  if (isShellOffline()) return null;
  try {
    const b = await fetchJson<{ userId?: unknown }>('/api/auth/session', SESSION_TIMEOUT_MS);
    return typeof b.userId === 'string' && b.userId ? b.userId : null;
  } catch {
    return null;
  }
}

let opened: Promise<ReplicaDb | null> | null = null;

/** The replica handle (null on the web / when the store is off). Keyed when
 * the session could be read; re-keyed on the first call made online after an
 * unkeyed (offline) open. */
export async function replicaDb(): Promise<ReplicaDb | null> {
  const b = bridge();
  if (!b) return null;
  if (opened) {
    const db = await opened;
    if (!db || db.owner !== null || isShellOffline()) return db;
    // Opened offline (unkeyed): try to key it now — fall through.
  }
  const p = (async () => openReplicaDb(b, await sessionUserId()))();
  opened = p;
  const db = await p;
  if (!db) opened = null; // ask again next time
  return db;
}

// ---- Reads ----------------------------------------------------------------

export async function loadStoredListing(): Promise<StoredListing | null> {
  const db = await replicaDb();
  return db ? readListing(db) : null;
}

export async function loadStoredMeeting(
  id: string
): Promise<{ doc: StoredReplicaDoc | null; row: TranscriptListRow | null } | null> {
  const db = await replicaDb();
  if (!db) return null;
  const [doc, row] = await Promise.all([readDoc(db, id), readListRow(db, id)]);
  return { doc, row };
}

export async function searchStored(q: string): Promise<LocalSearchResult | null> {
  const db = await replicaDb();
  return db ? searchReplica(db, q) : null;
}

// ---- Write-through from the meeting page -----------------------------------

/** The meeting page loaded (or changed) this meeting online: keep its text
 * (the page debounces). The rev comes from the offline plan (one small
 * request) so the background sync does not fetch it again. Never throws. */
export async function rememberOpenedMeeting(src: MeetingSources): Promise<void> {
  try {
    if (src.row.status !== 'completed' || !src.content || isShellOffline()) return;
    const id = src.row.assemblyai_id;
    const now = Date.now();
    const db = await replicaDb();
    if (!db || db.owner === null) return;
    const outcome = await saveDoc(db, compactMeeting(src), null, { now });
    if (outcome !== 'ok' || isShellOffline()) return;
    const plan = await fetchJson<{ meetings?: { id: string; rev: string }[] }>(
      `/api/offline/plan?ids=${encodeURIComponent(id)}`
    ).catch(() => null);
    const rev = plan?.meetings?.find((m) => m.id === id)?.rev;
    if (rev) await setDocRev(db, id, rev);
  } catch {
    /* the replica is a cache: a failure never reaches the page */
  }
}

// ---- Background sync --------------------------------------------------------

let syncing: Promise<SyncReport> | null = null;
let lastSyncAt = 0;

export interface SyncReport {
  ran: boolean;
  listed: number;
  warmed: number;
  fetched: number;
  failed: number;
  stoppedBy?: string;
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The newest LISTING_KEEP rows of the default listing (all tabs, no filter). */
async function fetchNewestRows(): Promise<TranscriptListRow[]> {
  const rows: TranscriptListRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < LISTING_MAX_PAGES && rows.length < LISTING_KEEP; page++) {
    const params = new URLSearchParams({
      v: '2',
      tab: 'all',
      tz: tz(),
      days: String(LISTING_PAGE_DAYS),
      minRows: String(LISTING_KEEP - rows.length),
    });
    if (cursor) params.set('cursor', cursor);
    const data = await fetchJson<TranscriptListV2Response>(`/api/transcripts?${params.toString()}`);
    for (const d of data.days ?? []) rows.push(...d.rows);
    if (!data.hasMore || !data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return rows.slice(0, LISTING_KEEP);
}

type DetailRow = StoredTranscript & {
  access?: TranscriptAccess;
  owner_email?: string | null;
  owner_name?: string | null;
};

/** One meeting through the page's own read routes → compact doc sources. */
async function fetchMeetingSources(id: string, listRow: TranscriptListRow | undefined): Promise<MeetingSources> {
  const base = `/api/transcripts/${encodeURIComponent(id)}`;
  const [detail, speakers, edits, content] = await Promise.all([
    fetchJson<{ transcript: DetailRow }>(`${base}?replica=1`),
    fetchJson<{ speakerLabels?: SpeakerLabel[] }>(`${base}/speakers`).catch((e) => {
      if (e instanceof HttpError) return { speakerLabels: [] };
      throw e;
    }),
    fetchJson<{ edits?: TranscriptEditMap }>(`${base}/edits`).catch((e) => {
      if (e instanceof HttpError) return { edits: {} };
      throw e;
    }),
    fetchJson<{ content?: TranscriptResponse }>(`${base}/content`),
  ]);
  const labels: LabelRef[] | null = listRow?.labels ?? null;
  return {
    row: detail.transcript,
    speakerLabels: speakers.speakerLabels ?? [],
    edits: edits.edits ?? {},
    content: content.content ?? null,
    labels,
  };
}

async function runSync(force: boolean): Promise<SyncReport> {
  const report: SyncReport = { ran: true, listed: 0, warmed: 0, fetched: 0, failed: 0 };
  const db = await replicaDb();
  if (!db || db.owner === null) return { ...report, ran: false, stoppedBy: 'no-store' };
  // A reload must not start over: the last sync's time is kept in the store.
  if (!force) {
    const at = Number((await db.query<{ v: string }>('SELECT v FROM meta WHERE k = ?', ['synced_at']))?.[0]?.v);
    if (Number.isFinite(at) && Date.now() - at < SYNC_MIN_INTERVAL_MS) {
      return { ...report, ran: false, stoppedBy: 'recent' };
    }
  }

  // 1. The listing.
  let rows: TranscriptListRow[];
  try {
    rows = await fetchNewestRows();
  } catch {
    return { ...report, stoppedBy: 'listing' };
  }
  if (await saveListing(db, rows)) report.listed = rows.length;

  // 2. Their pages (and the listing's own, which the shell prewarms anyway),
  // kept by the shell's page cache.
  const completed = rows.filter((r) => r.status === 'completed' && !r.deleted_at);
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    report.warmed = await warmPages([
      `${origin}/`,
      ...completed.slice(0, LISTING_KEEP).map((r) => meetingPageUrl(origin, r.assemblyai_id)),
    ]);
  }

  // 3. Which meetings need their text (missing or stale).
  if (completed.length === 0 || isShellOffline()) return report;
  let plan: { meetings?: { id: string; rev: string }[] };
  try {
    plan = await fetchJson(
      `/api/offline/plan?ids=${completed.map((r) => encodeURIComponent(r.assemblyai_id)).join(',')}`,
      PLAN_TIMEOUT_MS
    );
  } catch {
    return { ...report, stoppedBy: 'plan' };
  }
  const held = await storedRevs(db);
  const byId = new Map(completed.map((r) => [r.assemblyai_id, r]));
  const todo = (plan.meetings ?? []).filter((m) => byId.has(m.id) && held.get(m.id) !== m.rev);

  // 4. Fetch them, newest first, two at a time; stop on the first network failure.
  let stop: string | undefined;
  let next = 0;
  const worker = async () => {
    while (!stop && next < todo.length) {
      if (isShellOffline()) {
        stop = 'offline';
        return;
      }
      const m = todo[next++]!;
      try {
        const src = await fetchMeetingSources(m.id, byId.get(m.id));
        const outcome = await saveDoc(db, compactMeeting(src), m.rev);
        if (outcome === 'ok') report.fetched++;
        else report.failed++;
      } catch (e) {
        report.failed++;
        // An HTTP error is about that meeting; anything else is the network.
        if (!(e instanceof HttpError)) stop = 'network';
      }
    }
  };
  await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, worker));
  if (stop) report.stoppedBy = stop;
  await db.tx([metaSet('synced_at', String(Date.now()))]);
  return report;
}

/**
 * Start a background sync unless one ran recently, one is running, the shell
 * says offline, or there is no store. Resolves its report (never throws).
 */
export function syncReplicaSoon(opts: { force?: boolean } = {}): Promise<SyncReport> {
  const skip: SyncReport = { ran: false, listed: 0, warmed: 0, fetched: 0, failed: 0 };
  if (!bridge()) return Promise.resolve({ ...skip, stoppedBy: 'no-store' });
  if (isShellOffline()) return Promise.resolve({ ...skip, stoppedBy: 'offline' });
  if (syncing) return syncing;
  if (!opts.force && Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS) {
    return Promise.resolve({ ...skip, stoppedBy: 'recent' });
  }
  lastSyncAt = Date.now();
  syncing = runSync(!!opts.force)
    .catch(() => ({ ...skip, ran: true, stoppedBy: 'error' }))
    .finally(() => {
      syncing = null;
    });
  return syncing;
}
