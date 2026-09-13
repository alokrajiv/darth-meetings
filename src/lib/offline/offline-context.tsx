'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  OFFLINE_CHANGE_EVENT,
  type OfflineMode,
  type OfflineState,
  type PinRecord,
  type StorageEstimate,
  type SwStatus,
  type SyncState,
} from './offline-types';
import { clearAllOffline, ensureOfflineOwner, estimateStorage, listPins, offlineSupported, requestPersistentStorage } from './offline-pins';
import {
  getOfflineMode,
  getSyncState,
  probeSession,
  runOfflineSync,
  setOfflineMode,
  startOfflineScheduler,
  type ProbeOutcome,
} from './offline-sync';

export { getOfflineMode } from './offline-sync';

/**
 * <OfflineProvider> — the one React entry point for offline support.
 * Registers the service worker, watches connectivity, owns the
 * online/offline MODE (a user decision, never automatic) and mirrors the
 * pin ledger + sync progress into React state for the header chip, the
 * banner, the settings card and the offline archive.
 *
 * Connectivity is navigator.onLine AND a real probe (GET /api/auth/session)
 * — onLine alone is true on a captive portal or a flaky tunnel. The probe
 * doubles as the session check, in two ways:
 *   - the 200 body carries the darth userId; the ledger + caches are bound
 *     to it (ensureOfflineOwner), so a different person signing in on the
 *     same browser wipes the previous user's meetings before anything
 *     renders them;
 *   - a 401 while reachable means the session is gone, and the cached
 *     meetings go with it (no signed-out laptop keeps a colleague's
 *     transcripts). Because one darth-auth hiccup must not destroy GBs of
 *     pinned media, the wipe needs two 401s at least a probe period apart
 *     (the route answers 503 for a transient failure, but this is the belt).
 *
 * Verdicts are debounced too: a single failed probe (a deploy's 502
 * window, one slow fetch) only schedules a confirmation re-probe 3 s
 * later; the "offline" verdict lands on the second consecutive failure.
 */

const PROBE_PERIOD_MS = 60_000;
/** Second 401 must be at least this long after the first (≈ one period, with jitter room). */
const UNAUTH_CONFIRM_MS = PROBE_PERIOD_MS * 0.9;
/** Re-probe delay after a first failed verdict. */
const OFFLINE_CONFIRM_MS = 3_000;
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

  // Refs so the probe loop reads the latest values without re-arming.
  const modeRef = useRef<OfflineMode>('online');
  const onlineRef = useRef(true);
  const promptArmedRef = useRef(true); // re-arms on every online→offline flip
  const promptDismissedAtRef = useRef(0);
  const offlineStrikesRef = useRef(0); // consecutive failed verdicts
  const confirmTimerRef = useRef<number | null>(null);
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

  const probeRef = useRef<() => Promise<ProbeOutcome>>(async () => ({ result: 'online', userId: null }));

  /** Apply a probe verdict to state; handles the prompt rules + 401 wipe. */
  const applyProbe = useCallback(
    async (outcome: ProbeOutcome) => {
      const { result } = outcome;

      if (result === 'unauthenticated') {
        setProbed(true);
        // Session gone while reachable. Two consecutive 401s ≥ one probe
        // period apart before the wipe — never on a single answer.
        offlineStrikesRef.current = 0;
        const now = Date.now();
        const reachable = typeof navigator === 'undefined' || navigator.onLine !== false;
        if (!reachable) {
          /* can't trust a verdict while the browser says it has no network */
        } else if (unauthSinceRef.current === null) {
          unauthSinceRef.current = now;
        } else if (now - unauthSinceRef.current >= UNAUTH_CONFIRM_MS) {
          unauthSinceRef.current = null;
          if (supported.current) {
            await clearAllOffline().catch(() => undefined);
            applyMode('online');
          }
        }
        onlineRef.current = true;
        setOnline(true);
        return;
      }

      if (result === 'online') {
        setProbed(true);
        unauthSinceRef.current = null;
        offlineStrikesRef.current = 0;
        if (confirmTimerRef.current !== null) {
          window.clearTimeout(confirmTimerRef.current);
          confirmTimerRef.current = null;
        }
        // Owner binding: another user's session on this browser wipes the
        // previous user's ledger + caches before anything reads them.
        if (outcome.userId && supported.current) {
          const wiped = await ensureOfflineOwner(outcome.userId).catch(() => false);
          if (wiped) applyMode('online');
        }
        onlineRef.current = true;
        setOnline(true);
        promptArmedRef.current = true;
        setPromptVisible(false);
        return;
      }

      // 'offline': first strike while we believed we were online → confirm
      // with a re-probe shortly; the verdict flips on the second strike.
      offlineStrikesRef.current += 1;
      if (onlineRef.current && offlineStrikesRef.current < 2) {
        if (confirmTimerRef.current === null) {
          confirmTimerRef.current = window.setTimeout(() => {
            confirmTimerRef.current = null;
            if (!unmountedRef.current) void probeRef.current();
          }, OFFLINE_CONFIRM_MS);
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
    [applyMode]
  );

  const probe = useCallback(async () => {
    const outcome = await probeSession();
    if (unmountedRef.current) return outcome;
    await applyProbe(outcome);
    return outcome;
  }, [applyProbe]);
  probeRef.current = probe;

  // Mount: SW registration, mode restore, ledger + storage, scheduler.
  useEffect(() => {
    unmountedRef.current = false;
    supported.current = offlineSupported();
    modeRef.current = getOfflineMode();
    setMode(modeRef.current);
    setReady(true);

    if (!supported.current) {
      setSw('unsupported');
    } else {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .then(() => navigator.serviceWorker.ready)
        .then(() => setSw('ready'))
        .catch((err) => {
          console.warn('[offline] service worker registration failed', err);
          setSw('error');
        });
      void requestPersistentStorage();
    }

    void refreshPins();
    void refreshStorage();
    setSyncState(getSyncState());
    void probe();

    const stopScheduler = supported.current ? startOfflineScheduler() : () => undefined;

    const onOnline = () => void probe();
    // The browser's 'offline' event is a hint, not a verdict — re-probe.
    const onOffline = () => void probe();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void probe();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void probe();
    }, PROBE_PERIOD_MS);

    return () => {
      unmountedRef.current = true;
      stopScheduler();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
      if (confirmTimerRef.current !== null) {
        window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
    };
  }, [probe, refreshPins, refreshStorage]);

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
    const r = await probe();
    if (r.result === 'offline') return false;
    applyMode('online');
    void runOfflineSync('exit-offline');
    return true;
  }, [applyMode, probe]);

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
