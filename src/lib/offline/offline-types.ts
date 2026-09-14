/**
 * Offline-support contracts shared by the service worker helpers, the sync
 * engine, the React provider and the UI. Pure types + constants — no DOM,
 * no React, so every module (and the bun tests) can import it.
 *
 * The server side of these contracts lives in /api/offline/plan and
 * /api/offline/prefs; the shapes here mirror those responses byte-for-byte.
 */

/** Per-account auto-pin counts (mirror of db-ops/user-prefs OfflinePrefs —
 * that module is server-only, hence the client copy). */
export interface OfflinePrefs {
  transcripts: number;
  audio: number;
  video: number;
}

export interface PlanMediaPart {
  /** 1 = the primary recording (local_audio_path); 2.. = gmeet_context.videoParts[N-2]. */
  part: number;
  filename: string;
  isVideo: boolean;
  bytes: number | null;
}

export interface PlanMedia {
  hasLocal: boolean;
  /** Primary recording has a video stream. */
  isVideo: boolean;
  parts: PlanMediaPart[];
}

/** One row of GET /api/offline/plan. `id` is the assemblyai_id. */
export interface PlanMeeting {
  id: string;
  title: string | null;
  recordedAt: string | null;
  createdAt: string;
  durationSec: number | null;
  provider: 'gmeet' | 'teams' | null;
  /** Content fingerprint — changes whenever the meeting page would render differently. */
  rev: string;
  media: PlanMedia;
}

export interface OfflinePlan {
  prefs: OfflinePrefs;
  buildId: string;
  meetings: PlanMeeting[];
}

/** The pin ladder: every level includes everything below it. */
export type PinLevel = 'none' | 'transcript' | 'audio' | 'video';

export type PinStatus = 'pending' | 'ready' | 'error';

export interface PinBytes {
  transcript: number;
  audio: number;
  video: number;
}

/** IndexedDB 'pins' store row. */
export interface PinRecord {
  id: string;
  level: PinLevel;
  /** true = the user decided; the auto policy never changes a manual record. */
  manual: boolean;
  title: string | null;
  recordedAt: string | null;
  durationSec: number | null;
  rev: string;
  status: PinStatus;
  error?: string;
  bytes: PinBytes;
  pinnedAt: string;
  updatedAt: string;
}

/** IndexedDB 'meta' store row (buildId, lastSync, persistRequested, ...). */
export interface MetaRecord {
  key: string;
  value: unknown;
}

export type OfflineMode = 'online' | 'offline';

export type SwStatus = 'unsupported' | 'registering' | 'ready' | 'error';

export interface SyncState {
  running: boolean;
  done: number;
  total: number;
  /** Title (or id) of the meeting being processed right now. */
  current: string | null;
  /** ISO of the last completed sync on this device, if any. */
  lastSync: string | null;
  /** Message of the last failed sync, cleared on the next success. */
  error: string | null;
}

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
  /** Sum of the per-pin byte counts, by tier. */
  pinned: PinBytes;
}

/** What useOffline() returns. */
export interface OfflineState {
  /** false until the provider's mount effect restored `mode` from this
   * device — pages render a neutral skeleton meanwhile so the online
   * listing never mounts (and fires its requests) for one commit in
   * offline mode. */
  ready: boolean;
  /** Connectivity as far as we can tell (navigator.onLine + a session probe). */
  online: boolean;
  mode: OfflineMode;
  sw: SwStatus;
  /** "You appear to be offline" prompt (mode still 'online', connectivity lost). */
  promptVisible: boolean;
  enterOffline: () => void;
  /** false when the probe still fails — stay in offline mode. */
  exitOffline: () => Promise<boolean>;
  dismissPrompt: () => void;
  /** "Connection is back" bar (mode 'offline', connectivity detected). */
  backOnlineVisible: boolean;
  pins: PinRecord[];
  syncing: boolean;
  syncState: SyncState;
  syncNow: () => Promise<void>;
  storage: StorageEstimate | null;
  refreshPins: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants shared with public/sw.js (the worker is plain JS and cannot
// import this file — keep the two lists in step by hand).
// ---------------------------------------------------------------------------

export const CACHE_PAGES = 'darth-offline-pages-v1';
export const CACHE_API = 'darth-offline-api-v1';
export const CACHE_MEDIA = 'darth-offline-media-v1';
export const CACHE_STATIC = 'darth-static-v1';
/** One-entry cache holding the worker-visible mode flag (see SW_MODE_KEY). */
export const CACHE_META = 'darth-meta-v1';
export const ALL_CACHES = [CACHE_PAGES, CACHE_API, CACHE_MEDIA, CACHE_STATIC, CACHE_META] as const;

/**
 * The worker reads the mode from this CACHE_META entry (body 'offline' |
 * 'online') on every cold start — a PWA launched with the network dead
 * must know it is in offline mode before it answers the first request.
 * The page writes it AND posts SET_MODE so a running worker flips at once.
 */
export const SW_MODE_KEY = '/__darth/mode';
/** A cached page's flight payload lives in CACHE_API under `<pathname>?__rsc=1`. */
export const RSC_CACHE_SUFFIX = '?__rsc=1';

export const IDB_NAME = 'darth-offline';
export const IDB_VERSION = 1;

export const OFFLINE_MODE_KEY = 'darth-offline-mode';
/** Window event fired after every pin/sync mutation. */
export const OFFLINE_CHANGE_EVENT = 'darth-offline-change';

/** Meta keys. */
export const META_BUILD_ID = 'buildId';
export const META_LAST_SYNC = 'lastSync';
export const META_PERSIST_REQUESTED = 'persistRequested';
/** userId the ledger + caches belong to; a different session wipes them. */
export const META_OWNER_USER_ID = 'ownerUserId';

/** Rough size the pin dialog quotes for a transcript-level pin. */
export const TRANSCRIPT_ESTIMATE_BYTES = 1024 * 1024;
/** Audio-only derivative: mono AAC 64 kbps ≈ 8 KB per second. */
export const AUDIO_BYTES_PER_SEC = 8 * 1024;

/** The one tooltip every control that needs the network shows while blocked. */
export const OFFLINE_TITLE = 'Not available offline';
