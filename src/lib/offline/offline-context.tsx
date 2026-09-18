'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  OFFLINE_CHANGE_EVENT,
  OFFLINE_DEEPLINK_PARAM,
  type OfflineMode,
  type OfflineState,
  type PinRecord,
  type StorageEstimate,
  type SwStatus,
  type SyncState,
} from './offline-types';
import { clearAllOffline, ensureOfflineOwner, estimateStorage, listPins, offlineSupported, requestPersistentStorage } from './offline-pins';
import {
  announceOfflineMode,
  getOfflineMode,
  getSyncState,
  probeHealth,
  probeSession,
  runOfflineSync,
  setOfflineMode,
  startOfflineScheduler,
  type ProbeOutcome,
} from './offline-sync';

export { getOfflineMode } from './offline-sync';

export { OFFLINE_TITLE } from './offline-types';
import { OFFLINE_TITLE } from './offline-types';

/**
 * <OfflineProvider> — the one React entry point for offline support.
 * Registers the service worker, watches connectivity, owns the
 * online/offline MODE (a user decision, never automatic) and mirrors the
 * pin ledger + sync progress into React state for the header chip, the
 * banner, the settings card and the offline archive.
 *
 * Two probes, two jobs:
 *
 *   - CONNECTIVITY = the health probe (GET /api/health, HEALTH_TIMEOUT_MS
 *     cap, every HEALTH_PERIOD_MS while visible, plus on focus and on the
 *     browser's online/offline events). navigator.onLine is only a hint:
 *     on a laptop whose VPN tunnel stays up with Wi-Fi off the OS keeps
 *     saying online and requests hang instead of failing, so a timed probe
 *     is the only signal there is. A single miss only schedules a
 *     confirmation re-probe HEALTH_CONFIRM_MS later; the "offline" verdict
 *     (and the "You appear to be offline" prompt) lands on the second miss
 *     — a few seconds after the network went, never a minute.
 *
 *   - IDENTITY = the session probe (GET /api/auth/session, every
 *     SESSION_PERIOD_MS while online). Its 200 body carries the darth
 *     userId; the ledger + caches are bound to it (ensureOfflineOwner), so a
 *     different person signing in on the same browser wipes the previous
 *     user's meetings before anything renders them. A 401 while reachable
 *     means the session is gone, and the cached meetings go with it (no
 *     signed-out laptop keeps a colleague's transcripts). Because one
 *     darth-auth hiccup must not destroy GBs of pinned media, the wipe
 *     needs two 401s at least UNAUTH_CONFIRM_MS apart (the route answers
 *     503 for a transient failure, but this is the belt). Its verdict on
 *     connectivity is ignored — the health probe owns that.
 *
 * The mode is also handed to the service worker (announceOfflineMode): in
 * offline mode the worker serves cached copies instantly and never waits
 * on the network; in online mode it caps every network-first fetch that
 * has a cached fallback.
 */

const HEALTH_PERIOD_MS = 15_000;
/** Re-probe delay after a first failed health verdict. */
const HEALTH_CONFIRM_MS = 1_000;
const SESSION_PERIOD_MS = 60_000;
/** Second 401 must be at least this long after the first (≈ one period, with jitter room). */
const UNAUTH_CONFIRM_MS = SESSION_PERIOD_MS * 0.9;
/** "Not now" silences the offline prompt for this long. */
const PROMPT_DISMISS_COOLDOWN_MS = 10 * 60_000;

const OfflineContext = createContext<OfflineState | null>(null);

const IDLE_SYNC: SyncState = { running: false, done: 0, total: 0, current: null, lastSync: null, error: null };

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [probed, setProbed] = useState(false);
  const [mode, setMode] = useState<OfflineMode>('online');
  const [sw, setSw] = useState<SwStatus>('registering');
  const [promptVisible, setPromptVisible] = useState(false);
  const [pins, setPins] = useState<PinRecord[]>([]);
  const [syncState, setSyncState] = useState<SyncState>(IDLE_SYNC);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);

  // Refs so the probe loops read the latest values without re-arming.
  const modeRef = useRef<OfflineMode>('online');
  const onlineRef = useRef(true);
  const promptArmedRef = useRef(true); // re-arms on every online→offline flip
  const promptDismissedAtRef = useRef(0);
  const offlineStrikesRef = useRef(0); // consecutive failed health verdicts
  const confirmTimerRef = useRef<number | null>(null);
  const healthInflightRef = useRef<Promise<'online' | 'offline'> | null>(null);
  const unauthSinceRef = useRef<number | null>(null); // first 401 of a streak
  const supported = useRef(false);
  const unmountedRef = useRef(false);

  const applyMode = useCallback((m: OfflineMode) => {
    modeRef.current = m;
    setMode(m);
    setOfflineMode(m);
  }, []);

  const refreshPins = useCallback(async () => {
    if (!supported.current) return;
    try {
      setPins(await listPins());
    } catch {
      setPins([]);
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    if (!supported.current) return;
    try {
      setStorage(await estimateStorage());
    } catch {
      setStorage(null);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Identity (session probe)
  // -------------------------------------------------------------------------

  const applySession = useCallback(
    async (outcome: ProbeOutcome) => {
      if (outcome.result === 'unauthenticated') {
        // Session gone while reachable. Two consecutive 401s ≥ one period
        // apart before the wipe — never on a single answer, and never while
        // the health probe says the app is unreachable (a 401 cannot come
        // from a dead network, but the belt costs nothing).
        const now = Date.now();
        if (!onlineRef.current) return;
        if (unauthSinceRef.current === null) {
          unauthSinceRef.current = now;
        } else if (now - unauthSinceRef.current >= UNAUTH_CONFIRM_MS) {
          unauthSinceRef.current = null;
          if (supported.current) {
            await clearAllOffline().catch(() => undefined);
            applyMode('online');
          }
        }
        return;
      }
      if (outcome.result === 'online') {
        unauthSinceRef.current = null;
        // Owner binding: another user's session on this browser wipes the
        // previous user's ledger + caches before anything reads them.
        if (outcome.userId && supported.current) {
          const wiped = await ensureOfflineOwner(outcome.userId).catch(() => false);
          if (wiped) applyMode('online');
        }
      }
      // 'offline' from this probe says nothing the health probe doesn't.
    },
    [applyMode]
  );

  const checkSession = useCallback(async () => {
    const outcome = await probeSession();
    if (unmountedRef.current) return outcome;
    await applySession(outcome);
    return outcome;
  }, [applySession]);

  // -------------------------------------------------------------------------
  // Connectivity (health probe)
  // -------------------------------------------------------------------------

  const healthRef = useRef<(reason: string) => Promise<'online' | 'offline'>>(async () => 'online');

  const applyHealth = useCallback(
    (result: 'online' | 'offline') => {
      if (result === 'online') {
        setProbed(true);
        offlineStrikesRef.current = 0;
        if (confirmTimerRef.current !== null) {
          window.clearTimeout(confirmTimerRef.current);
          confirmTimerRef.current = null;
        }
        const was = onlineRef.current;
        onlineRef.current = true;
        setOnline(true);
        promptArmedRef.current = true;
        setPromptVisible(false);
        // Back after an outage: re-check who we are (and whether the
        // session survived) right away rather than at the next period, and
        // run a sync pass — it replays the offline activity outbox first
        // (in every mode) and refreshes pins in online mode. The browser's
        // 'online' event never fires on a stalled VPN tunnel, so this probe
        // flip is the reconnect trigger that always exists.
        if (!was) {
          void checkSession();
          void runOfflineSync('reconnect');
        }
        return;
      }

      // 'offline': first strike while we believed we were online → confirm
      // with a re-probe shortly; the verdict flips on the second strike.
      offlineStrikesRef.current += 1;
      if (onlineRef.current && offlineStrikesRef.current < 2) {
        if (confirmTimerRef.current === null) {
          confirmTimerRef.current = window.setTimeout(() => {
            confirmTimerRef.current = null;
            if (!unmountedRef.current) void healthRef.current('confirm');
          }, HEALTH_CONFIRM_MS);
        }
        return;
      }
      // A confirmed verdict (second strike, or we already knew we were off).
      setProbed(true);
      const was = onlineRef.current;
      onlineRef.current = false;
      setOnline(false);
      if (was && modeRef.current === 'online' && promptArmedRef.current) {
        promptArmedRef.current = false;
        if (Date.now() - promptDismissedAtRef.current >= PROMPT_DISMISS_COOLDOWN_MS) {
          setPromptVisible(true);
        }
      }
    },
    [checkSession]
  );

  /** Single-flight: a burst of triggers (focus + online event + timer) costs one probe. */
  const health = useCallback(async (reason: string) => {
    if (healthInflightRef.current) return healthInflightRef.current;
    const started = Date.now();
    const p = probeHealth().then((result) => {
      healthInflightRef.current = null;
      // Kept at debug level on purpose: the one trace that explains a
      // "why did it think I was offline" report after the fact.
      console.debug(`[offline] health probe (${reason}) → ${result} in ${Date.now() - started} ms`);
      if (!unmountedRef.current) applyHealth(result);
      return result;
    });
    healthInflightRef.current = p;
    return p;
  }, [applyHealth]);
  healthRef.current = health;

  // Mount: SW registration, mode restore (+ hand it to the worker), ledger
  // + storage, scheduler, probe loops.
  useEffect(() => {
    unmountedRef.current = false;
    supported.current = offlineSupported();
    modeRef.current = getOfflineMode();
    // Manifest shortcut "Offline archive" (/?offline=1): the user asked for
    // the on-device archive, which is the one time entering offline mode
    // is not a banner decision. The param is stripped so a reload or a
    // "Back online" click does not re-enter it.
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get(OFFLINE_DEEPLINK_PARAM) === '1') {
        modeRef.current = 'offline';
        setOfflineMode('offline');
        sp.delete(OFFLINE_DEEPLINK_PARAM);
        const qs = sp.toString();
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
      }
    } catch {
      /* no URL API — ignore */
    }
    setMode(modeRef.current);
    setReady(true);

    if (!supported.current) {
      setSw('unsupported');
    } else {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .then(() => navigator.serviceWorker.ready)
        .then(() => {
          setSw('ready');
          // A freshly installed/updated worker reads the flag from the cache
          // on its own; the message just makes the flip immediate.
          void announceOfflineMode(modeRef.current);
        })
        .catch((err) => {
          console.warn('[offline] service worker registration failed', err);
          setSw('error');
        });
      void requestPersistentStorage();
    }

    void refreshPins();
    void refreshStorage();
    setSyncState(getSyncState());
    void health('mount');
    void checkSession();

    const stopScheduler = supported.current ? startOfflineScheduler() : () => undefined;

    const onOnline = () => void health('online-event');
    // The browser's 'offline' event is a hint, not a verdict — re-probe.
    const onOffline = () => void health('offline-event');
    const onVisible = () => {
      if (document.visibilityState === 'visible') void health('visible');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const healthTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void health('timer');
    }, HEALTH_PERIOD_MS);
    const sessionTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && onlineRef.current) void checkSession();
    }, SESSION_PERIOD_MS);

    return () => {
      unmountedRef.current = true;
      stopScheduler();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(healthTimer);
      window.clearInterval(sessionTimer);
      if (confirmTimerRef.current !== null) {
        window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
    };
  }, [health, checkSession, refreshPins, refreshStorage]);

  // Ledger / sync progress events → React state (storage estimate debounced).
  useEffect(() => {
    let storageTimer: number | null = null;
    const onChange = (ev: Event) => {
      const kind = (ev as CustomEvent<{ kind?: string }>).detail?.kind;
      setSyncState(getSyncState());
      if (kind !== 'progress' && kind !== 'sync') void refreshPins();
      if (kind === 'clear') {
        modeRef.current = 'online';
        setMode('online');
      }
      if (storageTimer !== null) window.clearTimeout(storageTimer);
      storageTimer = window.setTimeout(() => void refreshStorage(), 1_500);
    };
    window.addEventListener(OFFLINE_CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener(OFFLINE_CHANGE_EVENT, onChange);
      if (storageTimer !== null) window.clearTimeout(storageTimer);
    };
  }, [refreshPins, refreshStorage]);

  const enterOffline = useCallback(() => {
    applyMode('offline');
    setPromptVisible(false);
  }, [applyMode]);

  const exitOffline = useCallback(async () => {
    const r = await health('exit-offline');
    if (r === 'offline') return false;
    applyMode('online');
    void checkSession();
    void runOfflineSync('exit-offline');
    return true;
  }, [applyMode, health, checkSession]);

  const dismissPrompt = useCallback(() => {
    promptDismissedAtRef.current = Date.now();
    setPromptVisible(false);
  }, []);

  const syncNow = useCallback(async () => {
    if (!supported.current) return;
    await runOfflineSync('manual');
    await refreshPins();
    await refreshStorage();
  }, [refreshPins, refreshStorage]);

  const value = useMemo<OfflineState>(
    () => ({
      ready,
      online,
      mode,
      sw,
      promptVisible,
      enterOffline,
      exitOffline,
      dismissPrompt,
      // `probed` keeps the "Connection is back" bar from flashing on every
      // load in offline mode until the first probe has actually answered.
      backOnlineVisible: mode === 'offline' && online && probed,
      pins,
      syncing: syncState.running,
      syncState,
      syncNow,
      storage,
      refreshPins,
    }),
    [ready, online, probed, mode, sw, promptVisible, enterOffline, exitOffline, dismissPrompt, pins, syncState, syncNow, storage, refreshPins]
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

const FALLBACK: OfflineState = {
  ready: true,
  online: true,
  mode: 'online',
  sw: 'unsupported',
  promptVisible: false,
  enterOffline: () => undefined,
  exitOffline: async () => true,
  dismissPrompt: () => undefined,
  backOnlineVisible: false,
  pins: [],
  syncing: false,
  syncState: IDLE_SYNC,
  syncNow: async () => undefined,
  storage: null,
  refreshPins: async () => undefined,
};

/**
 * Offline state for components. Outside an <OfflineProvider> (tests,
 * stray pages) it returns an inert online state instead of throwing, so
 * the chip/banner simply render nothing.
 */
export function useOffline(): OfflineState {
  return useContext(OfflineContext) ?? FALLBACK;
}

export interface OfflineGate {
  /** Network-needing controls must be inert: offline MODE, or the probe says the network is down. */
  blocked: boolean;
  /** The user chose offline mode (pinned archive view). */
  offline: boolean;
  /** Probe verdict. */
  online: boolean;
  /** `OFFLINE_TITLE` while blocked, else undefined — spread straight into `title`. */
  title: string | undefined;
}

/**
 * The shared predicate for "may this control hit the network?". Use
 * `blocked` everywhere (never `mode` alone): a dropped connection that the
 * user has not yet turned into offline mode must not let a button spin
 * forever or throw a generic error.
 */
export function useOfflineGate(): OfflineGate {
  const { mode, online } = useOffline();
  const offline = mode === 'offline';
  const blocked = offline || !online;
  return { blocked, offline, online, title: blocked ? OFFLINE_TITLE : undefined };
}
